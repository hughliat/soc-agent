/**
 * 判定与关联 —— 确定性计算，不依赖模型。
 *
 * 设计要点（docs/03 §4.3）：
 *   1. classify：把失败消息归类到 10 个可解释的原因桶
 *   2. aggregate：按主机 / 原因 / 任务聚合
 *   3. correlate：跨源时间线 + 首批规则（变更后异常 / 同因多发 / 监控盲区）
 *   4. 输出一律 `{verdict, event_ids[], reason}` —— 模型只能引用 event_ids
 *
 * 零副作用：纯函数，不碰 io。
 */

'use strict';

/**
 * 失败归类规则。顺序即优先级 ——
 * 例如「Could not find the requested service」含 could not find，
 * 但语义是服务失败，所以 service 必须排在 missing-file 之前。
 */
const FAIL_PATTERNS = [
  { key: 'unreachable', label: '主机不可达 / 连接失败', re: /unreachable|connection (?:refused|timed out|failure)|no route to host|host key verification|permission denied \(publickey\)/i },
  { key: 'auth', label: '认证 / 权限不足', re: /permission denied|access denied|sudo:.*password|not in the sudoers|authentication failed/i },
  { key: 'service', label: '服务操作失败', re: /could not find the requested service|job for .* failed|failed to start|systemctl.*failed|unit .* not found/i },
  { key: 'undefined-var', label: '变量未定义', re: /is undefined|undefined variable|has no attribute/i },
  { key: 'missing-file', label: '文件 / 路径不存在', re: /no such file or directory|cannot find (?:the )?file|path does not exist/i },
  { key: 'timeout', label: '超时', re: /timed? ?out|timeout|timeout \(\d+\)/i },
  { key: 'package', label: '包管理失败', re: /no package .* available|unable to find a match|dpkg|apt-get.*failed|yum.*failed/i },
  { key: 'disk', label: '磁盘空间不足', re: /no space left on device|disk quota exceeded/i },
  { key: 'ssh', label: 'SSH 参数 / 密钥问题', re: /host key|known_hosts|private key|bad permissions/i },
  { key: 'syntax', label: '语法 / 模板错误', re: /template error|syntax error|yaml|jinja2|unexpected/i },
];

const UNCLASSIFIED = { key: 'other', label: '其他错误' };
const NO_MSG = { key: 'unknown', label: '未归类（无错误信息）' };

/**
 * 归类一条失败消息。
 * @param {string} msg
 * @returns {{key: string, label: string}}
 */
function classify(msg) {
  if (!msg || !String(msg).trim()) return { ...NO_MSG };
  const s = String(msg);
  for (const p of FAIL_PATTERNS) {
    if (p.re.test(s)) return { key: p.key, label: p.label };
  }
  return { ...UNCLASSIFIED };
}

/** 判定一条事件是否属于「问题」 */
function isProblem(ev) {
  return ev.result === 'failed' || ev.result === 'unreachable' || ev.severity === 'high' || ev.severity === 'critical';
}

/**
 * 聚合统计。
 * @param {object[]} events
 */
function aggregate(events) {
  const list = Array.isArray(events) ? events : [];
  const statusCount = {};
  const sevCount = {};
  const byHost = new Map();
  const byReason = new Map();
  const byTask = new Map();

  for (const ev of list) {
    statusCount[ev.result] = (statusCount[ev.result] || 0) + 1;
    sevCount[ev.severity] = (sevCount[ev.severity] || 0) + 1;

    if (!byHost.has(ev.where)) byHost.set(ev.where, { host: ev.where, total: 0, problems: 0, reasons: new Map() });
    const h = byHost.get(ev.where);
    h.total++;

    if (isProblem(ev)) {
      h.problems++;
      const r = classify(ev.msg);
      h.reasons.set(r.key, (h.reasons.get(r.key) || 0) + 1);

      if (!byReason.has(r.key)) byReason.set(r.key, { key: r.key, label: r.label, count: 0, hosts: new Set(), tasks: new Set(), samples: [] });
      const rb = byReason.get(r.key);
      rb.count++;
      rb.hosts.add(ev.where);
      if (ev.what && ev.what.startsWith('task:')) {
        const task = ev.what.slice(5);
        rb.tasks.add(task);
        if (!byTask.has(task)) byTask.set(task, { task, hostCount: new Set(), count: 0 });
        const tb = byTask.get(task);
        tb.hostCount.add(ev.where);
        tb.count++;
      }
      if (rb.samples.length < 3) rb.samples.push({ event_id: ev.id, host: ev.where, task: ev.what, msg: ev.msg.slice(0, 200) });
    }
  }

  const problems = list.filter(isProblem);

  return {
    totalEvents: list.length,
    problemCount: problems.length,
    hostCount: byHost.size,
    statusCount,
    sevCount,
    hosts: [...byHost.values()]
      .map((h) => ({ host: h.host, total: h.total, problems: h.problems, reasons: [...h.reasons.entries()].map(([k, v]) => ({ key: k, count: v })) }))
      .sort((a, b) => b.problems - a.problems || a.host.localeCompare(b.host)),
    reasons: [...byReason.values()]
      .map((r) => ({ key: r.key, label: r.label, count: r.count, hosts: [...r.hosts], tasks: [...r.tasks], samples: r.samples }))
      .sort((a, b) => b.count - a.count),
    topTasks: [...byTask.values()]
      .map((t) => ({ task: t.task, hostCount: t.hostCount.size, count: t.count }))
      .sort((a, b) => b.hostCount - a.hostCount || b.count - a.count)
      .slice(0, 10),
  };
}

/**
 * 跨源时间线 + 首批规则。
 *
 * 规则：
 *   R1 变更后异常 —— 同一主机 Ansible changed 之后 N 分钟内出现高危/失败事件
 *   R2 同因多发   —— 同一原因影响 ≥3 台主机
 *   R3 监控盲区   —— 某主机在某个源上完全没有数据（需传入期望源列表）
 *
 * @param {object[]} events
 * @param {{windowMs?: number, expectedSources?: string[]}} opts
 * @returns {{timeline: object[], verdicts: object[]}}
 */
function correlate(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const windowMs = opts.windowMs || 10 * 60 * 1000; // 默认 10 分钟
  const expectedSources = opts.expectedSources || [];

  const sorted = [...list].sort((a, b) => a.when - b.when);
  const verdicts = [];

  // ── R1 变更后异常 ──
  const changesByHost = new Map();
  for (const ev of sorted) {
    if (ev.result === 'changed' || (ev.source === 'ansible' && ev.result === 'ok' && /change/i.test(ev.what))) {
      if (!changesByHost.has(ev.where)) changesByHost.set(ev.where, []);
      changesByHost.get(ev.where).push(ev);
    }
  }
  for (const ev of sorted) {
    if (!isProblem(ev)) continue;
    const changes = changesByHost.get(ev.where) || [];
    const hit = changes.find((c) => ev.when >= c.when && ev.when - c.when <= windowMs && c.id !== ev.id);
    if (hit) {
      verdicts.push({
        rule: 'R1',
        title: '变更后异常',
        reason: `${ev.where} 在变更（${hit.what}）后 ${Math.round((ev.when - hit.when) / 60000)} 分钟出现${ev.result === 'unreachable' ? '不可达' : '异常'}`,
        event_ids: [hit.id, ev.id],
        host: ev.where,
      });
    }
  }

  // ── R2 同因多发 ──
  const agg = aggregate(list);
  for (const r of agg.reasons) {
    if (r.hosts.length >= 3) {
      verdicts.push({
        rule: 'R2',
        title: '同因多发',
        reason: `「${r.label}」影响 ${r.hosts.length} 台主机，属系统性问题而非单机故障`,
        event_ids: r.samples.map((s) => s.event_id),
        hosts: r.hosts,
      });
    }
  }

  // ── R3 监控盲区 ──
  if (expectedSources.length) {
    const hosts = [...new Set(list.map((e) => e.where))];
    for (const host of hosts) {
      const seen = new Set(list.filter((e) => e.where === host).map((e) => e.source));
      const missing = expectedSources.filter((s) => !seen.has(s));
      if (missing.length === expectedSources.length) {
        // 全都没数据 → 该主机整体不可见
        verdicts.push({
          rule: 'R3',
          title: '监控盲区',
          reason: `${host} 在全部 ${expectedSources.length} 个数据源上都没有记录，需确认采集是否覆盖`,
          event_ids: [],
          host,
          missing,
        });
      } else if (missing.length) {
        verdicts.push({
          rule: 'R3',
          title: '数据源缺失',
          reason: `${host} 缺少 ${missing.join('/')} 的数据，该维度判断可能不完整`,
          event_ids: [],
          host,
          missing,
        });
      }
    }
  }

  return {
    timeline: sorted.map((e) => ({ id: e.id, at: e.when, host: e.where, source: e.source, result: e.result, what: e.what })),
    verdicts,
  };
}

/**
 * 一句话总评（确定性生成，不依赖模型）。
 * @param {object} agg aggregate() 的输出
 */
function summarize(agg) {
  if (!agg || agg.totalEvents === 0) return '本次窗口内没有任何事件。';
  if (agg.problemCount === 0) {
    return `${agg.hostCount} 台主机共 ${agg.totalEvents} 条事件，未见失败或高危。`;
  }
  const top = agg.reasons[0];
  const head = `${agg.hostCount} 台主机共 ${agg.totalEvents} 条事件，其中 ${agg.problemCount} 条为问题`;
  if (!top) return `${head}。`;
  return `${head}；最集中的原因是「${top.label}」（${top.count} 条，影响 ${top.hosts.length} 台）。`;
}

module.exports = { classify, isProblem, aggregate, correlate, summarize, FAIL_PATTERNS, UNCLASSIFIED, NO_MSG };

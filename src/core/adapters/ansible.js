/**
 * Ansible 日志适配器 —— 多格式自动识别，输出统一 SecurityEvent。
 *
 * 支持（均已在 dsh-ansible-logs 原型中实测）：
 *   1. ansible.log（log_path 默认格式，带时间戳/pid/user 前缀）
 *   2. AWX / Tower 作业输出（纯 ansible stdout）
 *   3. JSONL（自定义 callback 插件）
 *   4. ansible-playbook -vvv（含 SSH 连接调试噪声）
 *
 * 契约：sniff(lines) -> 置信度 0~1；parse(lines, {path}) -> SecurityEvent[]
 * 零副作用：不读文件（内容由调用方传入），不写任何东西。
 */

'use strict';

const { makeEvent } = require('../model');

const TS_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[,.]\d+)?)/;

function parseTs(s) {
  if (!s) return null;
  const norm = s.replace(',', '.').replace(' ', 'T');
  const d = new Date(norm);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** 从 `fatal: [host]: FAILED! => {...}` 尾部抽 msg */
function extractMsg(tail) {
  if (!tail) return '';
  const jsonStart = tail.indexOf('{');
  if (jsonStart >= 0) {
    const raw = tail.slice(jsonStart);
    try {
      const o = JSON.parse(raw);
      return o.msg || o.stderr || o.stdout || JSON.stringify(o).slice(0, 300);
    } catch {
      const m = raw.match(/"msg"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ');
      return raw.slice(0, 200);
    }
  }
  return tail.trim().slice(0, 200);
}

/** 把 (status, host, task, play) 转成一条安全事件 */
function toEvent(ctx) {
  const { source, status, host, task, play, at, msg, path, line } = ctx;
  // 只把有安全意义的结果转成事件：失败/不可达/变更/告警。
  // ok 与 skipping 不单独成事件（否则噪声淹没真问题），但保留在统计里。
  const RESULT_MAP = {
    failed: 'failed',
    fatal: 'failed',
    unreachable: 'unreachable',
    changed: 'changed',
    alert: 'alert',
    ok: 'ok',
    skipping: 'skip',
  };
  let result = RESULT_MAP[status] || 'info';
  // Ansible 的不可达仍报 `fatal:`, 真实状态藏在消息体 `UNREACHABLE! =>`
  if (result === 'failed' && /UNREACHABLE!|unreachable["']?:\s*true/i.test(String(msg) + String(ctx.rawMsg || ''))) {
    result = 'unreachable';
  }
  const severity =
    result === 'unreachable' ? 'high'
    : result === 'failed' ? 'medium'
    : result === 'alert' ? 'high'
    : 'info';

  return makeEvent({
    source,
    who: 'ansible',
    when: at || Date.now(),
    where: host,
    what: task ? `task:${task}` : play ? `play:${play}` : 'ansible',
    result,
    severity,
    msg,
    src: { kind: 'file', path, line },
    raw: { play, task, status },
  });
}

// ─────────────────────────── 1. ansible.log ───────────────────────────
const ansibleLog = {
  id: 'ansible-log',
  label: 'ansible.log（log_path 默认格式）',
  sniff(lines) {
    let hit = 0;
    for (const l of lines.slice(0, 200)) {
      if (/^\d{4}-\d{2}-\d{2}[ T][\d:,.]+\s+p=\d+\s+u=\S+\s+n=\S+\s+\|/.test(l)) hit++;
    }
    return hit >= 3 ? 0.9 : 0;
  },
  parse(lines, opts = {}) {
    const path = opts.path || '<inline>';
    const events = [];
    let curTask = null;
    let curPlay = null;
    lines.forEach((line, i) => {
      const m = line.match(/^(\d{4}-\d{2}-\d{2}[ T][\d:,.]+\S*)\s+p=\d+\s+u=\S+\s+n=\S+\s+\|\s?(.*)$/);
      if (!m) return;
      const at = parseTs(m[1]);
      const body = m[2];
      const pm = body.match(/^PLAY\s+\[(.*?)\]/);
      if (pm) { curPlay = pm[1]; return; }
      const tm = body.match(/^TASK\s+\[(.*?)\]/);
      if (tm) { curTask = tm[1]; return; }
      const hm = body.match(/^(ok|changed|skipping|failed|fatal|unreachable):\s+\[([^\]]+)\](.*)$/);
      if (hm) {
        // `fatal: [h]: UNREACHABLE! =>` —— 状态报 fatal，真实语义是不可达
        const st = /UNREACHABLE/i.test(hm[3]) ? 'unreachable' : hm[1];
        const isBad = st === 'failed' || st === 'fatal' || st === 'unreachable';
        events.push(toEvent({
          source: 'ansible', status: st, host: hm[2], task: curTask, play: curPlay,
          at, msg: isBad ? extractMsg(hm[3]) : '', path, line: i + 1,
        }));
        return;
      }
      // PLAY RECAP 汇总行：按主机产出一条 info 事件（含计数），便于审计对齐
      const rm = body.match(/^([\w.-]+)\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)\s+skipped=(\d+)/);
      if (rm) {
        // RECAP 是统计行：真实失败已由 task 级事件记录，这里只留计数痕迹，
        // 固定 info 级 —— 否则同一失败会被计两次、污染失败列表
        events.push(makeEvent({
          source: 'ansible', who: 'ansible', when: at || Date.now(), where: rm[1],
          what: 'recap', result: 'info', severity: 'info',
          msg: `RECAP ok=${rm[2]} changed=${rm[3]} unreachable=${rm[4]} failed=${rm[5]} skipped=${rm[6]}`,
          src: { kind: 'file', path, line: i + 1 },
          raw: { play: curPlay, recap: true },
        }));
      }
    });
    return events;
  },
};

// ─────────────────────────── 2. AWX / Tower ───────────────────────────
const awx = {
  id: 'awx',
  label: 'AWX / Tower 作业输出',
  sniff(lines) {
    let hit = 0;
    for (const l of lines.slice(0, 300)) {
      if (/^(PLAY|TASK)\s+\[.*?\]\s*\**\s*$/.test(l.trim())) hit++;
    }
    return hit >= 2 ? 0.85 : 0;
  },
  parse(lines, opts = {}) {
    const path = opts.path || '<inline>';
    const events = [];
    let curTask = null;
    let curPlay = null;
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      const pm = t.match(/^PLAY\s+\[(.*?)\]/);
      if (pm) { curPlay = pm[1]; return; }
      const tm = t.match(/^TASK\s+\[(.*?)\]/);
      if (tm) { curTask = tm[1]; return; }
      const hm = t.match(/^(ok|changed|skipping|failed|fatal|unreachable):\s+\[([^\]]+)\](.*)$/);
      if (hm) {
        const st = /UNREACHABLE/i.test(hm[3]) ? 'unreachable' : hm[1];
        const isBad = st === 'failed' || st === 'fatal' || st === 'unreachable';
        events.push(toEvent({
          source: 'ansible', status: st, host: hm[2], task: curTask, play: curPlay,
          at: null, msg: isBad ? extractMsg(hm[3]) : '', path, line: i + 1,
        }));
        return;
      }
      const rm = t.match(/^([\w.-]+)\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)\s+skipped=(\d+)/);
      if (rm) {
        events.push(makeEvent({
          source: 'ansible', who: 'ansible', when: Date.now(), where: rm[1],
          what: 'recap', result: 'info', severity: 'info',
          msg: `RECAP ok=${rm[2]} changed=${rm[3]} unreachable=${rm[4]} failed=${rm[5]} skipped=${rm[6]}`,
          src: { kind: 'file', path, line: i + 1 },
          raw: { play: curPlay, recap: true },
        }));
      }
    });
    return events;
  },
};

// ─────────────────────────── 3. JSONL callback ───────────────────────────
const jsonl = {
  id: 'jsonl',
  label: 'JSON Lines（自定义 callback）',
  sniff(lines) {
    let hit = 0;
    for (const l of lines.slice(0, 100)) {
      const t = l.trim();
      if (!t.startsWith('{')) continue;
      try { JSON.parse(t); hit++; } catch { /* 非 JSON */ }
    }
    return hit >= 3 ? 0.95 : 0;
  },
  parse(lines, opts = {}) {
    const path = opts.path || '<inline>';
    const events = [];
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t.startsWith('{')) return;
      let o;
      try { o = JSON.parse(t); } catch { return; }
      const taskName = o.task?.name || o.task_name || (typeof o.task === 'string' ? o.task : null);
      const playName = o.play?.name || o.play_name || null;
      const hosts = o.hosts || (o.host ? { [o.host]: o.result || o } : null);
      if (!hosts) return;
      for (const [host, r] of Object.entries(hosts)) {
        const res = r || {};
        const status = res.failed ? 'failed'
          : res.unreachable ? 'unreachable'
          : res.skipped ? 'skipping'
          : res.changed ? 'changed'
          : 'ok';
        events.push(toEvent({
          source: 'ansible', status, host, task: taskName, play: playName,
          at: o.timestamp ? parseTs(o.timestamp) : null, msg: res.msg || '',
          path, line: i + 1,
        }));
      }
    });
    return events;
  },
};

// ─────────────────────────── 4. -vvv ───────────────────────────
const vvv = {
  id: 'vvv',
  label: 'ansible-playbook -vvv',
  sniff(lines) {
    let hit = 0;
    for (const l of lines.slice(0, 200)) {
      const t = l.trim();
      if (/^<[^>]+>\s+(ESTABLISH|EXEC|SSH:)/.test(t)) hit++;
      if (/^using connection plugin/i.test(t)) hit++;
    }
    return hit >= 3 ? 0.8 : 0;
  },
  parse(lines, opts = {}) {
    // 去掉 <host> 开头的连接调试行，其余复用 AWX 主体
    const filtered = [];
    const lineMap = [];
    lines.forEach((l, i) => {
      if (!/^\s*<[^>]+>\s+/.test(l)) { filtered.push(l); lineMap.push(i + 1); }
    });
    const evs = awx.parse(filtered, opts);
    // 还原原始行号
    return evs.map((e) => ({ ...e, src: { ...e.src, line: lineMap[e.src.line - 1] || e.src.line } }));
  },
};

const PARSERS = [jsonl, ansibleLog, awx, vvv];

/**
 * 自动识别格式。全都不认领时用 awx 兜底并标 fallback（置信度低）。
 * @returns {{parser: object, score: number, fallback: boolean}}
 */
function detect(text) {
  const lines = String(text).split(/\r?\n/);
  let best = null;
  for (const p of PARSERS) {
    let s = 0;
    try { s = p.sniff(lines) || 0; } catch { s = 0; }
    if (!best || s > best.score) best = { parser: p, score: s };
  }
  if (!best || best.score < 0.5) return { parser: awx, score: 0, fallback: true };
  return { parser: best.parser, score: best.score, fallback: false };
}

/** 一步到位：文本 → 事件数组 */
function parseText(text, opts = {}) {
  const det = detect(text);
  const events = det.parser.parse(String(text).split(/\r?\n/), opts);
  return { events, format: det.parser.id, label: det.parser.label, score: det.score, fallback: det.fallback };
}

module.exports = { PARSERS, detect, parseText, id: 'ansible', label: 'Ansible' };

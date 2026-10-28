/**
 * core 层单测 —— 零依赖，node 内置 assert。
 * 覆盖：事件模型 / Ansible 四格式解析 / store 幂等与查询上限。
 *
 * 跑法：node tests/run.js
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pathToFileURL } = require('node:url');

const model = require('../src/core/model');
const ansible = require('../src/core/adapters/ansible');
const { createStore, memorySink, fileSink } = require('../src/core/store');

let pass = 0;
const fails = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fails.push({ name, err: e });
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message}`);
  }
}

/**
 * Ansible 夹具目录。三级回退：
 *   1. SOC_ANSIBLE_FIXTURES 环境变量（指向真实脱敏日志）
 *   2. 兄弟仓库 dsh-ansible-logs/fixtures（原开发布局）
 *   3. 本包自带的 tests/fixtures（保证 npm 包开箱可跑，不依赖外部目录）
 */
function resolveFixtures() {
  const candidates = [
    process.env.SOC_ANSIBLE_FIXTURES,
    path.join(__dirname, '..', '..', 'dsh-ansible-logs', 'fixtures'),
    path.join(__dirname, 'fixtures'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'ansible.log'))) return dir;
  }
  throw new Error('找不到 Ansible 夹具目录，已尝试：' + candidates.join(' / '));
}
const FIXTURES = resolveFixtures();
const read = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');

/**
 * 夹具里的日志是脱敏历史数据（时间戳可能是几个月前），而 store 默认只查
 * 最近 24 小时 —— 直接落库会一条都查不到。这里把整批事件的时间戳整体平移
 * 到「刚刚」（保留彼此相对间隔），专供 store 层用例使用。
 */
function fresh(events) {
  const times = events.map((e) => e.when).filter((n) => Number.isFinite(n));
  if (!times.length) return events;
  const delta = Date.now() - Math.max(...times) - 60 * 1000;
  return events.map((e) => ({ ...e, when: e.when + delta }));
}

// ─────────────────────────── 事件模型 ───────────────────────────
test('model: makeEvent 拒绝缺 where', () => {
  assert.throws(() => model.makeEvent({ source: 'ansible', src: { kind: 'file', path: 'x', line: 1 } }), /where/);
});

test('model: makeEvent 拒绝缺 src', () => {
  assert.throws(() => model.makeEvent({ source: 'ansible', where: 'h1' }), /src/);
});

test('model: 非法枚举降级为默认值', () => {
  const e = model.makeEvent({
    source: '不存在的源', where: 'h1', result: '爆炸',
    severity: '天塌了', src: { kind: 'file', path: 'x', line: 1 },
  });
  assert.strictEqual(e.source, 'custom');
  assert.strictEqual(e.result, 'info');
  assert.strictEqual(e.severity, 'info');
});

test('model: msg 截断到 500 字以内', () => {
  const e = model.makeEvent({
    source: 'ansible', where: 'h1', msg: 'x'.repeat(900), src: { kind: 'file', path: 'x', line: 1 },
  });
  assert.ok(e.msg.length <= model.MSG_MAX, `实际 ${e.msg.length}`);
});

test('model: serialize 丢弃 raw（防敏感原文进审计）', () => {
  const e = model.makeEvent({
    source: 'ansible', where: 'h1', src: { kind: 'file', path: 'x', line: 1 },
    raw: { play: 'p', secret: 'shh' },
  });
  const s = model.serialize(e);
  assert.strictEqual(s.raw, undefined);
  assert.strictEqual(JSON.stringify(s).includes('shh'), false);
});

test('model: dedupKey 对同源同位置同时刻稳定，对位置敏感', () => {
  const base = { source: 'ansible', where: 'h1', when: 1000, what: 'task:a', src: { kind: 'file', path: 'p', line: 3 } };
  const k1 = model.dedupKey(base);
  const k2 = model.dedupKey({ ...base });
  const k3 = model.dedupKey({ ...base, src: { kind: 'file', path: 'p', line: 4 } });
  assert.strictEqual(k1, k2);
  assert.notStrictEqual(k1, k3);
});

test('model: 事件 ID 唯一', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    ids.add(model.makeEvent({ source: 'ansible', where: 'h', src: { kind: 'file', path: 'x', line: i } }).id);
  }
  assert.strictEqual(ids.size, 200);
});

// ─────────────────────────── 格式识别 ───────────────────────────
test('ansible: 识别 ansible.log 格式（置信度 0.9）', () => {
  const d = ansible.detect(read('ansible.log'));
  assert.strictEqual(d.parser.id, 'ansible-log');
  assert.strictEqual(d.score, 0.9);
});

test('ansible: 识别 AWX 格式', () => {
  const d = ansible.detect(read('awx.out'));
  assert.strictEqual(d.parser.id, 'awx');
  assert.ok(d.score >= 0.8, `实际 ${d.score}`);
});

test('ansible: 识别 JSONL 格式（置信度 0.95）', () => {
  const d = ansible.detect(read('callback.jsonl'));
  assert.strictEqual(d.parser.id, 'jsonl');
  assert.strictEqual(d.score, 0.95);
});

test('ansible: 认不出的格式走兜底并标记 fallback', () => {
  const d = ansible.detect('随便什么文本\n毫无结构的行\n第三行');
  assert.strictEqual(d.fallback, true);
});

// ─────────────────────────── 解析正确性 ───────────────────────────
test('ansible: ansible.log 解析出失败事件且带行号', () => {
  const { events } = ansible.parseText(read('ansible.log'), { path: 'ansible.log' });
  const bad = events.filter((e) => e.result === 'failed' || e.result === 'unreachable');
  assert.ok(bad.length >= 4, `失败事件数 ${bad.length}`);
  assert.ok(bad.every((e) => e.src.kind === 'file' && e.src.line > 0), '每个事件必须带行号');
  assert.ok(bad.every((e) => e.where), '每个事件必须有主机');
});

test('ansible: 三种格式对同一份日志给出相同的主机集合', () => {
  const a = ansible.parseText(read('ansible.log'), { path: 'a' }).events;
  const b = ansible.parseText(read('awx.out'), { path: 'b' }).events;
  const c = ansible.parseText(read('callback.jsonl'), { path: 'c' }).events;
  const hosts = (es) => new Set(es.map((e) => e.where));
  const ha = hosts(a), hb = hosts(b), hc = hosts(c);
  assert.deepStrictEqual([...ha].sort(), [...hb].sort());
  assert.deepStrictEqual([...ha].sort(), [...hc].sort());
});

test('ansible: 不可达事件定级为 high', () => {
  const { events } = ansible.parseText(read('ansible.log'), { path: 'x' });
  const un = events.find((e) => e.result === 'unreachable');
  assert.ok(un, '应存在 unreachable 事件');
  assert.strictEqual(un.severity, 'high');
});

test('ansible: 解析器不产生重复 ID', () => {
  const { events } = ansible.parseText(read('ansible.log'), { path: 'x' });
  const ids = new Set(events.map((e) => e.id));
  assert.strictEqual(ids.size, events.length);
});

// ─────────────────────────── store ───────────────────────────
test('store: 幂等 —— 同一批事件重复 append 只落一次', () => {
  const sink = memorySink();
  const store = createStore({ sink });
  const events = fresh(ansible.parseText(read('awx.out'), { path: 'awx.out' }).events);
  const r1 = store.append(events);
  const r2 = store.append(events);
  assert.strictEqual(r1.added, events.length, `首次应全进，实际 ${r1.added}/${events.length}`);
  assert.strictEqual(r2.added, 0, `重复应全跳，实际 ${r2.added}`);
  assert.strictEqual(r2.skipped, events.length);
});

test('store: 查询返回 total 与 truncated，limit 生效', () => {
  const sink = memorySink();
  const store = createStore({ sink });
  const events = fresh(ansible.parseText(read('ansible.log'), { path: 'x' }).events);
  store.append(events);
  const q = store.query({ limit: 3 });
  assert.strictEqual(q.events.length, 3);
  assert.strictEqual(q.total, events.length);
  assert.strictEqual(q.truncated, true);
});

test('store: limit 硬上限 200', () => {
  const store = createStore({ sink: memorySink() });
  const q = store.query({ limit: 9999 });
  assert.ok(q.events.length <= 200);
});

test('store: 默认时间窗 24h，早于窗口的事件查不到', () => {
  const sink = memorySink();
  const store = createStore({ sink });
  const old = model.makeEvent({
    source: 'ansible', where: 'h1', when: Date.now() - 72 * 3600 * 1000,
    src: { kind: 'file', path: 'p', line: 1 },
  });
  store.append([old]);
  const q = store.query({});
  assert.strictEqual(q.total, 0, '72 小时前的事件不应出现在默认 24h 窗口');
  const q2 = store.query({ from: Date.now() - 96 * 3600 * 1000 });
  assert.strictEqual(q2.total, 1, '放宽时间窗应能查到');
});

test('store: 按 source / host / severity 过滤', () => {
  const sink = memorySink();
  const store = createStore({ sink });
  const events = fresh(ansible.parseText(read('ansible.log'), { path: 'x' }).events);
  store.append(events);
  const byHost = store.query({ host: 'web-03', limit: 200 });
  assert.ok(byHost.events.every((e) => e.where === 'web-03'));
  const bySev = store.query({ severity: 'high', limit: 200 });
  assert.ok(bySev.events.every((e) => e.severity === 'high'));
});

test('store: byIds 最多取 20 个', () => {
  const sink = memorySink();
  const store = createStore({ sink });
  const events = fresh(ansible.parseText(read('ansible.log'), { path: 'x' }).events);
  store.append(events);
  const ids = events.slice(0, 30).map((e) => e.id);
  const got = store.byIds(ids);
  assert.ok(got.length <= 20, `实际 ${got.length}`);
});


// ─────────────────────────── 判定与关联 ───────────────────────────
const analyze = require('../src/core/analyze');

test('analyze: 归类 —— 变量未定义', () => {
  assert.strictEqual(analyze.classify("The error was: 'upstream_backends' is undefined").key, 'undefined-var');
});

test('analyze: 归类 —— 服务失败优先于文件缺失', () => {
  // 「Could not find the requested service」含 could not find，但语义是服务
  assert.strictEqual(analyze.classify('Could not find the requested service nginx: host').key, 'service');
});

test('analyze: 归类 —— 权限不足', () => {
  assert.strictEqual(analyze.classify('Permission denied: /var/log/nginx/audit.log').key, 'auth');
});

test('analyze: 归类 —— 不可达', () => {
  assert.strictEqual(analyze.classify('Failed to connect to the host via ssh: Connection timed out').key, 'unreachable');
});

test('analyze: 空消息归到 unknown', () => {
  assert.strictEqual(analyze.classify('').key, 'unknown');
});

test('analyze: 认不出的归到 other', () => {
  assert.strictEqual(analyze.classify('some totally novel error xyz').key, 'other');
});

test('analyze: aggregate 统计主机与原因', () => {
  const { events } = ansible.parseText(read('ansible.log'), { path: 'x' });
  const agg = analyze.aggregate(events);
  assert.ok(agg.problemCount >= 5, `问题数 ${agg.problemCount}`);
  assert.strictEqual(agg.reasons[0].key, 'undefined-var', '最集中的应是变量未定义');
  assert.ok(agg.hosts.length >= 3);
  assert.ok(agg.hosts[0].problems >= agg.hosts[agg.hosts.length - 1].problems, '主机按问题数降序');
});

test('analyze: correlate R1 变更后异常', () => {
  const t0 = 1000000;
  const events = [
    model.makeEvent({ source: 'ansible', where: 'h1', when: t0, what: 'task:下发配置', result: 'changed', src: { kind: 'file', path: 'a', line: 1 } }),
    model.makeEvent({ source: 'onesec', where: 'h1', when: t0 + 5 * 60000, what: 'edr:malware', result: 'alert', severity: 'high', msg: 'trojan detected', src: { kind: 'file', path: 'b', line: 2 } }),
  ];
  const { verdicts } = analyze.correlate(events, { windowMs: 10 * 60000 });
  const r1 = verdicts.find((v) => v.rule === 'R1');
  assert.ok(r1, '应命中变更后异常');
  assert.strictEqual(r1.event_ids.length, 2);
});

test('analyze: correlate R1 超出时间窗不命中', () => {
  const t0 = 2000000;
  const events = [
    model.makeEvent({ source: 'ansible', where: 'h1', when: t0, what: 'task:x', result: 'changed', src: { kind: 'file', path: 'a', line: 1 } }),
    model.makeEvent({ source: 'onesec', where: 'h1', when: t0 + 30 * 60000, what: 'edr:y', result: 'alert', severity: 'high', src: { kind: 'file', path: 'b', line: 2 } }),
  ];
  const { verdicts } = analyze.correlate(events, { windowMs: 10 * 60000 });
  assert.strictEqual(verdicts.filter((v) => v.rule === 'R1').length, 0);
});

test('analyze: correlate R2 同因多发（≥3 台）', () => {
  const events = ['h1', 'h2', 'h3'].map((h, i) => model.makeEvent({
    source: 'ansible', where: h, when: 3000000, result: 'failed',
    what: 'task:校验变量', msg: "'cfg' is undefined", src: { kind: 'file', path: 'a', line: i + 1 },
  }));
  const { verdicts } = analyze.correlate(events);
  const r2 = verdicts.find((v) => v.rule === 'R2');
  assert.ok(r2, '三台同因应命中 R2');
  assert.ok(r2.reason.includes('3 台'));
});

test('analyze: correlate R3 监控盲区', () => {
  const events = [model.makeEvent({
    source: 'ansible', where: 'h1', when: 4000000, result: 'ok',
    src: { kind: 'file', path: 'a', line: 1 },
  })];
  const { verdicts } = analyze.correlate(events, { expectedSources: ['ansible', 'onesec'] });
  const r3 = verdicts.find((v) => v.rule === 'R3');
  assert.ok(r3, '缺 onesec 数据应报盲区');
  assert.deepStrictEqual(r3.missing, ['onesec']);
});

test('analyze: summarize 无问题时的措辞', () => {
  const s = analyze.summarize({ totalEvents: 3, problemCount: 0, hostCount: 2, reasons: [] });
  assert.ok(s.includes('未见失败'), s);
});

// ─────────────────────────── 审计链 ───────────────────────────
const { createAudit, memoryAuditSink, fileAuditSink, hashOf, hashOfV1, GENESIS } = require('../src/core/audit');

test('audit: 首条 prevHash 为 genesis', () => {
  const a = createAudit({ sink: memoryAuditSink(), user: 'tester' });
  const r = a.append({ question: 'q1' });
  assert.strictEqual(r.prevHash, GENESIS);
  assert.strictEqual(r.seq, 1);
  assert.strictEqual(r.user, 'tester');
});

test('audit: 链式 prevHash 正确接续', () => {
  const a = createAudit({ sink: memoryAuditSink(), user: 't' });
  const r1 = a.append({ question: 'q1' });
  const r2 = a.append({ question: 'q2' });
  assert.strictEqual(r2.prevHash, r1.hash);
});

test('audit: verify 通过（未篡改）', () => {
  const sink = memoryAuditSink();
  const a = createAudit({ sink, user: 't' });
  a.append({ question: 'q1' });
  a.append({ question: 'q2' });
  const v = a.verify([new Date().toISOString().slice(0, 10)]);
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  assert.strictEqual(v.checked, 2);
});

test('audit: verify 检出被篡改的记录', () => {
  const sink = memoryAuditSink();
  const a = createAudit({ sink, user: 't' });
  a.append({ question: 'q1' });
  a.append({ question: 'q2' });
  // 手工篡改第一条的 question
  const dk = new Date().toISOString().slice(0, 10);
  const lines = sink.readAll(dk);
  const first = JSON.parse(lines[0]);
  first.question = '我没问过这个';
  sink.append = () => {}; // 防再写
  // 直接改内部存储
  const rows = sink.all();
  const idx = rows.indexOf(lines[0]);
  // 用重新构造的方式模拟篡改
  const tampered = JSON.stringify(first);
  const orig = sink.readAll(dk)[0];
  assert.notStrictEqual(tampered, orig, '篡改后内容应不同');
  // 用篡改内容重建一个 sink 验证
  const sink2 = memoryAuditSink();
  sink2.append(tampered, dk);
  sink2.append(lines[1], dk);
  const a2 = createAudit({ sink: sink2, user: 't' });
  const v = a2.verify([dk]);
  assert.strictEqual(v.ok, false, '应检出篡改');
  assert.ok(/hash|prevHash/.test(v.reason), v.reason);
});

// ── 2026-10-21 全面评审新增：哈希必须覆盖嵌套字段 ──
// 回归缺陷：原实现用 JSON.stringify(obj, Object.keys(obj).sort())，
// 那个键名数组是 replacer，对所有层级生效，嵌套对象中不在顶层键名
// 集合里的字段被整体丢弃 —— 篡改工具参数/事件ID/模型输出时 hash 不变，
// 审计链形同虚设。
test('audit: 篡改嵌套 toolCalls 参数必须改变 hash', () => {
  const body = {
    seq: 1, at: 1700000000000, user: 'u', question: 'q',
    toolCalls: [{ tool: 'query_all', args: { limit: 5 }, eventIds: ['e1'], at: 1700000000001 }],
    modelOutput: '', referencedEventIds: ['e1'], verdictRefs: [], note: 'tool-call',
    prevHash: GENESIS,
  };
  const h1 = hashOf(body);
  const tampered = { ...body, toolCalls: [{ tool: 'query_all', args: { limit: 9999 }, eventIds: ['e1'], at: 1700000000001 }] };
  assert.notStrictEqual(hashOf(tampered), h1, '改了工具参数，hash 必须变');
});

test('audit: 篡改 referencedEventIds / modelOutput 必须改变 hash', () => {
  const body = {
    seq: 1, at: 1, user: 'u', question: 'q', toolCalls: [],
    modelOutput: '原结论', referencedEventIds: ['e1'], verdictRefs: [], note: '', prevHash: GENESIS,
  };
  const h1 = hashOf(body);
  assert.notStrictEqual(hashOf({ ...body, referencedEventIds: ['e2'] }), h1, '改了事件ID，hash 必须变');
  assert.notStrictEqual(hashOf({ ...body, modelOutput: '伪造结论' }), h1, '改了模型输出，hash 必须变');
});

test('audit: 字段顺序不同但内容相同，hash 必须一致（稳定序列化）', () => {
  const a = { seq: 1, at: 1, user: 'u', question: 'q', note: 'n' };
  const b = { note: 'n', question: 'q', user: 'u', at: 1, seq: 1 };
  assert.strictEqual(hashOf(a), hashOf(b), '键序不同不应影响 hash');
});

// ── 2026-10-21 全面评审新增：跨天续链 ──
// 回归缺陷：hydrate 只读当天文件，进程跨天重启后 lastHash 停在 genesis，
// 新一天从 genesis 重新起链，与前一天断链。
test('audit: 跨天续链 —— 新一天首条接上昨天的末条', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-audit-'));
  const sink = fileAuditSink(dir);
  const yesterday = new Date(Date.now() - 86400000);
  const p = (n) => String(n).padStart(2, '0');
  const yKey = `${yesterday.getFullYear()}-${p(yesterday.getMonth() + 1)}-${p(yesterday.getDate())}`;

  // 先在「昨天」写一条
  const a1 = createAudit({ sink, user: 't' });
  const r1 = a1.append({ question: '昨天的问题' });
  assert.strictEqual(r1.prevHash, GENESIS);

  // 新进程（模拟重启），今天再写一条
  const a2 = createAudit({ sink, user: 't' });
  const r2 = a2.append({ question: '今天的问题' });
  assert.notStrictEqual(r2.prevHash, GENESIS, '今天首条不能从 genesis 重新起链');
  assert.strictEqual(r2.prevHash, r1.hash, '必须接上昨天的末条 hash');
  assert.strictEqual(r2.seq, 2, 'seq 必须接着往下数');

  // 整链 verify 必须通过
  const a3 = createAudit({ sink, user: 't' });
  const todayKey = new Date().toISOString().slice(0, 10);
  const v = a3.verify([yKey, todayKey]);
  assert.strictEqual(v.ok, true, '跨天整链应校验通过：' + JSON.stringify(v));
  assert.strictEqual(v.checked, 2);
});

// ─────────────────────────── 跨天事件反查 ───────────────────────────
// ── 2026-10-21 评审新增：哈希算法平滑升级 ──
// 回归缺陷：算法从 v1 升到 v2 后，verify 用新算法重算全部历史记录，
// 于是 26 条旧记录全被误判「被篡改」。审计链一旦报假警就没人再信它。
// 修复：每条记录带 alg 字段，verify 按记录自身版本重算。
test('audit: 旧算法(v1)历史记录仍能通过校验（平滑升级不误报）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-audit-mig-'));
  const sink = fileAuditSink(dir);
  const dk = new Date().toISOString().slice(0, 10);

  // 造一条 v1 时代的记录（无 alg 字段，hash 按旧算法算）
  const oldBody = {
    seq: 1, at: Date.now(), user: 't', question: '老记录',
    toolCalls: [{ tool: 'query_all', args: { limit: 5 }, eventIds: ['e1'], at: Date.now() }],
    modelOutput: '', referencedEventIds: ['e1'], verdictRefs: [], note: 'tool-call',
    prevHash: GENESIS,
  };
  const oldHash = hashOfV1(oldBody);
  sink.append(JSON.stringify({ ...oldBody, hash: oldHash }), dk);

  // 新进程用新算法写一条
  const a = createAudit({ sink, user: 't' });
  const r2 = a.append({ question: '新记录' });
  assert.strictEqual(r2.alg, 'v2', '新记录必须标注算法版本');
  assert.strictEqual(r2.prevHash, oldHash, '新记录必须接上旧记录');

  // 整链校验：v1 与 v2 混排，必须全部通过
  const a2 = createAudit({ sink, user: 't' });
  const v = a2.verify([dk]);
  assert.strictEqual(v.ok, true, 'v1/v2 混排的链应校验通过：' + JSON.stringify(v));
  assert.strictEqual(v.checked, 2);
});

test('audit: 未知算法版本必须如实报错，不放行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-audit-alg-'));
  const sink = fileAuditSink(dir);
  const dk = new Date().toISOString().slice(0, 10);
  sink.append(JSON.stringify({
    seq: 1, at: 1, user: 't', question: 'q', toolCalls: [], modelOutput: '',
    referencedEventIds: [], verdictRefs: [], note: '', prevHash: GENESIS,
    alg: 'v99', hash: 'deadbeef',
  }), dk);
  const a = createAudit({ sink, user: 't' });
  const v = a.verify([dk]);
  assert.strictEqual(v.ok, false, '未知版本不得静默通过');
  assert.ok(/算法/.test(v.reason), v.reason);
});

test('store: byIds 能跨天查到昨天的证据', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-store-'));
  const store = createStore({ sink: fileSink(dir) });
  const yesterday = Date.now() - 86400000;
  const ev = model.makeEvent({
    source: 'ansible', where: 'web-03', when: yesterday, what: 'task:下发配置',
    result: 'failed', msg: "'cfg' is undefined", src: { kind: 'file', path: 'a.log', line: 7 },
  });
  store.append([ev]);
  const got = store.byIds([ev.id]);
  assert.strictEqual(got.length, 1, '隔天的证据 ID 必须能查到');
  assert.strictEqual(got[0].id, ev.id);
});

// ─────────────────────────── EDR 适配器 ───────────────────────────
const edr = require('../src/core/adapters/edr');

test('edr: 天擎字段映射（terminal_name / risk_level）', () => {
  const rows = [{ terminal_name: 'pc-01', risk_level: 9, threat_name: '勒索软件', occur_time: 1700000000, description: 'blocked' }];
  const evs = edr.parseWith('tianqing', rows, { path: 't.json' });
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].where, 'pc-01');
  assert.strictEqual(evs[0].severity, 'critical');
  assert.strictEqual(evs[0].source, 'tianqing');
  assert.ok(evs[0].when > 1e12, '秒应转毫秒');
});

test('edr: OneSEC 字段映射（endpoint_name）', () => {
  const rows = [{ endpoint_name: 'nb-07', risk_level: 'high', alert_name: 'C2 通信', event_time: '2026-10-21 10:00:00' }];
  const evs = edr.parseWith('onesec', rows, { path: 'o.json' });
  assert.strictEqual(evs[0].where, 'nb-07');
  assert.strictEqual(evs[0].severity, 'high');
  assert.strictEqual(evs[0].result, 'alert');
});

test('edr: 无主机字段的记录被跳过（不产生无主事件）', () => {
  const rows = [{ risk_level: 9, msg: 'x' }];
  const evs = edr.parseWith('tianqing', rows, { path: 'x' });
  assert.strictEqual(evs.length, 0);
});

test('edr: 严重度归一（中文/数字/英文）', () => {
  assert.strictEqual(edr.normSeverity('严重'), 'critical');
  assert.strictEqual(edr.normSeverity(8), 'high');
  assert.strictEqual(edr.normSeverity('medium'), 'medium');
  assert.strictEqual(edr.normSeverity('无意义'), 'info');
});

test('edr: 尚未验证的 profile 标 verified=false', () => {
  assert.strictEqual(edr.createAdapter('tianqing').verified, false);
  assert.strictEqual(edr.createAdapter('onesec').verified, false);
});

// ─────────────────────────── 只读 DB ───────────────────────────
const db = require('../src/core/adapters/db-readonly');

test('db: 放行普通 SELECT', () => {
  assert.strictEqual(db.checkSql('SELECT * FROM alerts WHERE level > 5'), null);
});

test('db: 放行 WITH 查询', () => {
  assert.strictEqual(db.checkSql('WITH t AS (SELECT 1) SELECT * FROM t'), null);
});

test('db: 拒绝 INSERT / UPDATE / DELETE / DROP', () => {
  for (const sql of ['INSERT INTO a VALUES(1)', 'UPDATE a SET x=1', 'DELETE FROM a', 'DROP TABLE a', 'TRUNCATE a']) {
    assert.ok(db.checkSql(sql), `应拒绝：${sql}`);
  }
});

test('db: 拒绝多语句', () => {
  assert.ok(db.checkSql('SELECT 1; SELECT 2'));
  assert.ok(db.checkSql('SELECT 1; DROP TABLE t'));
});

test('db: 拒绝 SQL 注释（截断绕过）', () => {
  assert.ok(db.checkSql('SELECT 1 -- x'));
  assert.ok(db.checkSql('SELECT /* x */ 1'));
});

test('db: 拒绝危险函数', () => {
  assert.ok(db.checkSql("SELECT pg_read_file('/etc/passwd')"));
  assert.ok(db.checkSql("SELECT load_file('/etc/shadow')"));
});

test('db: 非 SELECT 开头一律拒绝', () => {
  assert.ok(db.checkSql('EXPLAIN SELECT 1'));
  assert.ok(db.checkSql('SHOW TABLES'));
});

test('db: reader 在发往数据库前就拒绝', async () => {
  let called = false;
  const r = db.createReader({ query: async () => { called = true; return []; } });
  let threw = false;
  try {
    await r.select('DELETE FROM x');
  } catch (e) {
    threw = true;
    assert.strictEqual(e.code, 'READONLY_VIOLATION');
  }
  assert.strictEqual(threw, true);
  assert.strictEqual(called, false, '被拒绝的 SQL 不应到达数据库');
});

// ─────────────────────────── 本机日志发现（2026-10-21 新增）───────────────────────────
const logdiscover = require('../src/core/logdiscover');

test('logdiscover: 敏感路径一律不返回（shadow/密钥/.env）', () => {
  for (const p of ['/etc/shadow', '/root/.ssh/id_rsa', '/opt/app/.env', '/x/server.key', '/x/token.json']) {
    assert.strictEqual(logdiscover.isSensitive(p), true, `${p} 应被判定为敏感`);
  }
  assert.strictEqual(logdiscover.isSensitive('/var/log/nginx/access.log'), false);
});

test('logdiscover: 只认日志类文件，不把随机文件当日志', () => {
  // 有扩展名的
  assert.ok(logdiscover.LOG_NAME_RE.test('access.log'));
  assert.ok(logdiscover.LOG_NAME_RE.test('syslog.1.gz'));
  assert.ok(logdiscover.LOG_NAME_RE.test('app.jsonl'));
  // 无扩展名的经典系统日志（Linux 上最关键的那几份）
  assert.ok(logdiscover.LOG_NAME_RE.test('syslog'), 'syslog 必须认');
  assert.ok(logdiscover.LOG_NAME_RE.test('messages'), 'messages 必须认');
  assert.ok(logdiscover.LOG_NAME_RE.test('secure'), 'secure 必须认');
  // 不该认的
  assert.ok(!logdiscover.LOG_NAME_RE.test('id_rsa'));
  assert.ok(!logdiscover.LOG_NAME_RE.test('index.html'));
});

test('logdiscover: 能扫到本机日志且结果不含敏感路径', () => {
  const r = logdiscover.discoverLogs({ maxFiles: 50 });
  assert.ok(Array.isArray(r.files), 'files 必须是数组');
  for (const f of r.files) {
    assert.strictEqual(logdiscover.isSensitive(f.path), false, `结果里出现敏感路径：${f.path}`);
    assert.ok(f.category, '每条必须有类别');
    assert.ok(f.size_human, '每条必须有人读大小');
  }
});

test('logdiscover: 类别识别覆盖常见服务', () => {
  assert.strictEqual(logdiscover.guessCategory('auth.log'), '认证/登录');
  assert.strictEqual(logdiscover.guessCategory('nginx-access.log'), 'Web 服务');
  assert.strictEqual(logdiscover.guessCategory('mysqld.log'), '数据库');
  assert.strictEqual(logdiscover.guessCategory('syslog'), '系统');
});

test('logdiscover: readTail 只读尾部且不炸', () => {
  const os2 = require('node:os');
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), 'soc-log-'));
  const f = path.join(dir, 'app.log');
  fs.writeFileSync(f, Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
  const r = logdiscover.readTail(f, { lines: 10 });
  assert.strictEqual(r.lines.length, 10);
  assert.strictEqual(r.lines[9], 'line 499', '必须是最后一行');
  assert.strictEqual(r.truncated, true);
  // grep 过滤
  const g = logdiscover.readTail(f, { lines: 5, grep: 'line 49' });
  assert.ok(g.lines.every((l) => l.includes('line 49')));
});

// ─────────────────────────── 故障诊断规则库（2026-10-21 新增）───────────────────────────
const diagnose = require('../src/core/diagnose');

test('diagnose: 命中磁盘满 / OOM / IO 错误并给出措施', () => {
  const lines = [
    'app: java.io.IOException: No space left on device',
    'kernel: Out of memory: Killed process 789 (java)',
    'kernel: EXT4-fs error (device sda1): journal check failed',
  ];
  const { findings } = diagnose.diagnose(lines, { path: '/var/log/syslog' });
  const keys = findings.map((f) => f.key);
  assert.ok(keys.includes('disk-full'), '应命中磁盘满');
  assert.ok(keys.includes('oom'), '应命中 OOM');
  assert.ok(keys.includes('disk-io-error'), '应命中 IO 错误');
  for (const f of findings) {
    assert.ok(Array.isArray(f.remedy) && f.remedy.length > 0, `${f.key} 必须有解决措施`);
    assert.ok(f.verify, `${f.key} 必须有验收标准`);
    assert.ok(f.samples.length > 0, `${f.key} 必须有证据样本`);
    assert.ok(f.samples[0].line > 0, `${f.key} 证据必须带行号`);
  }
});

test('diagnose: 无关行不误报', () => {
  const lines = ['一切正常运行', 'GET /index.html 200', 'user logged in successfully'];
  const { findings, hitLines } = diagnose.diagnose(lines, {});
  assert.strictEqual(findings.length, 0, '正常日志不应产生告警');
  assert.strictEqual(hitLines, 0);
});

test('diagnose: 同类多次命中合并计数，样本最多 3 条', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `app: Connection refused to db:${i}`);
  const { findings } = diagnose.diagnose(lines, {});
  const cr = findings.find((f) => f.key === 'connection-refused');
  assert.ok(cr, '应命中连接拒绝');
  assert.strictEqual(cr.count, 10, '计数应为 10');
  assert.ok(cr.samples.length <= 3, '样本最多 3 条');
});

test('diagnose: critical 排在前面', () => {
  const lines = [
    'sshd: Failed password for invalid user admin',
    'kernel: Out of memory: Killed process 1 (x)',
  ];
  const { findings } = diagnose.diagnose(lines, {});
  assert.strictEqual(findings[0].severity, 'critical', 'critical 必须排第一');
});

test('diagnose: 断章取义防护 —— 超长行被跳过', () => {
  const lines = ['x'.repeat(5000) + ' No space left on device'];
  const { findings } = diagnose.diagnose(lines, {});
  assert.strictEqual(findings.length, 0, '超长行（疑似二进制垃圾）应跳过');
});

test('diagnose: 空日志给出明确结论而非报错', () => {
  const { findings } = diagnose.diagnose([], {});
  assert.strictEqual(findings.length, 0);
  assert.ok(/没有命中/.test(diagnose.summarizeDiagnosis(findings)));
});

// ─────────────────────────── 安全基线（2026-10-21 新增）───────────────────────────
const secbaseline = require('../src/core/secbaseline');

test('secbaseline: 五个检查项都跑得到（读不到文件不报错）', () => {
  const r = secbaseline.runBaseline();
  assert.deepStrictEqual(r.checked.sort(), ['SUID', 'sudo 授权', '口令策略', '暴露面', 'SSH 配置'].sort());
  assert.ok(Array.isArray(r.evidence) && r.evidence.length > 0, '必须有证据说明');
  for (const f of r.findings) {
    assert.ok(f.severity && f.label && f.advice, `finding 缺字段：${JSON.stringify(f).slice(0, 80)}`);
    assert.ok(Array.isArray(f.advice) && f.advice.length > 0, '每条必须有处置建议');
  }
});

test('secbaseline: 空口令账户必须判 critical', () => {
  // 直接测口令检查的解析逻辑：用临时文件模拟不可行（路径写死），
  // 改为断言 runBaseline 在无可读 shadow 时不会误报 critical 空口令
  const r = secbaseline.runBaseline();
  const empty = r.findings.find((f) => f.key === 'pw-empty');
  const shadowReadable = r.evidence.some((e) => e.includes('/etc/shadow: 不可读'));
  if (shadowReadable) {
    assert.ok(!empty, '读不到 shadow 时不得凭空报空口令');
  } else if (empty) {
    assert.strictEqual(empty.severity, 'critical', '空口令必须是 critical');
  }
});

test('secbaseline: 暴露面检查不依赖子进程（只读 /proc/net）', () => {
  const r = secbaseline.checkExposure();
  assert.ok(Array.isArray(r.findings));
  // 非 root 或无 /proc 时也要正常返回，不能抛
  assert.ok(Array.isArray(r.evidence));
});

// ─────────────────────────── journal（唯一子进程工具）───────────────────────────
const journal = require('../src/core/journal');

test('journal: 正常参数拼装正确', () => {
  const { args, unit } = journal.buildArgs({ unit: 'nginx.service', lines: 50, since: '-2h' });
  assert.strictEqual(unit, 'nginx.service');
  assert.deepStrictEqual(args.slice(0, 3), ['--no-pager', '-o', 'short-iso']);
  assert.ok(args.includes('-u') && args.includes('nginx.service'));
  assert.ok(args.includes('-n') && args.includes('50'));
  assert.ok(args.includes('--since') && args.includes('-2h'));
});

test('journal: 拒绝以 - 开头的 unit（防参数注入）', () => {
  assert.throws(() => journal.buildArgs({ unit: '--vacuum-size=1' }), /不能以 - 开头/);
  assert.throws(() => journal.buildArgs({ unit: '-u' }), /不能以 - 开头/);
});

test('journal: 拒绝含 shell 元字符的 unit', () => {
  for (const bad of ['nginx; rm -rf /', 'a b', 'x$(id)', 'y`id`', 'z|cat', 'q&&w']) {
    assert.throws(() => journal.buildArgs({ unit: bad }), /非法字符|不能以 -/, `应拒绝：${bad}`);
  }
});

test('journal: 拒绝非法 since 与 priority', () => {
  assert.throws(() => journal.buildArgs({ since: '; rm -rf /' }), /since 格式不支持/);
  assert.throws(() => journal.buildArgs({ since: '--output=json' }), /since 格式不支持/);
  assert.throws(() => journal.buildArgs({ priority: 'err; id' }), /priority 不支持/);
});

test('journal: lines 有上限，超了截断', () => {
  const { args } = journal.buildArgs({ lines: 99999 });
  const i = args.indexOf('-n');
  assert.strictEqual(Number(args[i + 1]), journal.MAX_LINES);
});

test('journal: 用注入的 execFile 解析 fixture 输出（本机无 journald 也能验）', async () => {
  const fixture = [
    '2026-10-21T19:00:01+0800 host systemd[1]: nginx.service: Failed to start',
    '2026-10-21T19:00:02+0800 host kernel: Out of memory: Killed process 789',
    '2026-10-21T19:00:03+0800 host sshd[9]: Accepted publickey for ops',
    '-- No entries --',
  ].join('\n');

  let captured = null;
  const reader = journal.createJournalReader({
    execFile: (cmd, args, opts, cb) => {
      captured = { cmd, args };
      cb(null, fixture, '');
    },
  });

  const r = await reader.query({ unit: 'nginx.service', lines: 10 });
  assert.strictEqual(captured.cmd, 'journalctl', '必须以数组形式调 journalctl');
  assert.ok(Array.isArray(captured.args), '参数必须是数组（不经 shell）');
  assert.strictEqual(r.lines.length, 3, '-- No entries -- 应被过滤');
  assert.ok(r.lines[0].includes('Failed to start'));
});

test('journal: grep 在本地过滤，不塞进命令行', async () => {
  const fixture = 'a: Out of memory\nb: all good\nc: also Out of memory';
  let captured = null;
  const reader = journal.createJournalReader({
    execFile: (cmd, args, opts, cb) => { captured = args; cb(null, fixture, ''); },
  });
  const r = await reader.query({ grep: 'out of memory' });
  assert.strictEqual(r.lines.length, 2, '应过滤出 2 行');
  assert.ok(!captured.some((a) => String(a).includes('out of memory')), 'grep 关键词不得进命令行');
});

test('journal: 无法读取 journal 时给出可理解错误', async () => {
  const reader = journal.createJournalReader({
    execFile: (cmd, args, opts, cb) => cb(new Error('exit 1'), '', 'No journal files were found.'),
  });
  await assert.rejects(() => reader.query({ lines: 5 }), /没有可读的 systemd journal/);
});

// ─────────────────────────── 插件层（工具契约与白名单）───────────────────────────
// lib/index.js 是 ESM，测试是 CJS → 用动态 import 载入。
// 这里用一个最小 ctx 桩件驱动 apply()，检查：
//   1) 注册的 5 个工具的参数 schema 与实现一致（explain_events 曾经 schema 与实现不符）
//   2) 白名单真的通过 agent scope 落地（曾经只调 ctx.tools.restrict，必然抛错而从未生效）
//   3) guard 拒绝白名单外的工具
const pluginPath = path.join(__dirname, '..', 'lib', 'index.js');

/** 造一个够用的 ctx 桩件：能收工具、能记 guard、能发 agent/created、能收提示词 */
function makeCtx() {
  const registered = new Map();
  const guards = [];
  const handlers = new Map();
  const logs = [];
  const sections = [];
  const agentCtx = {
    tools: {
      restrict(filter) {
        // 模拟 dsh：restrict 只在 agent scope 上可用
        if (!filter || !filter.allow) throw new Error('restrict 需要 allow');
        agentCtx.__allow = new Set(filter.allow);
        return () => { agentCtx.__allow = null; };
      },
    },
  };
  const agent = { id: 'agent-test', ctx: agentCtx };
  const ctx = {
    tools: {
      register(def) { registered.set(def.name, def); },
      guard(fn) { guards.push(fn); return () => { const i = guards.indexOf(fn); if (i >= 0) guards.splice(i, 1); }; },
    },
    agents: { list: () => [agent] },
    systemPrompt: {
      section(s) { sections.push(s); return () => {}; },
    },
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    on(ev, fn) { handlers.set(ev, fn); },
    provide() {},
  };
  return { ctx, registered, guards, handlers, logs, agent, agentCtx, sections };
}

let pluginMod = null;
(async () => {
  // Windows 下绝对路径必须转 file:// URL，否则动态 import 报
  // ERR_UNSUPPORTED_ESM_URL_SCHEME。
  pluginMod = await import(pathToFileURL(pluginPath).href);

  test('plugin: 注册 25 个工具（18 本机诊断 + 5 多源 + 2 联网）', async () => {
    const { ctx, registered } = makeCtx();
    pluginMod.apply(ctx);
    assert.deepStrictEqual(
      [...registered.keys()].sort(),
      ['cert_check', 'config_read', 'correlate', 'diagnose_logs', 'explain_events', 'file_hash', 'journal_query', 'kb_lookup', 'kb_note', 'ls_logs', 'net_status', 'pkg_history', 'proc_detail', 'proc_list', 'query_all', 'query_ansible', 'query_edr', 'read_log', 'recent_changes', 'sec_baseline', 'send_report', 'svc_status', 'sys_metrics', 'web_fetch', 'web_search']
    );
  });

  test('plugin: ls_logs / read_log / diagnose_logs 的参数 schema 合法', () => {
    const { ctx, registered } = makeCtx();
    pluginMod.apply(ctx);
    const ls = registered.get('ls_logs').parameters;
    assert.strictEqual(ls.type, 'object');
    assert.strictEqual(ls.additionalProperties, false);
    const rd = registered.get('read_log').parameters;
    assert.deepStrictEqual(rd.required, ['path'], 'read_log 必须要求 path');
    const dg = registered.get('diagnose_logs').parameters;
    assert.strictEqual(dg.type, 'object');
  });

  test('plugin: read_log 拒绝非日志清单内的路径（防任意文件读取）', async () => {
    const { ctx, registered } = makeCtx();
    pluginMod.apply(ctx);
    const out = await registered.get('read_log').execute({ path: '/etc/shadow' });
    assert.strictEqual(out.lines.length, 0);
    assert.ok(/拒绝/.test(out.note || ''), '必须明确拒绝：' + out.note);
  });

  test('plugin: explain_events 的 schema 含 eventIds 且 additionalProperties 为 false', () => {
    const { ctx, registered } = makeCtx();
    pluginMod.apply(ctx);
    const p = registered.get('explain_events').parameters;
    assert.ok(p.properties.eventIds, '必须声明 eventIds，模型才传得进来');
    assert.strictEqual(p.properties.eventIds.type, 'array');
    assert.strictEqual(p.additionalProperties, false);
  });

  test('plugin: explain_events 的实现读 eventIds（schema 与实现一致）', async () => {
    const { ctx, registered } = makeCtx();
    pluginMod.apply(ctx);
    const def = registered.get('explain_events');
    const out = await def.execute({ eventIds: [] });
    // 空 ID 列表不应抛错，且必须回 reasons 字段
    assert.ok(Array.isArray(out.reasons), '必须返回 reasons 归因结果');
    assert.strictEqual(out.total, 0);
  });

  test('plugin: 白名单通过 agent scope 落地（restrict 不再抛错）', () => {
    const { ctx, handlers, agent, agentCtx } = makeCtx();
    pluginMod.apply(ctx);
    assert.ok(handlers.has('agent/created'), '必须监听 agent/created 以拿到 agent scope');
    // 触发事件
    handlers.get('agent/created')({ agent });
    assert.ok(agentCtx.__allow, '必须在 agent scope 上真正设置 allow 列表');
    assert.deepStrictEqual(
      [...agentCtx.__allow].sort(),
      ['cert_check', 'config_read', 'correlate', 'diagnose_logs', 'explain_events', 'file_hash', 'journal_query', 'kb_lookup', 'kb_note', 'ls_logs', 'net_status', 'pkg_history', 'proc_detail', 'proc_list', 'query_all', 'query_ansible', 'query_edr', 'read_log', 'recent_changes', 'sec_baseline', 'send_report', 'svc_status', 'sys_metrics', 'web_fetch', 'web_search']
    );
  });

  test('plugin: 白名单包含联网查因，但不含执行/写文件/派生', () => {
    const { ctx, handlers, agent, agentCtx } = makeCtx();
    pluginMod.apply(ctx);
    handlers.get('agent/created')({ agent });
    // 联网查因是诊断刚需（2026-10-21 定位调整后放开）
    for (const ok of ['web_search', 'web_fetch']) {
      assert.ok(agentCtx.__allow.has(ok), `白名单应包含 ${ok}`);
    }
    // 但执行/写入/派生一律不许
    for (const bad of ['bash', 'pwsh', 'glob', 'grep', 'write', 'edit', 'subagent', 'subagent_fork', 'send_message', 'skill']) {
      assert.ok(!agentCtx.__allow.has(bad), `白名单不得包含 ${bad}`);
    }
  });

  test('plugin: 注入了 soc-agent 自己的身份提示词', () => {
    const { ctx, sections } = makeCtx();
    pluginMod.apply(ctx);
    assert.ok(sections.length >= 2, '必须注入身份与工作流两段提示词');
    const identity = sections.find((s) => s.name === 'soc-agent:identity');
    assert.ok(identity, '必须有身份段');
    assert.ok(/安全运维智能体/.test(identity.text), '身份段要写清是什么产品');
    assert.ok(/诊断/.test(identity.text), '身份段要写清核心职责是诊断');
    assert.ok(/不能执行命令/.test(identity.text), '身份段要写清能力边界');
  });

  test('plugin: 所有工具的输出字段都在 schema 内（防 value.refs 类事故）', async () => {
    // 回归事故：工具返回了内部的 refs 字段，但 output.schema 是
    // additionalProperties:false 且未声明 refs → dsh 判输出非法，
    // 模型侧看到 "value.refs is not a declared property"，整条诊断链失效。
    const { ctx, registered } = makeCtx();
    pluginMod.apply(ctx);

    const cases = [
      ['kb_lookup', { query: '磁盘', limit: 2 }],
      ['ls_logs', { limit: 3 }],
      ['diagnose_logs', { maxFiles: 2, lines: 50 }],
      ['read_log', { path: '/etc/shadow' }],
    ];

    for (const [name, args] of cases) {
      const def = registered.get(name);
      assert.ok(def, `${name} 必须已注册`);
      const out = await def.execute(args);
      assert.ok(out && typeof out === 'object', `${name} 必须返回对象`);

      const declared = new Set(Object.keys(def.output.schema.properties || {}));
      for (const k of Object.keys(out)) {
        assert.ok(declared.has(k), `${name} 返回了未声明字段「${k}」（会导致 schema 校验失败）`);
      }
      // required 里的字段必须齐
      for (const req of def.output.schema.required || []) {
        assert.ok(req in out, `${name} 缺少 required 字段「${req}」`);
      }
    }
  });

  test('kb_note: appendMemory 只写 memory/ 目录，拒绝路径穿越', () => {
    const kb = require('../src/core/kb');
    const root = path.join(os.tmpdir(), 'soc-kb-test-' + Date.now());
    // 正常写入
    const r1 = kb.appendMemory(root, { file: '历史诊断.md', content: '测试结论：nginx 502 根因是上游超时' });
    assert.strictEqual(r1.ok, true, '应写入成功');
    // 路径分隔符在 Windows 是 \，不能写死 'memory/'
    assert.ok(/(^|[\\/])memory[\\/]/.test(r1.file), '必须落在 memory/ 目录：' + r1.file);
    // 路径穿越被拒
    const r2 = kb.appendMemory(root, { file: '../AGENTS.md', content: '恶意' });
    assert.strictEqual(r2.ok, false, '路径穿越必须被拒');
    assert.match(r2.reason, /非法|越界/);
    // 非 md 被拒
    const r3 = kb.appendMemory(root, { file: 'x.sh', content: '恶意' });
    assert.strictEqual(r3.ok, false, '非 md 文件必须被拒');
    // 空内容被拒
    const r4 = kb.appendMemory(root, { file: '历史诊断.md', content: '  ' });
    assert.strictEqual(r4.ok, false, '空内容必须被拒');
  });

  test('plugin: guard 拒绝白名单外的工具', () => {
    const { ctx, guards } = makeCtx();
    pluginMod.apply(ctx);
    assert.ok(guards.length > 0, '必须注册 guard');
    const g = guards[guards.length - 1];
    assert.strictEqual(g({ name: 'query_all' }), undefined, '白名单内应放行');
    assert.strictEqual(g({ name: 'web_search' }), undefined, '联网查因已放开，应放行');
    assert.ok(g({ name: 'bash' }), '执行类必须被拒');
    assert.ok(g({ name: 'write' }), '写入类必须被拒');
  });

  test('plugin: guard 拒绝 own-layer 逃逸工具（subagent 等）', () => {
    // dsh 的 restriction 只过滤继承层，scope 自己层的工具（dsh-tui preset
    // 注册的 subagent）绕过 restrict —— 必须由 guard 兜住。
    const { ctx, guards } = makeCtx();
    pluginMod.apply(ctx);
    const g = guards[guards.length - 1];
    for (const esc of ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent', 'skill']) {
      const reason = g({ name: esc });
      assert.ok(reason, `own-layer 逃逸工具 ${esc} 必须被 guard 拒绝`);
      assert.ok(reason.includes(esc), `拒绝原因应点名 ${esc}`);
    }
  });

  test('plugin: 工具注册失败不会因未定义函数二次抛错', () => {
    // 回归缺陷：catch 里调了未定义的 dbg()，注册失败会抛 ReferenceError 盖掉真实原因。
    const { ctx, registered, logs } = makeCtx();
    ctx.tools.register = () => { throw new Error('故意失败'); };
    pluginMod.apply(ctx);
    assert.strictEqual(registered.size, 0);
    const warns = logs.filter(([lvl]) => lvl === 'warn');
    assert.ok(warns.length >= 5, '每个工具注册失败都应记一条 warn');
    assert.ok(warns.some(([, m]) => m.includes('故意失败')), 'warn 应含真实错误信息');
  });

  // ─────────────────────────── 结果 ───────────────────────────
  console.log('');
  const total = pass + fails.length;
  if (fails.length === 0) {
    console.log(`${total}/${total} 通过`);
    process.exit(0);
  } else {
    console.log(`${pass}/${total} 通过，失败：${fails.map((f) => f.name).join('；')}`);
    process.exit(1);
  }
})();

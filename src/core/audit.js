/**
 * 审计链 —— 只追加 + prevHash 哈希链 + 防篡改校验。
 *
 * 设计要点（docs/03 §七）：
 *   1. 只追加：不提供删除/修改
 *   2. 每条记录带 prevHash（上一条的 sha256），首条为 "genesis"
 *   3. 落盘走注入 sink（测试内存 / 生产 fs，权限 0600）
 *   4. verify() 逐条校验链完整性，断链即报"审计被篡改"
 *
 * 为什么要有哈希链：JSONL 谁都能手改。加了链之后，
 * 改任何一条都会导致后续所有 prevHash 对不上，一眼可查。
 */

'use strict';

const crypto = require('node:crypto');

const GENESIS = 'genesis';

/**
 * 哈希算法版本。
 *
 * v1 —— 旧算法：`JSON.stringify(obj, Object.keys(obj).sort())`。
 *       键名数组是 replacer，对所有层级生效，嵌套字段被整体丢弃 →
 *       篡改工具参数/事件ID/模型输出时 hash 不变。**存在漏洞，仅为
 *       校验历史记录而保留，绝不再用于写新记录。**
 * v2 —— 现算法：递归排序的全量稳定序列化，任何字段改动都会改变 hash。
 *
 * 为什么要带版本（2026-10-21 评审）：算法升级后，若 verify 仍用新算法
 * 重算旧记录，全部历史记录会被误判为「被篡改」—— 审计链一旦报假警，
 * 就再也没人信它了。故每条记录自带 alg 字段，verify 按记录自身的
 * 版本重算，实现平滑升级。
 */
const ALG_V1 = 'v1';
const ALG_V2 = 'v2';
const CURRENT_ALG = ALG_V2;

/**
 * 稳定序列化：递归按键名排序，保证同样的内容算出同样的 hash。
 *
 * 注意（2026-10-21 评审修复）：绝不能用 `JSON.stringify(obj, Object.keys(obj).sort())`
 * —— 那个「键名数组」是 replacer，对**所有层级**生效，嵌套对象里不在顶层键名
 * 集合中的字段会被整体丢弃。实测后果：篡改 toolCalls 里的工具参数、
 * referencedEventIds、modelOutput，hash **完全不变**，审计链形同虚设。
 * 这里改为递归排序的全量序列化，任何字段的改动都会改变 hash。
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** v1 旧算法（仅用于校验历史记录） */
function hashOfV1(obj) {
  const stable = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash('sha256').update(stable).digest('hex');
}

/** v2 现算法 */
function hashOfV2(obj) {
  return crypto.createHash('sha256').update(stableStringify(obj)).digest('hex');
}

/** 按版本重算 hash。未知版本返回 null（表示无法校验，如实报出而不是放行）。 */
function hashByAlg(obj, alg) {
  if (alg === ALG_V2) return hashOfV2(obj);
  if (alg === ALG_V1 || alg === undefined) return hashOfV1(obj); // 历史记录无 alg 字段 → v1
  return null;
}

function hashOf(obj) {
  // 现算法：稳定序列化后 sha256
  return hashOfV2(obj);
}

/** 内存 sink：测试用，契约与 fileSink 一致 */
function memoryAuditSink() {
  const rows = [];
  return {
    append(line, dateStr) { rows.push({ line, dateStr }); },
    readAll(dateStr) { return rows.filter((r) => r.dateStr === dateStr).map((r) => r.line); },
    all() { return rows.map((r) => r.line); },
  };
}

/** 文件 sink：按天滚动，权限 0600（只有属主可读写） */
function fileAuditSink(dir) {
  const fs = require('node:fs');
  const path = require('node:path');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    append(line, dateStr) {
      const file = path.join(dir, `audit-${dateStr}.jsonl`);
      fs.appendFileSync(file, line + '\n', { encoding: 'utf8', mode: 0o600 });
    },
    readAll(dateStr) {
      const file = path.join(dir, `audit-${dateStr}.jsonl`);
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    },
    /**
     * 列出已有审计文件的日期键，按时间升序。
     * 跨天续链时用它回溯「最近一个非空日」的末条 hash。
     */
    dayKeys() {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .map((f) => /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f))
        .filter(Boolean)
        .map((m) => m[1])
        .sort();
    },
  };
}

function dateKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 创建审计链。
 * @param {{sink?: object, dir?: string, user?: string}} opts
 */
function createAudit(opts = {}) {
  const sink = opts.sink || memoryAuditSink();
  const user = opts.user || require('node:os').userInfo().username;
  let seq = 0;
  let lastHash = GENESIS;
  let hydrated = false;

  /**
   * 回填 seq 与 lastHash。
   *
   * 跨天续链（2026-10-21 评审修复）：原实现只读「当天」文件，
   * 进程跨天重启后 lastHash 停在 GENESIS，新一天的首条记录就从
   * genesis 重新起链 —— 与前一天断链，verify 会报「记录内容与 hash 不符」。
   * 现在改为：先读当天；若当天为空，则回溯**最近一个非空日**的末条，
   * 把它的 hash 作为新一天首条的 prevHash，seq 接着往下数。
   */
  function hydrate(dayKey) {
    if (hydrated) return;
    const days = typeof sink.dayKeys === 'function' ? sink.dayKeys() : [];
    // 候选日：当天 + 历史日（历史日按时间升序，取最后一个非空的）
    const candidates = [dayKey, ...days.filter((d) => d !== dayKey).sort().reverse()];

    for (const dk of candidates) {
      const lines = sink.readAll(dk);
      if (!lines.length) continue;
      let last;
      try {
        last = JSON.parse(lines[lines.length - 1]);
      } catch {
        continue; // 坏行不作为链尾，另找更早的日子
      }
      seq = last.seq || lines.length;
      lastHash = last.hash || GENESIS;
      break;
    }
    hydrated = true;
  }

  /**
   * 追加一条审计记录。
   * @param {object} entry { question?, toolCalls?, modelOutput?, referencedEventIds?, verdictRefs?, note? }
   */
  function append(entry = {}) {
    const at = Date.now();
    hydrate(dateKey(at));

    seq += 1;
    const body = {
      seq,
      at,
      user,
      question: entry.question || '',
      toolCalls: entry.toolCalls || [],
      modelOutput: entry.modelOutput || '',
      referencedEventIds: entry.referencedEventIds || [],
      verdictRefs: entry.verdictRefs || [],
      note: entry.note || '',
      prevHash: lastHash,
      // 哈希算法版本：verify 按记录自身的版本重算，算法升级不影响历史链
      alg: CURRENT_ALG,
    };
    const hash = hashOf(body);
    const record = { ...body, hash };

    sink.append(JSON.stringify(record), dateKey(at));
    lastHash = hash;
    return record;
  }

  /**
   * 校验整条链。返回 {ok, checked, brokenAt?}。
   * 断链意味着有人改了历史记录。
   *
   * 每条记录按**自身的 alg 版本**重算 hash —— 旧版本记录（v1）仍按旧算法
   * 校验，不会因算法升级被误判为「被篡改」（2026-10-21 评审修复）。
   */
  function verify(dayKeys) {
    let prev = GENESIS;
    let checked = 0;
    for (const dk of dayKeys) {
      for (const line of sink.readAll(dk)) {
        let rec;
        try { rec = JSON.parse(line); } catch {
          return { ok: false, checked, brokenAt: dk, reason: '存在无法解析的行（文件被损坏或手工插入）' };
        }
        if (rec.prevHash !== prev) {
          return { ok: false, checked, brokenAt: `${dk}#seq=${rec.seq}`, reason: `prevHash 不匹配：期望 ${prev.slice(0, 12)}…，实际 ${String(rec.prevHash).slice(0, 12)}…` };
        }
        // 重算时必须还原「与写入时完全相同的 body」。
        // 写入时 alg 是 body 的一个字段（v2），v1 时代记录则没有 alg 字段。
        // 所以：v2 → 把 alg 放回 body 再算；v1 → body 原样（不含 alg）算。
        const { hash, ...rest } = rec;
        let body;
        if (rest.alg === ALG_V2) {
          body = { ...rest };
        } else {
          const { alg, ...b } = rest;
          body = b;
        }
        if (rest.alg === undefined) {
          // 无 alg 标记 = 版本未知的历史记录。可能是 v1 时代写的，也可能是
          // 升级过程中的过渡产物（用 v2 算法但还没来得及写 alg 字段）。
          // 两种都试一遍：只要有一种对得上就算通过。
          // 注意这不比 v1 更弱 —— v1 本来就只看顶层字段，这里仍是宽松的。
          if (hashByAlg(body, ALG_V1) === hash || hashByAlg(body, ALG_V2) === hash) {
            prev = hash;
            checked++;
            continue;
          }
          return { ok: false, checked, brokenAt: `${dk}#seq=${rec.seq}`, reason: '记录内容与 hash 不符（该条被修改过）' };
        }
        const expected = hashByAlg(body, rest.alg);
        if (expected === null) {
          return { ok: false, checked, brokenAt: `${dk}#seq=${rec.seq}`, reason: `未知的哈希算法版本「${rest.alg}」，无法校验` };
        }
        if (expected !== hash) {
          return { ok: false, checked, brokenAt: `${dk}#seq=${rec.seq}`, reason: '记录内容与 hash 不符（该条被修改过）' };
        }
        prev = hash;
        checked++;
      }
    }
    return { ok: true, checked };
  }

  return { append, verify, _state: () => ({ seq, lastHash }) };
}

module.exports = {
  createAudit, memoryAuditSink, fileAuditSink,
  hashOf, hashOfV1, hashOfV2, hashByAlg, stableStringify,
  ALG_V1, ALG_V2, CURRENT_ALG,
  GENESIS, dateKey,
};

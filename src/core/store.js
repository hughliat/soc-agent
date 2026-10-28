/**
 * 只追加事件存储 —— 带幂等去重与查询上限。
 *
 * 设计要点（docs/03 §4.2）：
 *   1. 落盘走「注入 sink」，本模块本身零 fs 依赖（测试可注内存 sink）
 *   2. 只追加：不提供 delete / update
 *   3. dedupKey 幂等：同一份日志重跑不产生重复事件
 *   4. 查询有上限（默认 50 / 硬上限 200）并返回 total + truncated
 */

'use strict';

const { serialize, dedupKey } = require('./model');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * 内存 sink：测试用。
 * 契约与 fileSink 一致：readAll(dateStr) 必须只返回该日写入的行，
 * 否则 store.query 按天循环时会重复计数（曾因此产生假 bug）。
 */
function memorySink() {
  const byDate = new Map();
  const rows = [];
  return {
    append(line, dateStr) {
      rows.push(line);
      const key = dateStr || 'unknown';
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(line);
    },
    readAll(dateStr) { return (byDate.get(dateStr) || []).slice(); },
    rows,
  };
}

/** 文件 sink：按天滚动，只追加 */
function fileSink(dir) {
  const fs = require('node:fs');
  const path = require('node:path');
  fs.mkdirSync(dir, { recursive: true });
  return {
    append(line, dateStr) {
      const file = path.join(dir, `events-${dateStr}.jsonl`);
      fs.appendFileSync(file, line + '\n', { encoding: 'utf8', mode: 0o600 });
    },
    readAll(dateStr) {
      const file = path.join(dir, `events-${dateStr}.jsonl`);
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    },
    /** 列出已有事件文件的日期键（升序）。跨天反查用。 */
    dayKeys() {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .map((f) => /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f))
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
 * 创建 store。
 * @param {{sink: object}} opts  sink 必须实现 append(line, dateStr) 与 readAll(dateStr)
 */
function createStore(opts = {}) {
  const sink = opts.sink || memorySink();
  // 内存里的 dedup 集合（进程内）；跨进程由 sink 内的数据回填
  const seen = new Set();
  let hydrated = false;

  /** 首次使用时从 sink 回填 dedup 集合（保证重启后仍幂等） */
  function hydrate(dayKeys) {
    if (hydrated) return;
    for (const dk of dayKeys) {
      for (const line of sink.readAll(dk)) {
        try {
          const o = JSON.parse(line);
          seen.add(dedupKey(o));
        } catch { /* 坏行跳过 */ }
      }
    }
    hydrated = true;
  }

  /**
   * 追加事件（幂等）。返回 {added, skipped}。
   */
  function append(events) {
    if (!Array.isArray(events) || events.length === 0) return { added: 0, skipped: 0 };
    const days = [...new Set(events.map((e) => dateKey(e.when)))];
    hydrate(days);

    let added = 0;
    let skipped = 0;
    for (const ev of events) {
      const k = dedupKey(ev);
      if (seen.has(k)) { skipped++; continue; }
      seen.add(k);
      sink.append(JSON.stringify(serialize(ev)), dateKey(ev.when));
      added++;
    }
    return { added, skipped };
  }

  /**
   * 查询。所有条件与关系（AND）。
   * @param {{from?:number,to?:number,source?:string,host?:string,severity?:string,limit?:number}} q
   * @returns {{events: object[], total: number, truncated: boolean}}
   */
  function query(q = {}) {
    const now = Date.now();
    const to = q.to || now;
    const from = q.from || to - 24 * 3600 * 1000; // 默认 24h 窗
    const limit = Math.min(Math.max(1, q.limit || DEFAULT_LIMIT), MAX_LIMIT);

    const days = [];
    for (let t = from; t <= to; t += 24 * 3600 * 1000) {
      const dk = dateKey(t);
      if (!days.includes(dk)) days.push(dk);
    }
    // 边界日补齐
    const dkTo = dateKey(to);
    if (!days.includes(dkTo)) days.push(dkTo);

    const all = [];
    for (const dk of days) {
      for (const line of sink.readAll(dk)) {
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.when < from || o.when > to) continue;
        if (q.source && o.source !== q.source) continue;
        if (q.host && o.where !== q.host) continue;
        if (q.severity && o.severity !== q.severity) continue;
        all.push(o);
      }
    }
    all.sort((a, b) => b.when - a.when); // 新的在前

    return {
      events: all.slice(0, limit),
      total: all.length,
      truncated: all.length > limit,
    };
  }

  /**
   * 按 id 反查（explain 用），最多 20 个。
   *
   * 跨天反查（2026-10-21 评审修复）：原实现只读「今天」的文件，
   * 于是隔天的证据 ID 一律查不到 —— 而运维问的恰恰常是「昨天那次变更
   * 引发的问题」。现在按 sink.dayKeys() 回溯所有有数据的日期。
   */
  function byIds(ids) {
    if (!Array.isArray(ids)) return [];
    const want = new Set(ids.slice(0, 20));
    const out = [];
    const seen = new Set();
    // 优先当天，其次历史日（倒序，最近的先查）
    const today = dateKey(Date.now());
    const days = typeof sink.dayKeys === 'function' ? sink.dayKeys() : [];
    const candidates = [today, ...days.filter((d) => d !== today).sort().reverse()];
    for (const dk of candidates) {
      if (out.length >= want.size) break;
      for (const line of sink.readAll(dk)) {
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (!want.has(o.id) || seen.has(o.id)) continue;
        seen.add(o.id);
        out.push(o);
      }
    }
    return out;
  }

  return { append, query, byIds, _seen: seen };
}

module.exports = { createStore, memorySink, fileSink, DEFAULT_LIMIT, MAX_LIMIT, dateKey };

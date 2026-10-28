/**
 * EDR 类适配器 —— 奇安信天擎 / 微步 OneSEC 共用一套事件模型。
 *
 * 背景（docs/01 §3.1）：天擎与 OneSEC 同属终端安全（EDR）类，
 * 数据结构高度类似（终端告警、进程行为、文件操作、网络事件），
 * 因此共用一套「EDR 事件子模型」，各写薄 adapter 做字段映射。
 *
 * 现状：**尚无真实样本**，字段映射按公开资料与常见命名给出候选集。
 * 拿到样本后只需补 PROFILES 里的字段名，解析逻辑不用改。
 * 在此之前本适配器标 `verified: false`，不计入验收。
 */

'use strict';

const { makeEvent } = require('../model');

/** 从对象里按候选字段名取第一个存在的值 */
function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, part) => (o == null ? undefined : o[part]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** 时间解析：支持 epoch 秒/毫秒、ISO、'YYYY-MM-DD HH:mm:ss' */
function parseTime(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // 秒 → 毫秒
  const s = String(v);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }
  const d = new Date(s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** 严重度归一 */
function normSeverity(v) {
  const s = String(v ?? '').toLowerCase();
  if (/critical|严重|紧急|致命/.test(s)) return 'critical';
  if (/high|高|危险/.test(s)) return 'high';
  if (/medium|中|警告|warn/.test(s)) return 'medium';
  if (/low|低|提示|info/.test(s)) return 'low';
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 9) return 'critical';
    if (n >= 7) return 'high';
    if (n >= 4) return 'medium';
    return 'low';
  }
  return 'info';
}

/**
 * 各产品的字段映射候选。拿到样本后只需在这里补字段名。
 * 字段候选按「优先精确、再兜底」排列。
 */
const PROFILES = {
  tianqing: {
    source: 'tianqing',
    label: '奇安信天擎',
    verified: false,
    map: {
      time: ['timestamp', 'event_time', 'time', 'occur_time', 'create_time', 'happen_time'],
      host: ['hostname', 'host', 'device_name', 'terminal_name', 'computer_name', 'asset_name'],
      who: ['user', 'username', 'account', 'login_user', 'operator'],
      what: ['event_type', 'type', 'alert_type', 'rule_name', 'threat_name', 'action'],
      severity: ['severity', 'level', 'risk_level', 'threat_level'],
      msg: ['msg', 'message', 'description', 'detail', 'content', 'threat_desc'],
      ip: ['ip', 'src_ip', 'device_ip', 'terminal_ip'],
    },
  },
  onesec: {
    source: 'onesec',
    label: '微步 OneSEC',
    verified: false,
    map: {
      time: ['timestamp', 'event_time', 'occur_time', 'time', 'created_at'],
      host: ['hostname', 'host_name', 'endpoint_name', 'device_name', 'agent_name'],
      who: ['user_name', 'user', 'account', 'process_user'],
      what: ['event_type', 'alert_name', 'rule_name', 'threat_type', 'behavior', 'action'],
      severity: ['severity', 'risk_level', 'level', 'threat_level'],
      msg: ['description', 'msg', 'message', 'detail', 'threat_detail'],
      ip: ['ip', 'local_ip', 'remote_ip', 'endpoint_ip'],
    },
  },
};

/**
 * 用给定 profile 解析任意形态的 EDR 记录（对象数组 或 JSON lines）。
 * @param {object[]|string} input
 * @param {{profile: 'tianqing'|'onesec', path?: string}} opts
 */
function parseWith(profileKey, input, opts = {}) {
  const prof = PROFILES[profileKey];
  if (!prof) throw new Error(`未知 EDR profile：${profileKey}`);
  const path = opts.path || '<inline>';

  // 归一成 [{obj, line}]
  const records = [];
  if (typeof input === 'string') {
    input.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t.startsWith('{')) return;
      try { records.push({ obj: JSON.parse(t), line: i + 1 }); } catch { /* 跳过坏行 */ }
    });
  } else if (Array.isArray(input)) {
    input.forEach((obj, i) => records.push({ obj, line: i + 1 }));
  }

  const events = [];
  for (const { obj, line } of records) {
    const m = prof.map;
    const host = pick(obj, m.host) || pick(obj, m.ip) || '';
    if (!host) continue; // 无主机的记录无法归属，跳过
    const rawWhat = pick(obj, m.what);
    const sev = normSeverity(pick(obj, m.severity));
    events.push(makeEvent({
      source: prof.source,
      who: String(pick(obj, m.who) || ''),
      when: parseTime(pick(obj, m.time)) || Date.now(),
      where: String(host),
      what: rawWhat ? `edr:${rawWhat}` : 'edr',
      result: sev === 'info' || sev === 'low' ? 'info' : 'alert',
      severity: sev,
      msg: String(pick(obj, m.msg) || ''),
      src: { kind: 'file', path, line },
      raw: obj,
    }));
  }
  return events;
}

/** 自动判定是哪家（靠特征字段） */
function guessProfile(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  const has = (arr) => arr.some((k) => keys.includes(k));
  if (has(['endpoint_name', 'local_ip', 'process_user'])) return 'onesec';
  if (has(['terminal_name', 'computer_name', 'device_name'])) return 'tianqing';
  return null;
}

/** 统一适配器接口（供 index.js 调度） */
function createAdapter(profileKey) {
  const prof = PROFILES[profileKey];
  return {
    id: prof.source,
    label: prof.label,
    verified: prof.verified,
    sniff(lines) {
      let hit = 0;
      for (const l of lines.slice(0, 100)) {
        const t = l.trim();
        if (!t.startsWith('{')) continue;
        try {
          if (guessProfile(JSON.parse(t)) === profileKey) hit++;
        } catch { /* skip */ }
      }
      return hit >= 3 ? 0.7 : 0;
    },
    parse(lines, opts = {}) {
      return parseWith(profileKey, lines.join('\n'), opts);
    },
  };
}

module.exports = { PROFILES, parseWith, createAdapter, guessProfile, parseTime, normSeverity, pick };

/**
 * 统一安全事件模型 —— 所有数据源归一到这里。
 *
 * 设计要点（见 docs/03-开发设计-安全运维智能体.md §三）：
 *   1. 下游（判定/模型/展示）只引用 id，不直接持有原始数据
 *   2. 落盘与审计只写白名单字段，不含 raw（防敏感原文扩散）
 *   3. when 是 epoch ms（时区无关），展示时才按本地时区渲染
 *
 * 零副作用：本模块纯函数，不碰 fs / 网络。
 */

'use strict';

const crypto = require('node:crypto');

/** 事件来源白名单 */
const SOURCES = ['ansible', 'tianqing', 'onesec', 'custom'];

/** 结果枚举 */
const RESULTS = ['ok', 'changed', 'failed', 'unreachable', 'alert', 'info', 'skip'];

/** 严重度枚举（有序，可比较） */
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

const MSG_MAX = 500;

let seqCounter = 0;

/**
 * 生成事件 ID：evt-<unixms>-<seq>，同毫秒内靠 seq 保证唯一。
 * 单进程内单调，不依赖随机（便于审计时按 ID 排序）。
 */
function nextEventId(now) {
  seqCounter = (seqCounter + 1) % 100000;
  return `evt-${now}-${String(seqCounter).padStart(5, '0')}`;
}

/** 把任意消息截断到 500 字，保留可读性 */
function truncateMsg(msg) {
  if (msg == null) return '';
  const s = String(msg).replace(/\s+/g, ' ').trim();
  return s.length <= MSG_MAX ? s : s.slice(0, MSG_MAX - 1) + '…';
}

/**
 * 构造一个合法事件。缺字段给安全默认值，非法枚举值降级为默认并记录。
 * @param {object} input
 * @returns {object} SecurityEvent
 */
function makeEvent(input) {
  const now = input.when || Date.now();
  const source = SOURCES.includes(input.source) ? input.source : 'custom';
  const result = RESULTS.includes(input.result) ? input.result : 'info';
  const severity = SEVERITIES.includes(input.severity) ? input.severity : 'info';

  if (!input.where) throw new Error('makeEvent: where（主机/IP）必填');
  if (!input.src || !input.src.kind) throw new Error('makeEvent: src 原始坐标必填');

  return {
    id: input.id || nextEventId(now),
    source,
    who: input.who || '',
    when: now,
    where: String(input.where),
    what: input.what || '',
    result,
    severity,
    msg: truncateMsg(input.msg),
    src: input.src,
    // raw 只在内存里流转，序列化时丢弃
    raw: input.raw,
  };
}

/**
 * 序列化为可落盘/可进审计的形态：去掉 raw，其余字段按固定顺序。
 * 固定顺序是为了审计文件 diff 时稳定。
 */
function serialize(event) {
  return {
    id: event.id,
    source: event.source,
    who: event.who,
    when: event.when,
    where: event.where,
    what: event.what,
    result: event.result,
    severity: event.severity,
    msg: event.msg,
    src: event.src,
  };
}

/**
 * 幂等去重键：同一份日志重跑不应产生重复事件。
 * 用 源 + 原始坐标 + 时间 做指纹；不包含 msg（消息可能被规范化过）。
 */
function dedupKey(event) {
  const s = event.src || {};
  const locator =
    s.kind === 'file' ? `${s.path}#${s.line}` : s.kind === 'db' ? `${s.table}#${s.pk}` : JSON.stringify(s);
  const material = `${event.source}|${locator}|${event.when}|${event.what}|${event.where}`;
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** 严重度比较：a >= b */
function severityAtLeast(a, b) {
  return SEVERITIES.indexOf(a) >= SEVERITIES.indexOf(b);
}

module.exports = {
  SOURCES,
  RESULTS,
  SEVERITIES,
  MSG_MAX,
  makeEvent,
  serialize,
  dedupKey,
  severityAtLeast,
  truncateMsg,
  nextEventId,
};

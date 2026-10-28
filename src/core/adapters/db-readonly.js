/**
 * 只读数据库连接器 —— SELECT-only 在代码层强制，不只靠账号权限。
 *
 * 设计要点（docs/03 §4.1）：
 *   1. 账号只读是「约定」，代码拦截是「强制」——两者都要
 *   2. 拒绝：非 SELECT、多语句、写关键字、危险函数
 *   3. 不自己实现驱动：query 由调用方注入（pg / mysql2 / sqlite 皆可），
 *      本模块只做 SQL 白名单校验与结果包装
 *
 * 零副作用：不建立连接（连接由注入的 query 负责），可单测。
 */

'use strict';

/** 单条语句的写操作 / 危险关键字 */
const FORBIDDEN = [
  /\binsert\b/i, /\bupdate\b/i, /\bdelete\b/i, /\bdrop\b/i, /\btruncate\b/i,
  /\balter\b/i, /\bcreate\b/i, /\bgrant\b/i, /\brevoke\b/i, /\bvacuum\b/i,
  /\battach\b/i, /\bdettach\b/i, /\bpragma\b/i, /\bcopy\b/i, /\bmerge\b/i,
  /\bexec(ute)?\b/i, /\bcall\b/i, /\bload\b/i, /\boutfile\b/i, /\bdumpfile\b/i,
];

/** 危险函数（可读文件 / 执行命令 / 推迟绑定） */
const FORBIDDEN_FN = [
  /\bpg_read_file\b/i, /\bpg_sleep\b/i, /\blo_import\b/i, /\blo_export\b/i,
  /\bxp_cmdshell\b/i, /\bload_file\b/i, /\bsleep\s*\(/i, /\bbenchmark\s*\(/i,
];

const SQL_MAX_LEN = 4000;

/**
 * 校验 SQL 是否可执行。返回 null 表示通过，否则返回拒绝原因。
 * @param {string} sql
 * @returns {string|null}
 */
function checkSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return 'SQL 为空';
  const s = sql.trim();

  if (s.length > SQL_MAX_LEN) return `SQL 过长（${s.length} > ${SQL_MAX_LEN}）`;

  // 只允许单条：去掉末尾分号后不得再有分号（防多语句注入）
  const body = s.replace(/;\s*$/, '');
  if (body.includes(';')) return '禁止多语句（检测到多个分号）';

  // 必须以 SELECT 或 WITH 开头
  if (!/^\s*(select|with)\b/i.test(body)) return '只允许 SELECT / WITH 查询';

  for (const re of FORBIDDEN) {
    if (re.test(body)) return `检测到写操作或危险关键字：${re.source.replace(/\\b/g, '')}`;
  }
  for (const re of FORBIDDEN_FN) {
    if (re.test(body)) return `检测到危险函数：${re.source.replace(/\\b/g, '')}`;
  }

  // 注释截断攻击：-- 或 /* 之后可能藏东西，一律拒绝
  if (/--|\/\*/.test(body)) return '禁止 SQL 注释（可被用于截断绕过）';

  return null;
}

/**
 * 创建只读读取器。
 * @param {{query: (sql:string, params?:any[]) => Promise<any[]>, source?: string, table?: string}} opts
 *        query 由调用方注入（真实数据库驱动或测试桩）
 */
function createReader(opts) {
  if (typeof opts?.query !== 'function') throw new Error('createReader 需要注入 query 函数');
  const source = opts.source || 'db';
  const table = opts.table || 'unknown';
  let closed = false;

  /**
   * 执行查询。非 SELECT 直接抛错（在发往数据库之前拒绝）。
   */
  async function select(sql, params) {
    if (closed) throw new Error('reader 已关闭');
    const reason = checkSql(sql);
    if (reason) {
      const err = new Error(`SQL 被只读策略拒绝：${reason}`);
      err.code = 'READONLY_VIOLATION';
      throw err;
    }
    const rows = await opts.query(sql, params);
    return Array.isArray(rows) ? rows : [];
  }

  /** 把查询结果转成安全事件；makeEvent 由调用方传入以保持零耦合 */
  async function fetchEvents(sql, params, mapper) {
    const rows = await select(sql, params);
    return rows.map((row, i) => mapper(row, { source, table, pk: row.id ?? row.pk ?? i + 1 }));
  }

  function close() { closed = true; }

  return { select, fetchEvents, close, _checkSql: checkSql };
}

module.exports = { checkSql, createReader, FORBIDDEN, FORBIDDEN_FN, SQL_MAX_LEN };

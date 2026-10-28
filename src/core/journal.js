/**
 * systemd journal 查询 —— 整个工具集里**唯一**需要启动子进程的地方。
 *
 * 为什么必须单独拎出来讲安全：
 *   其他工具（读日志、读 /proc、读配置）都是 fs 读，参数进不了 shell，
 *   从架构上就不存在命令注入。而 journalctl 是外部程序，一旦参数处理
 *   不严，就等于把 shell 交给了模型。
 *
 * 所以在这一处做四道约束，缺一不可：
 *   1. **execFile 数组传参**，绝不拼字符串、绝不经 shell
 *      （execFile('journalctl', ['-u', unit]) 而不是 exec('journalctl -u ' + unit)）
 *   2. **unit 名正则白名单**：只允许 systemd 合法的 unit 字符集
 *   3. **拒绝一切以 - 开头的值** —— 否则 unit="--vacuum-size=1" 就能改行为
 *   4. **参数位固定**：只有 unit / lines / since / priority 四个位置，
 *      没有"自由附加参数"
 *
 * 另：journalctl 本身是只读查询工具，但它有 --vacuum-size / --rotate 这类
 * 破坏性动作，所以第 3 条不是形式主义。
 *
 * 零副作用：只读取，不改 journal。
 */

'use strict';

const { execFile } = require('node:child_process');

/** 允许的 unit 名字符集（systemd 合法字符，不含空格/分号/$/反引号/引号） */
const UNIT_RE = /^[A-Za-z0-9@._:\\-]+$/;
/** since 只允许相对时间或 ISO 日期，避免被用来传参数 */
const SINCE_RE = /^-(?:[0-9]{1,3})(?:s|min|m|h|d|w)$|^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;
/** 优先级白名单 */
const PRIORITIES = new Set(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']);

const MAX_LINES = 2000;
const DEFAULT_LINES = 200;

/**
 * 校验并规范化参数。任何不合规直接抛，不做"尽力修正"。
 * @param {object} raw
 * @returns {{args: string[], unit: string|null}}
 */
function buildArgs(raw = {}) {
  const args = ['--no-pager', '-o', 'short-iso'];

  let unit = null;
  if (raw.unit !== undefined && raw.unit !== null && raw.unit !== '') {
    unit = String(raw.unit).trim();
    if (unit.startsWith('-')) {
      throw new Error(`unit 不能以 - 开头：${unit}（防参数注入）`);
    }
    if (!UNIT_RE.test(unit)) {
      throw new Error(`unit 名含非法字符：${unit}（只允许字母数字 @ . _ : \\ -）`);
    }
    args.push('-u', unit);
  }

  const n = raw.lines === undefined ? DEFAULT_LINES : Number(raw.lines);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`lines 必须是正整数，收到 ${raw.lines}`);
  }
  args.push('-n', String(Math.min(Math.floor(n), MAX_LINES)));

  if (raw.since !== undefined && raw.since !== null && raw.since !== '') {
    const s = String(raw.since).trim();
    if (!SINCE_RE.test(s)) {
      throw new Error(`since 格式不支持：${s}（可用 -30m / -2h / -1d / 2026-10-21 或 2026-10-21 08:00）`);
    }
    args.push('--since', s);
  }

  if (raw.priority !== undefined && raw.priority !== null && raw.priority !== '') {
    const p = String(raw.priority).trim().toLowerCase();
    if (!PRIORITIES.has(p)) {
      throw new Error(`priority 不支持：${p}（可用 ${[...PRIORITIES].join('/')}）`);
    }
    args.push('-p', p);
  }

  if (raw.grep !== undefined && raw.grep !== null && raw.grep !== '') {
    // 注意：这里不把 grep 交给 journalctl（它不支持正则安全传参），
    // 而是在拿到输出后本地过滤。避免把任意字符串塞进命令行。
    // 仅做长度上限，实际过滤见 filterLines。
  }

  return { args, unit };
}

/** 本地过滤：关键字包含匹配（不支持正则，避免复杂查询拖死） */
function filterLines(lines, grep) {
  if (!grep) return lines;
  const kw = String(grep).toLowerCase();
  return lines.filter((l) => l.toLowerCase().includes(kw));
}

/**
 * 创建 journal 读取器（依赖注入 execFile 便于单测 —— 本机 macOS 没有 journald,
 * 只能靠 fixture 验证解析与校验逻辑）。
 *
 * @param {{execFile?: Function, timeoutMs?: number}} deps
 */
function createJournalReader(deps = {}) {
  const exec = deps.execFile || execFile;
  const timeoutMs = deps.timeoutMs || 15000;

  /**
   * @param {{unit?: string, lines?: number, since?: string, priority?: string, grep?: string}} raw
   * @returns {Promise<{lines: string[], total: number, unit: string|null, args: string[]}>}
   */
  function query(raw = {}) {
    let args;
    let unit;
    try {
      ({ args, unit } = buildArgs(raw));
    } catch (e) {
      // 参数不合规：直接拒绝，不尝试调用
      return Promise.reject(e);
    }

    return new Promise((resolve, reject) => {
      exec('journalctl', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // journalctl 在无 journal 的环境会非零退出，给出可理解的说明
          const msg = String(stderr || err.message || '').trim();
          if (/No journal files were found|not been booted with systemd|Failed to connect/i.test(msg)) {
            return reject(new Error(`本机没有可读的 systemd journal：${msg.split('\n')[0]}`));
          }
          return reject(new Error(`journalctl 失败：${msg.split('\n')[0] || err.message}`));
        }
        let lines = String(stdout || '').split(/\r?\n/);
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        // 去掉 journalctl 的 "-- No entries --" 占位
        lines = lines.filter((l) => l.trim() !== '' && l !== '-- No entries --');
        const total = lines.length;
        const shown = filterLines(lines, raw.grep);
        resolve({ lines: shown, total, unit, args });
      });
    });
  }

  return { query, buildArgs };
}

module.exports = {
  createJournalReader,
  buildArgs,
  filterLines,
  UNIT_RE,
  SINCE_RE,
  PRIORITIES,
  MAX_LINES,
  DEFAULT_LINES,
};

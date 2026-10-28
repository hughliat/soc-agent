/**
 * 本机日志发现器 —— 「这台机器上有哪些日志可以看」。
 *
 * 为什么需要它（2026-10-21 用户提出）：
 *   模型的上下文里没有文件系统，它不可能知道 /var/log 下有什么。
 *   不给它一份「日志地图」，它只能瞎猜路径，然后猜错 —— 这就是
 *   上一版「只能分析 Ansible」的根本原因：数据源是硬编码的。
 *
 * 设计原则：
 *   1. **只读**：只 stat / readdir，绝不打开内容（除 readTail）
 *   2. **白名单目录**：默认只扫 /var/log 等已知日志位置 + 用户配置的额外目录
 *   3. **敏感拒绝**：密钥、凭据、shadow 类路径一律不出现在结果里
 *   4. **零依赖**：只用 node 内置模块
 *
 * 零副作用：本模块不写任何文件。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 默认扫描的日志根目录（按平台） */
function defaultRoots() {
  if (process.platform === 'win32') {
    return [
      'C:\\Windows\\Logs',
      'C:\\Windows\\System32\\winevt\\Logs',
    ];
  }
  if (process.platform === 'darwin') {
    return ['/var/log', '/Library/Logs', '/private/var/log'];
  }
  return ['/var/log', '/var/log/journal'];
}

/**
 * 敏感路径黑名单：命中即**完全不返回**（连名字都不给）。
 * 宁可少给，也不能让模型知道 /etc/shadow 存在。
 */
const SENSITIVE_PATTERNS = [
  /shadow/i, /passwd/i, /\.ssh/i, /id_rsa/i, /id_ed25519/i,
  /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
  /credential/i, /secret/i, /token/i, /\.env$/i,
  /\.kdbx$/i, /keychain/i, /\.gnupg/i,
];

/** 日志文件扩展名 / 命名特征（用于判定「像不像日志」） */
// 注意：必须覆盖无扩展名的经典日志（syslog / messages / secure / auth.log.1.gz），
// 否则 Linux 上最关键的几份系统日志会被漏掉。
const LOG_NAME_RE = /(?:\.(?:log|out|err|txt|jsonl?|ndjson)|^(?:syslog|messages|secure|auth|cron|mail|daemon|kern|user|boot|dmesg|wtmp|btmp|lastlog))(?:(?:\.\d+)?\.(?:gz|xz|bz2)|\.[0-9]+)?$/i;
const LOG_DIR_HINT_RE = /log|journal|audit|nginx|apache|httpd|mysql|postgres|redis|docker|kube|syslog/i;

/** 单个日志文件的大小上限：超过就只读尾部（防 token 爆炸与卡死） */
const MAX_FULL_READ = 8 * 1024 * 1024; // 8 MB
const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 2000;

/** 可读性判定 */
function readable(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isSensitive(p) {
  return SENSITIVE_PATTERNS.some((re) => re.test(p));
}

/**
 * 把字节数转成人读的字符串。
 * @param {number} n
 */
function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 从文件名猜日志类别，供模型快速判断「该看哪个」。
 * @param {string} name
 * @returns {string}
 */
function guessCategory(name) {
  const n = name.toLowerCase();
  if (/auth|secure|sshd|login/.test(n)) return '认证/登录';
  if (/syslog|messages|system\.log|kernel/.test(n)) return '系统';
  if (/nginx|apache|httpd|access/.test(n)) return 'Web 服务';
  if (/mysql|postgres|mariadb|redis|mongo|sql/.test(n)) return '数据库';
  if (/docker|container|kube|pod/.test(n)) return '容器/编排';
  if (/audit|selinux/.test(n)) return '审计';
  if (/cron|at\.log/.test(n)) return '定时任务';
  if (/dmesg|boot|startup/.test(n)) return '启动/内核';
  if (/mail|postfix|exim/.test(n)) return '邮件';
  if (/journal/.test(n)) return 'systemd 日志';
  if (/\.gz$|\.xz$|\.bz2$|\.\d+$/.test(n)) return '历史轮转';
  return '其他';
}

/**
 * 扫描一个目录（不递归过深），收集日志文件。
 * @param {string} dir
 * @param {{maxDepth?: number, maxFiles?: number, maxAgeDays?: number}} opts
 * @param {object[]} out
 * @param {number} depth
 */
function scanDir(dir, opts, out, depth) {
  const maxDepth = opts.maxDepth ?? 2;
  const maxFiles = opts.maxFiles ?? 400;
  const maxAgeDays = opts.maxAgeDays ?? 30;
  if (depth > maxDepth || out.length >= maxFiles) return;
  if (isSensitive(dir)) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 无权限或不存在，静默跳过（不是错误）
  }

  const cutoff = Date.now() - maxAgeDays * 86400000;

  for (const ent of entries) {
    if (out.length >= maxFiles) return;
    const full = path.join(dir, ent.name);
    if (isSensitive(full)) continue;

    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // 不跟符号链接，防绕过白名单

    if (st.isDirectory()) {
      // 目录名像日志目录，或还在深度内 → 继续
      if (LOG_DIR_HINT_RE.test(ent.name) || depth < maxDepth) {
        scanDir(full, opts, out, depth + 1);
      }
      continue;
    }

    if (!st.isFile()) continue;
    if (!LOG_NAME_RE.test(ent.name)) continue;
    if (st.mtimeMs < cutoff) continue;
    if (!readable(full)) continue;

    out.push({
      path: full,
      name: ent.name,
      dir,
      size: st.size,
      size_human: humanSize(st.size),
      mtime: st.mtimeMs,
      mtime_iso: new Date(st.mtimeMs).toISOString(),
      category: guessCategory(ent.name),
      // 大文件只读尾部，明确告诉模型别指望全文
      read_mode: st.size > MAX_FULL_READ ? 'tail-only' : 'full',
    });
  }
}

/**
 * 发现本机可读日志。
 * @param {{roots?: string[], extraRoots?: string[], maxDepth?: number, maxFiles?: number, maxAgeDays?: number}} opts
 * @returns {{files: object[], roots: string[], scannedAt: number, truncated: boolean}}
 */
function discoverLogs(opts = {}) {
  const roots = [...(opts.roots || defaultRoots()), ...(opts.extraRoots || [])];
  const files = [];
  const maxFiles = opts.maxFiles ?? 400;

  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    if (!readable(r)) continue;
    scanDir(r, { ...opts, maxFiles }, files, 0);
  }

  files.sort((a, b) => b.mtime - a.mtime);

  return {
    files,
    roots: roots.filter((r) => fs.existsSync(r)),
    scannedAt: Date.now(),
    truncated: files.length >= maxFiles,
  };
}

/**
 * 读日志片段。支持 gzip / xz 轮转文件（gzip 用内置 zlib）。
 *
 * @param {string} filePath 必须是 discoverLogs 返回过的路径（由调用方校验）
 * @param {{lines?: number, since?: number, grep?: string}} opts
 * @returns {{lines: string[], totalRead: number, truncated: boolean, note?: string}}
 */
function readTail(filePath, opts = {}) {
  const wantLines = Math.min(Math.max(1, opts.lines || DEFAULT_TAIL_LINES), MAX_TAIL_LINES);
  const st = fs.statSync(filePath);
  let text;

  if (/\.gz$/i.test(filePath)) {
    const zlib = require('node:zlib');
    const buf = fs.readFileSync(filePath);
    text = zlib.gunzipSync(buf).toString('utf8');
  } else if (/\.(xz|bz2)$/i.test(filePath)) {
    // 不内置解压器：明确告知，而不是静默读成乱码
    return {
      lines: [],
      totalRead: 0,
      truncated: false,
      note: `${path.basename(filePath)} 是 ${path.extname(filePath)} 压缩格式，当前不支持解压。可先用 zgrep/xzcat 转成文本再入库。`,
    };
  } else {
    // 大文件只读尾部 MAX_FULL_READ 字节
    const start = st.size > MAX_FULL_READ ? st.size - MAX_FULL_READ : 0;
    const len = st.size - start;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      text = buf.toString('utf8');
      // 从中间截断时，丢掉第一行（可能是半行）
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  }

  let lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  // 按关键字过滤（简单包含匹配，不支持正则，避免复杂查询拖死）
  if (opts.grep) {
    const kw = String(opts.grep).toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(kw));
  }

  const total = lines.length;
  const sliced = lines.slice(-wantLines);
  return {
    lines: sliced,
    totalRead: sliced.length,
    truncated: total > sliced.length,
    ...(total > sliced.length ? { note: `共 ${total} 行匹配，只返回最后 ${sliced.length} 行` } : {}),
  };
}

module.exports = {
  discoverLogs,
  readTail,
  defaultRoots,
  guessCategory,
  humanSize,
  isSensitive,
  LOG_NAME_RE,
  SENSITIVE_PATTERNS,
  DEFAULT_TAIL_LINES,
  MAX_TAIL_LINES,
  MAX_FULL_READ,
};

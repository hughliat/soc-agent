/**
 * 系统信息只读采集 —— 9 个工具的实现基础。
 *
 * 统一的取舍（贯穿全文件）：
 *   1. **零子进程**：能读 /proc 就不调 ps，能读 /etc 就不调 systemctl。
 *      整个模块只用 fs / os / crypto —— 从架构上不存在命令注入，
 *      也不需要为「执行了什么命令」额外做审计。
 *   2. **读不到就降级**：标 unavailable + 原因，不抛异常、不臆测。
 *      非 root 环境下大量文件不可读是常态。
 *   3. **Linux 优先，macOS 尽力**：/proc 只有 Linux 有；macOS 上对应项
 *      明确返回"该平台不适用"，而不是返回空数组让人误以为"没问题"。
 *
 * 零副作用：本模块不写任何文件。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const IS_LINUX = process.platform === 'linux';
const IS_MAC = process.platform === 'darwin';

function readFileSafe(p, maxBytes) {
  try {
    const st = fs.statSync(p);
    if (maxBytes && st.size > maxBytes) {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      fs.closeSync(fd);
      return buf.slice(0, n).toString('utf8');
    }
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)}${u[i]}`;
}

// ══════════════════ 1. 资源指标 ══════════════════
function metrics() {
  const out = {
    available: true,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeHours: +(os.uptime() / 3600).toFixed(1),
    loadavg: os.loadavg().map((n) => +n.toFixed(2)),
    cpuCount: os.cpus().length,
    cpuModel: (os.cpus()[0] || {}).model || 'unknown',
    memTotal: human(os.totalmem()),
    memFree: human(os.freemem()),
    memUsedPct: +(((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1),
    disks: [],
    notes: [],
  };

  // 负载相对 CPU 核数：>1 说明排队，>2 说明严重饱和
  const perCpu = out.loadavg[0] / out.cpuCount;
  out.loadPerCpu = +perCpu.toFixed(2);
  if (perCpu > 2) out.notes.push(`负载 ${out.loadavg[0]} 是 ${out.cpuCount} 核的 ${perCpu.toFixed(1)} 倍 —— CPU 严重饱和`);
  else if (perCpu > 1) out.notes.push(`负载 ${out.loadavg[0]} 超过核数 ${out.cpuCount} —— 有排队`);

  if (out.memUsedPct > 90) out.notes.push(`内存使用 ${out.memUsedPct}% —— 接近耗尽，注意 OOM`);
  else if (out.memUsedPct > 80) out.notes.push(`内存使用 ${out.memUsedPct}% —— 偏高`);

  // 磁盘：用 statfs 读挂载点，不需要 df
  const mounts = IS_LINUX ? readMountsLinux() : IS_MAC ? ['/', '/System/Volumes/Data'] : ['/'];
  for (const m of mounts) {
    try {
      const s = fs.statfsSync(m);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      if (total === 0) continue;
      const usedPct = +(((total - free) / total) * 100).toFixed(1);
      const inodePct = s.files ? +(((s.files - s.ffree) / s.files) * 100).toFixed(1) : null;
      out.disks.push({ mount: m, total: human(total), free: human(free), usedPct, inodePct });
      if (usedPct >= 95) out.notes.push(`${m} 空间使用 ${usedPct}% —— 即将写满`);
      else if (usedPct >= 85) out.notes.push(`${m} 空间使用 ${usedPct}% —— 需关注`);
      if (inodePct !== null && inodePct >= 95) out.notes.push(`${m} inode 使用 ${inodePct}% —— inode 耗尽也会写不进去（df -h 看不出来）`);
    } catch { /* 该挂载点不可读 */ }
  }

  // D 状态进程（不可中断睡眠）—— load 高但 CPU 不忙的元凶
  if (IS_LINUX) {
    let dState = [];
    try {
      for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
        const stat = readFileSafe(`/proc/${pid}/stat`);
        if (!stat) continue;
        const close = stat.lastIndexOf(')');
        const state = stat.slice(close + 2, close + 3);
        if (state === 'D') {
          const cmd = readFileSafe(`/proc/${pid}/cmdline`) || '';
          dState.push(`${pid}: ${cmd.replace(/\0/g, ' ').trim().slice(0, 60) || '(kernel)'}`);
        }
      }
    } catch { /* ignore */ }
    if (dState.length) {
      out.notes.push(`${dState.length} 个进程处于 D 状态（不可中断 IO）—— load 偏高但 CPU 空闲时通常就是它`);
      out.dStateProcs = dState.slice(0, 10);
    }
  }

  return out;
}

function readMountsLinux() {
  const c = readFileSafe('/proc/mounts');
  if (!c) return ['/'];
  const seen = new Set();
  const out = [];
  for (const line of c.split('\n')) {
    const [dev, mount, fstype] = line.split(' ');
    if (!mount || !fstype) continue;
    if (!/^(ext[234]|xfs|btrfs|vfat|zfs)$/.test(fstype)) continue;
    if (seen.has(mount)) continue;
    seen.add(mount);
    out.push(mount);
  }
  return out.length ? out : ['/'];
}

// ══════════════════ 2. 最近变更（排查命中率最高的一刀）══════════════════
function recentChanges(opts = {}) {
  const hours = Math.min(Math.max(Number(opts.hours) || 24, 1), 24 * 30);
  const cutoff = Date.now() - hours * 3600 * 1000;
  const dirs = opts.dirs && opts.dirs.length ? opts.dirs
    : IS_LINUX ? ['/etc', '/usr/local/etc'] : ['/etc', '/usr/local/etc', '/Library/LaunchDaemons'];
  const maxPerDir = Math.min(Number(opts.limit) || 40, 200);

  const result = { hours, dirs, found: [], pkg: null, notes: [] };

  for (const d of dirs) {
    const hits = [];
    walk(d, 3, (full, st) => {
      if (st.mtimeMs < cutoff) return;
      hits.push({ path: full, mtime: new Date(st.mtimeMs).toISOString(), size: st.size });
    });
    hits.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    result.found.push({ dir: d, count: hits.length, files: hits.slice(0, maxPerDir) });
  }

  const total = result.found.reduce((s, f) => s + f.count, 0);
  if (total === 0) {
    result.notes.push(`近 ${hours} 小时 ${dirs.join('、')} 下没有文件被修改 —— 可以排除「刚改配置导致」`);
  } else {
    result.notes.push(`近 ${hours} 小时有 ${total} 个文件被修改 —— 优先核对是否是变更引发`);
  }

  // 包变更：dpkg / yum / dnf 日志里近 N 行的安装记录
  const pkgFiles = ['/var/log/dpkg.log', '/var/log/yum.log', '/var/log/dnf.log', '/var/log/apt/history.log'];
  for (const f of pkgFiles) {
    const c = readFileSafe(f, 256 * 1024);
    if (!c) continue;
    const lines = c.split('\n').filter((l) => /install |upgrade |remove |Installed|Upgraded|Removed/i.test(l)).slice(-15);
    if (lines.length) {
      result.pkg = { file: f, lines };
      break;
    }
  }

  return result;
}

function walk(dir, depth, onFile) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(full, depth - 1, onFile);
    else if (st.isFile()) onFile(full, st);
  }
}

// ══════════════════ 3. 进程 ══════════════════
function procList(opts = {}) {
  if (!IS_LINUX) {
    return { available: false, reason: '进程列表需要读取 /proc，当前平台没有（macOS 需 ps 命令，本工具不执行子进程）', procs: [] };
  }
  const sortBy = opts.sortBy === 'mem' ? 'rss' : 'cpu';
  const limit = Math.min(Number(opts.limit) || 15, 100);
  const procs = [];
  let clkTck = 100;
  try { clkTck = 100; } catch { /* 固定 100，Linux 默认 */ }

  try {
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      const stat = readFileSafe(`/proc/${pid}/stat`);
      if (!stat) continue;
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const name = stat.slice(stat.indexOf('(') + 1, close);
      const rest = stat.slice(close + 2).split(' ');
      // utime(idx 11) stime(idx 12) rss(idx 21) 相对 rest 的偏移
      const utime = Number(rest[11]) || 0;
      const stime = Number(rest[12]) || 0;
      const rssPages = Number(rest[21]) || 0;
      const state = rest[0];
      const status = readFileSafe(`/proc/${pid}/status`) || '';
      const rssMatch = /VmRSS:\s+(\d+)\s+kB/.exec(status);
      const rssKb = rssMatch ? Number(rssMatch[1]) : rssPages * 4;
      const cmd = (readFileSafe(`/proc/${pid}/cmdline`) || '').replace(/\0/g, ' ').trim();
      procs.push({
        pid: Number(pid),
        name,
        state,
        cpuSec: +((utime + stime) / clkTck).toFixed(1),
        rss: human(rssKb * 1024),
        rssKb,
        cmd: cmd.slice(0, 120),
      });
    }
  } catch (e) {
    return { available: false, reason: `读取 /proc 失败：${e.message}`, procs: [] };
  }

  procs.sort((a, b) => (sortBy === 'rss' ? b.rssKb - a.rssKb : b.cpuSec - a.cpuSec));
  return { available: true, sortBy, total: procs.length, procs: procs.slice(0, limit) };
}

function procDetail(pid) {
  if (!IS_LINUX) return { available: false, reason: '需要 /proc，当前平台不适用' };
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { available: false, reason: `pid 非法：${pid}` };

  const status = readFileSafe(`/proc/${n}/status`);
  if (!status) return { available: false, reason: `读不到 /proc/${n}/status（进程不存在或权限不足）` };

  const pick = (k) => {
    const m = new RegExp(`^${k}:\\s+(.+)$`, 'm').exec(status);
    return m ? m[1].trim() : null;
  };

  const limits = readFileSafe(`/proc/${n}/limits`) || '';
  const fdCount = (() => {
    try { return fs.readdirSync(`/proc/${n}/fd`).length; } catch { return null; }
  })();
  const cgroup = readFileSafe(`/proc/${n}/cgroup`) || '';
  const cmd = (readFileSafe(`/proc/${n}/cmdline`) || '').replace(/\0/g, ' ').trim();
  const io = readFileSafe(`/proc/${n}/io`) || '';

  const notes = [];
  const fdLimit = /Max open files\s+(\d+)/.exec(limits);
  if (fdCount !== null && fdLimit && Number(fdLimit[1]) > 0) {
    const pct = (fdCount / Number(fdLimit[1])) * 100;
    if (pct > 80) notes.push(`fd 使用 ${pct.toFixed(0)}%（${fdCount}/${fdLimit[1]}）—— 接近耗尽，可能是连接泄漏`);
  }
  const vmRss = pick('VmRSS');
  if (vmRss) {
    const kb = Number(vmRss.split(/\s+/)[0]);
    if (kb > 2 * 1024 * 1024) notes.push(`常驻内存 ${human(kb * 1024)} —— 偏大，确认是否泄漏`);
  }
  const state = pick('State');
  if (state && state.startsWith('D')) notes.push('进程处于 D 状态（不可中断 IO）—— 若卡在这里通常是底层存储或挂载问题');

  return {
    available: true,
    pid: n,
    name: pick('Name'),
    state,
    threads: pick('Threads'),
    vmRss,
    cmd,
    fdCount,
    limits: limits.split('\n').filter((l) => /open files|processes|locked memory/i.test(l)).map((l) => l.trim()),
    io: io.split('\n').filter(Boolean).map((l) => l.trim()),
    cgroup: cgroup.split('\n').filter(Boolean).map((l) => l.trim()),
    notes,
  };
}

// ══════════════════ 4. 网络状态 ══════════════════
const TCP_STATES = {
  '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2', '06': 'TIME_WAIT', '07': 'CLOSE', '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK', '0A': 'LISTEN', '0B': 'CLOSING',
};

function hexToIp(hex) {
  // /proc/net/tcp 用小端十六进制
  const b = [];
  for (let i = 0; i < 8; i += 2) b.push(parseInt(hex.slice(i, i + 2), 16));
  return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
}

function netStat() {
  if (!IS_LINUX) return { available: false, reason: '需要 /proc/net，当前平台不适用' };

  const byState = {};
  const listening = [];
  const remoteTops = new Map();

  for (const [file, fam] of [['/proc/net/tcp', 'v4'], ['/proc/net/tcp6', 'v6']]) {
    const c = readFileSafe(file);
    if (!c) continue;
    for (const line of c.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const [la, lp] = cols[1].split(':');
      const [ra, rp] = cols[2].split(':');
      const st = TCP_STATES[cols[3]] || cols[3];
      byState[st] = (byState[st] || 0) + 1;

      if (st === 'LISTEN') {
        const ip = fam === 'v4' ? hexToIp(la) : '[v6]';
        const wildcard = fam === 'v4' ? la === '00000000' : /^0{32}$/.test(la);
        listening.push({ proto: `tcp${fam === 'v6' ? '6' : ''}`, addr: ip, port: parseInt(lp, 16), wildcard });
      }
      if (st === 'ESTABLISHED' && fam === 'v4') {
        const ip = hexToIp(ra);
        remoteTops.set(ip, (remoteTops.get(ip) || 0) + 1);
      }
    }
  }

  const notes = [];
  const cw = byState.CLOSE_WAIT || 0;
  if (cw > 20) notes.push(`CLOSE_WAIT ${cw} 个 —— 对端已关、本端没关，通常是程序没 close()（连接泄漏）`);
  const tw = byState.TIME_WAIT || 0;
  if (tw > 2000) notes.push(`TIME_WAIT ${tw} 个 —— 短连接太多，考虑连接池或调 tcp_tw_reuse`);

  const topRemote = [...remoteTops.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([ip, n]) => ({ ip, connections: n }));

  return {
    available: true,
    byState,
    listening: listening.sort((a, b) => a.port - b.port),
    topRemote,
    notes,
  };
}

// ══════════════════ 5. 服务状态（读 systemd 状态文件，不调 systemctl）══════════════════
function svcStatus(opts = {}) {
  if (!IS_LINUX) return { available: false, reason: 'systemd 状态需要 Linux', units: [] };
  const filter = opts.unit ? String(opts.unit) : null;
  if (filter && !/^[A-Za-z0-9@._:-]+$/.test(filter)) {
    return { available: false, reason: `unit 名含非法字符：${filter}` };
  }

  const units = [];
  const dirs = ['/etc/systemd/system', '/run/systemd/system', '/lib/systemd/system', '/usr/lib/systemd/system'];
  const seen = new Set();

  for (const d of dirs) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.service')) continue;
      if (seen.has(n)) continue;
      if (filter && n !== filter && !n.startsWith(filter)) continue;
      seen.add(n);

      // enabled 状态看 /etc/systemd/system/*.wants 下的软链
      let enabled = false;
      for (const target of ['multi-user.target.wants', 'graphical.target.wants', 'default.target.wants']) {
        try {
          if (fs.existsSync(path.join('/etc/systemd/system', target, n))) { enabled = true; break; }
        } catch { /* ignore */ }
      }
      const failed = fs.existsSync(path.join('/run/systemd/system', `${n}.d`)) ? 'unknown' : 'unknown';
      units.push({ name: n, enabled, fragment: path.join(d, n), runtimeState: failed });
    }
  }

  const notes = [];
  if (!units.length) notes.push('未找到 .service 文件（可能不是 systemd 系统，或路径不同）');
  const notEnabled = units.filter((u) => !u.enabled).length;
  if (notEnabled > 0) notes.push(`${notEnabled} 个 service 未 enable（开机不会自启）—— 按需确认是否正常`);

  return {
    available: true,
    total: units.length,
    units: units.slice(0, Math.min(Number(opts.limit) || 60, 200)),
    notes,
    caveat: '本工具读的是 unit 文件与 wants 软链，反映「配置为开机启用」；运行态（active/failed）需 systemctl 或 journal，建议配合 journal_query',
  };
}

// ══════════════════ 6. 文件哈希 ══════════════════
function fileHash(opts = {}) {
  const p = String(opts.path || '');
  if (!p) return { available: false, reason: '必须给 path' };
  if (!path.isAbsolute(p)) return { available: false, reason: 'path 必须是绝对路径' };
  if (p.includes('\0')) return { available: false, reason: 'path 含非法字符' };

  let st;
  try { st = fs.statSync(p); } catch (e) {
    return { available: false, reason: `读不到：${e.message}` };
  }
  if (!st.isFile()) return { available: false, reason: '不是普通文件（目录或设备）' };
  if (st.size > 128 * 1024 * 1024) return { available: false, reason: `文件过大（${human(st.size)}），上限 128MB` };

  try {
    const buf = fs.readFileSync(p);
    return {
      available: true,
      path: p,
      size: st.size,
      sizeHuman: human(st.size),
      mtime: new Date(st.mtimeMs).toISOString(),
      mode: '0' + (st.mode & 0o7777).toString(8),
      uid: st.uid,
      gid: st.gid,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      note: '与基线哈希比对可判断内容是否被改（mtime 可能被伪造，哈希不会）',
    };
  } catch (e) {
    return { available: false, reason: `计算哈希失败：${e.message}` };
  }
}

// ══════════════════ 7. 包变更历史 ══════════════════
function pkgHistory(opts = {}) {
  const limit = Math.min(Number(opts.limit) || 30, 200);
  const files = [
    ['/var/log/dpkg.log', /^(?<y>\d{4}-\d{2}-\d{2}).*?(?<act>install|upgrade|remove)\s+(?<pkg>\S+)/],
    ['/var/log/yum.log', /^(?<m>\w{3}\s+\d+).*?(?<act>Installed|Updated|Erased):\s+(?<pkg>\S+)/],
    ['/var/log/dnf.log', /(?<act>Installed|Upgraded|Removed).*?:\s*(?<pkg>\S+)/],
  ];

  const events = [];
  let usedFile = null;

  for (const [f, re] of files) {
    const c = readFileSafe(f, 512 * 1024);
    if (!c) continue;
    usedFile = f;
    const lines = c.split('\n');
    for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
      const m = re.exec(lines[i]);
      if (m && m.groups) {
        events.push({
          when: m.groups.y || m.groups.m || '',
          action: (m.groups.act || '').toLowerCase(),
          pkg: m.groups.pkg || '',
          raw: lines[i].slice(0, 160),
        });
      }
    }
    if (events.length) break;
  }

  const notes = [];
  if (!usedFile) notes.push('未找到包管理日志（dpkg/yum/dnf），可能不是这些发行版或日志已轮转');
  else if (!events.length) notes.push(`${usedFile} 存在但没有解析到安装记录`);
  else notes.push(`近 ${events.length} 条安装/升级记录，来自 ${usedFile} —— 升级软件包是故障的常见诱因`);

  return { available: !!usedFile, file: usedFile, events, notes };
}

// ══════════════════ 8. 证书检查 ══════════════════
function certCheck(opts = {}) {
  const p = String(opts.path || '');
  if (!p || !path.isAbsolute(p)) return { available: false, reason: '必须给绝对路径' };

  let raw;
  try { raw = fs.readFileSync(p); } catch (e) {
    return { available: false, reason: `读不到：${e.message}` };
  }

  // 支持 PEM；DER 也在 X509Certificate 能吃的范围内
  let cert;
  try {
    cert = new crypto.X509Certificate(raw);
  } catch (e) {
    return { available: false, reason: `不是有效证书：${e.message}` };
  }

  const now = Date.now();
  const validFrom = new Date(cert.validFrom).getTime();
  const validTo = new Date(cert.validTo).getTime();
  const daysLeft = Math.floor((validTo - now) / 86400000);

  const notes = [];
  if (daysLeft < 0) notes.push(`证书已过期 ${Math.abs(daysLeft)} 天 —— 依赖它的服务会出现 TLS 握手失败`);
  else if (daysLeft <= 7) notes.push(`证书 ${daysLeft} 天后过期 —— 立即安排续期`);
  else if (daysLeft <= 30) notes.push(`证书 ${daysLeft} 天后过期 —— 本月内需处理`);
  if (now < validFrom) notes.push('证书尚未生效（notBefore 在未来）—— 检查系统时间是否漂移');

  // SAN / CN 里有 *. 说明是通配符证书，按通配符提醒续期覆盖面
  const subject = cert.subject || '';
  if (/CN=(\*\.)/.test(subject)) notes.push('这是通配符证书，续期后所有子域同时生效');

  return {
    available: true,
    path: p,
    subject: subject.replace(/\n/g, ', '),
    issuer: (cert.issuer || '').replace(/\n/g, ', '),
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    daysLeft,
    serialNumber: cert.serialNumber,
    fingerprint256: cert.fingerprint256,
    notes,
  };
}

// ══════════════════ 9. 配置读取（路径白名单）══════════════════
const CONFIG_WHITELIST = [
  /^\/etc\/nginx\//,
  /^\/etc\/apache2\//,
  /^\/etc\/httpd\//,
  /^\/etc\/systemd\/system\/[^/]+\.(service|timer|socket|target|mount)$/,
  /^\/etc\/ssh\/sshd_config$/,
  /^\/etc\/my\.cnf$/,
  /^\/etc\/mysql\//,
  /^\/etc\/postgresql\//,
  /^\/etc\/redis(\.conf)?\//,
  /^\/etc\/redis\.conf$/,
  /^\/etc\/sysctl\.conf$/,
  /^\/etc\/security\/limits\.conf$/,
  /^\/etc\/logrotate\.d\/[^/]+$/,
  /^\/etc\/crontab$/,
  /^\/etc\/fstab$/,
  /^\/etc\/hosts$/,
  /^\/etc\/resolv\.conf$/,
];

function configRead(opts = {}) {
  const p = String(opts.path || '');
  if (!p) return { available: false, reason: '必须给 path' };
  if (!path.isAbsolute(p)) return { available: false, reason: 'path 必须是绝对路径' };
  if (p.includes('..')) return { available: false, reason: 'path 不允许包含 ..' };
  if (!CONFIG_WHITELIST.some((re) => re.test(p))) {
    return {
      available: false,
      reason: `不在配置白名单内：${p}`,
      hint: '允许的目录：/etc/nginx、/etc/apache2、/etc/httpd、/etc/systemd/system/*.service、/etc/ssh/sshd_config、mysql、postgresql、redis、sysctl.conf、limits.conf、crontab、fstab、hosts、resolv.conf',
    };
  }

  const c = readFileSafe(p, 256 * 1024);
  if (c === null) return { available: false, reason: '读不到（文件不存在或无权限）' };

  const lines = c.split('\n');
  const grep = opts.grep ? String(opts.grep).toLowerCase() : null;
  const maxLines = Math.min(Number(opts.lines) || 200, 1000);

  let picked = lines;
  if (grep) {
    picked = lines
      .map((l, i) => ({ l, i }))
      .filter((o) => o.l.toLowerCase().includes(grep))
      .map((o) => `${o.i + 1}: ${o.l}`);
  } else {
    // 默认去掉纯注释与空行（配置排查看的是生效行）
    picked = lines
      .map((l, i) => ({ l, i }))
      .filter((o) => o.l.trim() && !/^\s*[#;]/.test(o.l))
      .map((o) => `${o.i + 1}: ${o.l}`);
  }

  return {
    available: true,
    path: p,
    totalLines: lines.length,
    matched: picked.length,
    truncated: picked.length > maxLines,
    lines: picked.slice(0, maxLines),
    note: '行号对应原文件；默认只显示生效行（去掉注释与空行）。要看特定项传 grep。',
  };
}

module.exports = {
  metrics,
  recentChanges,
  procList,
  procDetail,
  netStat,
  svcStatus,
  fileHash,
  pkgHistory,
  certCheck,
  configRead,
  CONFIG_WHITELIST,
  IS_LINUX,
  IS_MAC,
};

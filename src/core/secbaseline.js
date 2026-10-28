/**
 * 安全基线检查 —— 口令策略 / sudo / 暴露面 / SUID。
 *
 * 为什么单独一个模块：
 *   这是「安全运维」定位最贴合的一块，但它和「故障诊断」判据不同：
 *   故障看"有没有报错"，基线看"配置是否符合规范"。
 *   两者混在 diagnose.js 会让规则表臃肿，所以独立。
 *
 * 设计约束：
 *   1. **纯读**：只读文件，不执行任何命令（暴露面从 /proc/net 解析）
 *   2. **只报事实 + 规范要求**，不擅自改 —— 基线修复一律要人做
 *   3. **可降级**：读不到的文件标 skipped，不报错（权限不足很常见）
 *
 * 零副作用：本模块不写文件。
 */

'use strict';

const fs = require('node:fs');

/** 读文件，失败返回 null（权限不足是常态，不当作错误） */
function tryRead(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function finding(key, label, severity, detail, advice, evidence) {
  return { key, label, severity, category: 'baseline', detail, advice, evidence: evidence || [] };
}

/**
 * 口令策略检查。
 * 关注三件事：最短长度、是否强制复杂度、root 是否允许远程登录。
 */
function checkPasswordPolicy() {
  const out = [];
  const evidence = [];

  const loginDefs = tryRead('/etc/login.defs');
  if (loginDefs) {
    const m = /^\s*PASS_MIN_LEN\s+(\d+)/m.exec(loginDefs);
    const len = m ? Number(m[1]) : null;
    if (len !== null) {
      evidence.push(`/etc/login.defs: PASS_MIN_LEN ${len}`);
      if (len < 8) {
        out.push(finding(
          'pw-minlen',
          `口令最短长度过短（${len}）`,
          'medium',
          `PASS_MIN_LEN=${len}，低于等保要求的 8 位`,
          ['把 /etc/login.defs 的 PASS_MIN_LEN 改为 8 或更高', '同时检查 /etc/security/pwquality.conf 的 minlen'],
          [`/etc/login.defs: PASS_MIN_LEN ${len}`],
        ));
      }
    }
  } else {
    evidence.push('/etc/login.defs: 不可读或不存在');
  }

  // pwquality（RHEL 系）或 pam_pwquality（Debian 系）的 minlen
  const pwq = tryRead('/etc/security/pwquality.conf');
  if (pwq) {
    const m = /^\s*minlen\s*=\s*(\d+)/m.exec(pwq);
    if (m) {
      evidence.push(`/etc/security/pwquality.conf: minlen=${m[1]}`);
      if (Number(m[1]) < 8) {
        out.push(finding(
          'pw-quality-minlen',
          `口令复杂度要求过低（minlen=${m[1]}）`,
          'medium',
          'pwquality 的 minlen 低于 8',
          ['调整 /etc/security/pwquality.conf 的 minlen / dcredit / ucredit 等'],
          [`/etc/security/pwquality.conf: minlen=${m[1]}`],
        ));
      }
    }
  }

  // 空密码账户（/etc/shadow 第二字段为空）—— 这是严重问题
  const shadow = tryRead('/etc/shadow');
  if (shadow) {
    const empties = [];
    for (const line of shadow.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split(':');
      if (parts.length < 2) continue;
      const [user, pwd] = parts;
      if (pwd === '') empties.push(user);
    }
    if (empties.length) {
      out.push(finding(
        'pw-empty',
        `存在空密码账户（${empties.length} 个）`,
        'critical',
        `空口令账户可直接登录：${empties.join(', ')}`,
        ['立即为这些账户设置口令，或锁定（usermod -L）', '确认这些账户是否还需要保留'],
        empties.slice(0, 10).map((u) => `/etc/shadow: ${u} 口令为空`),
      ));
    } else {
      evidence.push('/etc/shadow: 无空口令账户');
    }
  } else {
    evidence.push('/etc/shadow: 不可读（需 root）');
  }

  return { findings: out, evidence };
}

/** SSH 配置检查：root 登录、密码认证 */
function checkSshConfig() {
  const out = [];
  const evidence = [];
  const conf = tryRead('/etc/ssh/sshd_config');
  if (!conf) {
    return { findings: out, evidence: ['/etc/ssh/sshd_config: 不可读或不存在（可能非 OpenSSH）'] };
  }

  const get = (k) => {
    const m = new RegExp(`^\\s*${k}\\s+(\\S+)`, 'im').exec(conf);
    return m ? m[1].toLowerCase() : null;
  };

  const rootLogin = get('PermitRootLogin');
  const pwdAuth = get('PasswordAuthentication');

  evidence.push(`sshd_config: PermitRootLogin ${rootLogin ?? '(未显式配置)'}`);
  evidence.push(`sshd_config: PasswordAuthentication ${pwdAuth ?? '(未显式配置)'}`);

  if (rootLogin === 'yes') {
    out.push(finding(
      'ssh-root-login',
      'SSH 允许 root 直接登录',
      'high',
      'PermitRootLogin yes',
      ['改为 PermitRootLogin no（用普通账户 + sudo）', '改完 sshd -t 校验再 reload'],
      ['/etc/ssh/sshd_config: PermitRootLogin yes'],
    ));
  }
  if (pwdAuth === 'yes') {
    out.push(finding(
      'ssh-password-auth',
      'SSH 允许密码认证（易被暴力破解）',
      'medium',
      'PasswordAuthentication yes',
      ['改用密钥认证：PasswordAuthentication no', '改前确认所有运维人员已配置密钥，否则会锁死'],
      ['/etc/ssh/sshd_config: PasswordAuthentication yes'],
    ));
  }

  return { findings: out, evidence };
}

/** sudo 配置：NOPASSWD 与宽泛授权 */
function checkSudo() {
  const out = [];
  const evidence = [];

  const files = ['/etc/sudoers', ...listSudoersD()];
  let nopasswd = [];
  let allAll = [];

  for (const f of files) {
    const c = tryRead(f);
    if (!c) continue;
    for (const line of c.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (/NOPASSWD/i.test(t)) nopasswd.push(`${f}: ${t}`);
      // 匹配 "xxx ALL=(ALL) ALL" 这类全权授权
      if (/^\S+\s+ALL\s*=\s*\(ALL(:ALL)?\)\s*ALL/i.test(t)) allAll.push(`${f}: ${t}`);
    }
  }

  if (nopasswd.length) {
    out.push(finding(
      'sudo-nopasswd',
      `存在免密 sudo 规则（${nopasswd.length} 条）`,
      'high',
      '持有这些规则的用户执行任意命令无需二次确认，一旦账户被盗即等于 root',
      ['逐条确认必要性，去掉 NOPASSWD', '确实需要免密的（如自动化账户）限定到具体命令，不要 ALL'],
      nopasswd.slice(0, 5),
    ));
  }
  if (allAll.length > 3) {
    out.push(finding(
      'sudo-all',
      `全权 sudo 授权偏多（${allAll.length} 条）`,
      'medium',
      '过多账户拥有 (ALL) ALL 权限，不符合最小权限原则',
      ['按角色收敛到具体命令', '定期复核 sudo 授权清单'],
      allAll.slice(0, 5),
    ));
  }

  evidence.push(`sudo: 检查了 ${files.length} 个文件，免密 ${nopasswd.length} 条，全权 ${allAll.length} 条`);
  return { findings: out, evidence };
}

function listSudoersD() {
  const out = [];
  try {
    for (const f of fs.readdirSync('/etc/sudoers.d')) {
      if (f.includes('.') && !f.endsWith('.conf')) continue; // 跳过备份/临时文件
      out.push(`/etc/sudoers.d/${f}`);
    }
  } catch { /* 目录不存在 */ }
  return out;
}

/**
 * 暴露面：解析 /proc/net/tcp 与 tcp6，找监听在 0.0.0.0 / :: 的端口。
 * 不用 ss —— 避免子进程，且 /proc 是内核直接给的真相。
 */
function checkExposure() {
  const out = [];
  const evidence = [];
  const listen = new Map(); // port -> {v4:bool, v6:bool}

  for (const [file, fam] of [['/proc/net/tcp', 'v4'], ['/proc/net/tcp6', 'v6']]) {
    const c = tryRead(file);
    if (!c) continue;
    for (const line of c.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const local = cols[1];
      const state = cols[3];
      if (state !== '0A') continue; // 0A = LISTEN
      const [addrHex, portHex] = local.split(':');
      if (!portHex) continue;
      const port = parseInt(portHex, 16);
      const wildcard = fam === 'v4'
        ? addrHex === '00000000'
        : /^0{32}$/.test(addrHex);
      if (!wildcard) continue;
      const cur = listen.get(port) || { v4: false, v6: false };
      cur[fam] = true;
      listen.set(port, cur);
    }
  }

  if (listen.size) {
    const ports = [...listen.keys()].sort((a, b) => a - b);
    evidence.push(`监听在通配地址的端口：${ports.join(', ')}`);
    // 高危端口：数据库、缓存、管理面
    const risky = ports.filter((p) => [3306, 5432, 6379, 27017, 9200, 11211, 2375, 2376].includes(p));
    if (risky.length) {
      out.push(finding(
        'expose-db',
        `数据库/缓存端口对外暴露（${risky.join(', ')}）`,
        'critical',
        '这些端口监听在 0.0.0.0/::，任何能访问本机网络的人都可尝试连接',
        ['改为只监听 127.0.0.1 或内网地址', '确认防火墙是否限制来源', '核对是否有口令且非弱口令'],
        [`/proc/net/tcp: 监听通配地址的端口 ${risky.join(', ')}`],
      ));
    }
    const otherRisky = ports.filter((p) => ![22, 80, 443].includes(p) && !risky.includes(p));
    if (otherRisky.length > 5) {
      out.push(finding(
        'expose-many',
        `对外监听端口偏多（${otherRisky.length} 个）`,
        'medium',
        `除 22/80/443 外还有 ${otherRisky.length} 个端口监听在通配地址`,
        ['逐个确认是否为业务必需', '关闭不必要的对外监听，或限制到内网地址'],
        [`/proc/net/tcp: ${otherRisky.slice(0, 15).join(', ')}`],
      ));
    }
  } else {
    evidence.push('未发现监听在通配地址的端口（或 /proc/net 不可读）');
  }

  return { findings: out, evidence };
}

/**
 * SUID 文件扫描。
 * 只扫常见 bin 目录（全盘扫太慢），并与常见合法清单对比。
 */
function checkSuid() {
  const out = [];
  const evidence = [];
  const dirs = ['/usr/bin', '/usr/sbin', '/bin', '/sbin', '/usr/local/bin', '/usr/local/sbin'];

  // 常见合法 SUID（不报警）
  const KNOWN = new Set([
    'sudo', 'su', 'passwd', 'chsh', 'chfn', 'gpasswd', 'newgrp', 'mount', 'umount',
    'ping', 'ping6', 'traceroute', 'pkexec', 'fusermount', 'fusermount3',
    'crontab', 'at', 'ssh-agent', 'snap-confine', 'ntfs-3g', 'exim4',
  ]);

  const found = [];
  for (const d of dirs) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = `${d}/${e.name}`;
      try {
        const st = fs.statSync(full);
        if (!(st.mode & 0o4000)) continue;
        found.push({ path: full, name: e.name });
      } catch { /* ignore */ }
    }
  }

  if (!found.length) {
    evidence.push('未在常见目录发现 SUID 文件（或目录不可读）');
    return { findings: out, evidence };
  }

  const unknown = found.filter((f) => !KNOWN.has(f.name));
  evidence.push(`SUID 文件 ${found.length} 个，其中非典型 ${unknown.length} 个`);
  if (unknown.length) {
    out.push(finding(
      'suid-unknown',
      `发现非典型 SUID 文件（${unknown.length} 个）`,
      'medium',
      'SUID 文件以文件属主权限运行，被替换即等于提权后门；非典型项需逐一确认来源',
      ['逐个确认这些文件属于哪个软件包（rpm -qf / dpkg -S）', '来源不明的立即排查并移除 SUID 位'],
      unknown.slice(0, 12).map((f) => f.path),
    ));
  }

  return { findings: out, evidence };
}

/**
 * 跑全部基线检查。
 * @returns {{findings: object[], evidence: string[], checked: string[]}}
 */
function runBaseline() {
  const parts = [
    ['口令策略', checkPasswordPolicy],
    ['SSH 配置', checkSshConfig],
    ['sudo 授权', checkSudo],
    ['暴露面', checkExposure],
    ['SUID', checkSuid],
  ];

  const findings = [];
  const evidence = [];
  const checked = [];

  for (const [name, fn] of parts) {
    try {
      const r = fn();
      findings.push(...r.findings);
      evidence.push(...r.evidence);
      checked.push(name);
    } catch (e) {
      evidence.push(`${name}: 检查异常 ${e.message}`);
    }
  }

  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return { findings, evidence, checked };
}

module.exports = { runBaseline, checkPasswordPolicy, checkSshConfig, checkSudo, checkExposure, checkSuid };

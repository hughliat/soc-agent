/**
 * 最小 SMTP 客户端 —— 让诊断报告能直接发出去，不用手工拷贝。
 *
 * 为什么自己写：本产品坚持零第三方依赖（内网审计要求可枚举依赖面）。
 * 只用 node:net / node:tls / node:crypto 实现够用的子集。
 *
 * 支持的路径（覆盖绝大多数内网邮件网关）：
 *   · 465 端口 直连 TLS（implicit TLS）
 *   · 587 / 25 端口 STARTTLS 升级
 *   · AUTH LOGIN（最常见的认证方式）
 *   · 可选跳过证书校验（内网自签证书场景，需显式开启）
 *
 * 明确不支持（也就不假装支持）：
 *   · AUTH PLAIN / CRAM-MD5（少数网关要，遇到会明确报错）
 *   · 附件（报告走正文，不发送本地文件 —— 避免变成任意文件外发通道）
 *   · 多收件人群发中的部分失败重试
 *
 * 安全约束：
 *   · 收件人必须先过白名单（在工具层做，此处只负责发）
 *   · 正文只允许文本/HTML，且大小有上限
 *   · 不读取任何本地文件作为附件
 *
 * 零副作用：本模块不写文件。
 */

'use strict';

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

/** 单次会话超时（毫秒）—— 防止卡在坏网关上半分钟 */
const SESSION_TIMEOUT = 20000;
/** 正文上限 512 KB —— 报告不该更大；超了说明在夹带别的东西 */
const MAX_BODY = 512 * 1024;

/**
 * 极简 SMTP 会话：按行读写 + 期待指定响应码。
 */
class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    this.closed = false;
    this.error = null;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      this._drain();
    });
    socket.on('error', (e) => {
      this.error = e;
      this._drain();
    });
    socket.on('close', () => {
      this.closed = true;
      this._drain();
    });
  }

  _drain() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      // 多行响应：以 "250-" 续行，以 "250 " 结束
      const lines = this.buffer.split('\r\n');
      let endIdx = -1;
      for (let i = 0; i < lines.length - 1; i++) {
        const l = lines[i];
        if (/^\d{3} /.test(l)) { endIdx = i; break; }
        if (/^\d{3}-/.test(l)) continue;
        // 非标准行，跳过
      }
      if (endIdx < 0) {
        if (this.error) { this.waiters.shift(); w.reject(this.error); continue; }
        if (this.closed) { this.waiters.shift(); w.reject(new Error('SMTP 连接已关闭')); continue; }
        return;
      }
      const consumed = lines.slice(0, endIdx + 1).join('\r\n') + '\r\n';
      this.buffer = this.buffer.slice(consumed.length);
      const last = lines[endIdx];
      const code = parseInt(last.slice(0, 3), 10);
      this.waiters.shift();
      w.resolve({ code, text: lines.slice(0, endIdx + 1).join('\n') });
    }
  }

  read() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this._drain();
    });
  }

  write(line) {
    this.socket.write(line + '\r\n');
  }

  async expect(codes, cmd, label) {
    if (cmd !== undefined) this.write(cmd);
    const r = await this.read();
    const list = Array.isArray(codes) ? codes : [codes];
    if (!list.includes(r.code)) {
      throw new Error(`${label || cmd || 'SMTP'} 失败：期望 ${list.join('/')}，实际 ${r.code} ${r.text.split('\n').pop()}`);
    }
    return r;
  }

  async quit() {
    try {
      this.write('QUIT');
      this.socket.end();
    } catch { /* 忽略关闭期错误 */ }
  }
}

function connectPlain(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port });
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`连接 ${host}:${port} 超时`)); }, SESSION_TIMEOUT);
    s.once('connect', () => { clearTimeout(timer); resolve(s); });
    s.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function connectTls(host, port, opts) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({
      host, port,
      servername: host,
      rejectUnauthorized: opts.rejectUnauthorized !== false,
    });
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`TLS 连接 ${host}:${port} 超时`)); }, SESSION_TIMEOUT);
    s.once('secureConnect', () => { clearTimeout(timer); resolve(s); });
    s.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function upgradeTls(socket, host, opts) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({
      socket,
      servername: host,
      rejectUnauthorized: opts.rejectUnauthorized !== false,
    });
    s.once('secureConnect', () => resolve(s));
    s.once('error', reject);
  });
}

/**
 * 发送一封纯文本/HTML 邮件。
 *
 * @param {object} cfg {host, port, secure, user, pass, from, rejectUnauthorized}
 * @param {object} mail {to: string[], subject: string, text: string, html?: string}
 * @returns {Promise<{messageId: string, accepted: string[]}>}
 */
async function sendMail(cfg, mail) {
  if (!cfg || !cfg.host) throw new Error('SMTP 未配置（缺少 host）');
  if (!cfg.from) throw new Error('SMTP 未配置（缺少发件人 from）');
  const to = (mail.to || []).filter(Boolean);
  if (!to.length) throw new Error('没有收件人');

  const text = String(mail.text || '');
  if (Buffer.byteLength(text) > MAX_BODY) {
    throw new Error(`正文过大（${Math.round(Buffer.byteLength(text) / 1024)} KB），上限 ${MAX_BODY / 1024} KB`);
  }

  const port = cfg.port || (cfg.secure ? 465 : 587);
  const secure = cfg.secure !== false && port === 465;

  let socket = secure
    ? await connectTls(cfg.host, port, cfg)
    : await connectPlain(cfg.host, port);

  let sess = new SmtpSession(socket);
  try {
    await sess.expect(220, undefined, '服务端握手');

    const hostname = require('node:os').hostname() || 'localhost';
    await sess.expect(250, `EHLO ${hostname}`, 'EHLO');

    // 587/25 通常要求 STARTTLS；服务端不支持就继续明文（内网常见）
    if (!secure) {
      try {
        const r = await sess.expect(250, 'STARTTLS', 'STARTTLS');
        if (r.code === 250) {
          socket = await upgradeTls(socket, cfg.host, cfg);
          sess = new SmtpSession(socket);
          await sess.expect(250, `EHLO ${hostname}`, 'EHLO(TLS)');
        }
      } catch {
        // 不支持 STARTTLS：继续明文。内网邮件中继常见，不做强制。
      }
    }

    if (cfg.user) {
      await sess.expect(334, 'AUTH LOGIN', 'AUTH LOGIN');
      await sess.expect(334, Buffer.from(cfg.user, 'utf8').toString('base64'), 'AUTH 用户名');
      await sess.expect(235, Buffer.from(cfg.pass || '', 'utf8').toString('base64'), 'AUTH 密码');
    }

    await sess.expect(250, `MAIL FROM:<${cfg.from}>`, 'MAIL FROM');
    for (const rcpt of to) {
      await sess.expect([250, 251], `RCPT TO:<${rcpt}>`, `RCPT TO <${rcpt}>`);
    }

    await sess.expect(354, 'DATA', 'DATA');

    const messageId = `<${crypto.randomUUID()}@soc-agent>`;
    const date = new Date().toUTCString();
    const headers = [
      `From: ${cfg.from}`,
      `To: ${to.join(', ')}`,
      `Subject: ${encodeHeader(mail.subject || '(无主题)')}`,
      `Date: ${date}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ].join('\r\n');

    // 正文用 base64，彻底规避点号开头、长行、8bit 编码问题
    const bodyB64 = wrap76(Buffer.from(text, 'utf8').toString('base64'));
    sess.write(headers + '\r\n\r\n' + bodyB64 + '\r\n.');
    await sess.expect(250, undefined, 'DATA 结束');

    await sess.quit();
    return { messageId, accepted: to };
  } catch (e) {
    try { socket.destroy(); } catch { /* ignore */ }
    throw e;
  }
}

/** RFC 2047 编码非 ASCII 主题 */
function encodeHeader(s) {
  return /^[\x20-\x7E]*$/.test(s)
    ? s
    : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** base64 每 76 字符换行（RFC 2045） */
function wrap76(b64) {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

/**
 * 从环境变量读 SMTP 配置。缺项返回 null（由调用方决定怎么提示）。
 * @returns {object|null}
 */
function smtpConfigFromEnv(env = process.env) {
  const host = env.SOC_SMTP_HOST;
  const from = env.SOC_SMTP_FROM;
  if (!host || !from) return null;
  return {
    host,
    port: env.SOC_SMTP_PORT ? Number(env.SOC_SMTP_PORT) : undefined,
    secure: env.SOC_SMTP_SECURE !== '0',
    user: env.SOC_SMTP_USER,
    pass: env.SOC_SMTP_PASS,
    from,
    rejectUnauthorized: env.SOC_SMTP_INSECURE !== '1',
  };
}

/**
 * 收件人白名单。未配置 = 全部拒绝（安全默认）。
 * @returns {string[]}
 */
function mailAllowlistFromEnv(env = process.env) {
  return String(env.SOC_MAIL_ALLOWLIST || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

module.exports = {
  sendMail,
  smtpConfigFromEnv,
  mailAllowlistFromEnv,
  encodeHeader,
  MAX_BODY,
};

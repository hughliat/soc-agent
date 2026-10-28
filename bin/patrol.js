#!/usr/bin/env node
/**
 * 定时巡检 —— 有故障发告警，没故障发日报。
 *
 * 设计要点：
 *   1. **不依赖 agent**：直接调用 core 的 diagnose / mailer，不经过模型。
 *      这样 cron 里跑不需要模型可用，也不会烧 token。
 *   2. **判定在前**：先跑确定性规则，命中 critical/high 才算"有故障"。
 *   3. **模板可改**：日报与告警各一份模板，用户自己编辑，改完立即生效。
 *   4. **收件人固定**：从配置读，不接受运行时参数 —— 防止被利用成外发通道。
 *   5. **幂等留痕**：每次巡检写一条审计，可回溯"什么时候报过什么"。
 *
 * 用法：
 *   node patrol.js --mode alert   # 故障巡检：只在命中故障时发告警（建议 30 分钟一次）
 *   node patrol.js --mode daily   # 日报：无论有无故障都发（建议每天一次）
 *   node patrol.js --dry-run      # 只打印报告，不发邮件
 *   node patrol.js --init         # 生成默认配置与模板
 *
 * 退出码：0 正常（无论有无故障）/ 1 巡检本身失败（读不到日志、发信失败等）
 */

'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// core 是 CommonJS（见 src/core/package.json），ESM 里用 createRequire 载入
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const diagnose = require('../src/core/diagnose.js');
const logdiscover = require('../src/core/logdiscover.js');
const mailer = require('../src/core/mailer.js');
const auditMod = require('../src/core/audit.js');

const __filename = fileURLToPath(import.meta.url);

const HOME = process.env.SOC_AGENT_HOME || path.join(os.homedir(), '.dsh', 'soc-agent');
const CONFIG_DIR = path.join(HOME, 'config');
const TEMPLATE_DIR = path.join(CONFIG_DIR, 'templates');
const CONFIG_FILE = path.join(CONFIG_DIR, 'patrol.json');

/** 默认配置：收件人留空，必须由运维填 —— 空着就不发，不是静默失败 */
const DEFAULT_CONFIG = {
  _说明: '收件人固定写死在这里，脚本不接受命令行指定收件人。改完无需重启，下次巡检即生效。',
  recipients: [],
  severityThreshold: 'high',
  scan: { sinceHours: 24, maxFiles: 15, linesPerFile: 300 },
  sendDailyEvenIfHealthy: true,
  templates: { alert: 'alert.md.tpl', daily: 'daily.md.tpl' },
};

const DEFAULT_ALERT_TPL = `【故障告警】{{hostname}} — {{topLabel}}

主机：{{hostname}}
时间：{{time}}
级别：{{topSeverity}}
命中：{{summary}}

── 问题清单 ──
{{findings}}

── 说明 ──
本邮件由安全运维智能体自动发出，判定依据为内置故障规则库。
处置建议见每条问题下的「措施」。本工具只读，不会自动修复。

扫描范围：{{scanned}}（近 {{sinceHours}} 小时）
`;

const DEFAULT_DAILY_TPL = `【巡检日报】{{hostname}} — {{date}}

主机：{{hostname}}
时间：{{time}}
结果：{{summary}}

── 巡检范围 ──
扫描日志：{{scanned}}
覆盖时段：近 {{sinceHours}} 小时
{{healthyLine}}

── 明细 ──
{{findings}}

── 提示 ──
本邮件为定时巡检输出。需要深入分析时，登录主机执行 soc 与智能体对话。
`;

function ensureInit() {
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { mode: 0o600 });
    console.log(`已生成配置：${CONFIG_FILE}`);
  }
  const tpls = { 'alert.md.tpl': DEFAULT_ALERT_TPL, 'daily.md.tpl': DEFAULT_DAILY_TPL };
  for (const [name, body] of Object.entries(tpls)) {
    const p = path.join(TEMPLATE_DIR, name);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, body, { mode: 0o600 });
      console.log(`已生成模板：${p}`);
    }
  }
  console.log('\n下一步：编辑配置填 recipients（收件人），然后 node patrol.js --dry-run 试跑。');
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`缺少配置：${CONFIG_FILE}\n先跑：node ${__filename} --init`);
    process.exit(1);
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch (e) {
    console.error(`配置解析失败：${e.message}`);
    process.exit(1);
  }
}

function loadTemplate(name) {
  const p = path.join(TEMPLATE_DIR, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/** 极简模板渲染：只支持 {{key}} 单层替换，不做表达式 —— 够用且没有注入面 */
function render(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function formatFindings(findings) {
  if (!findings.length) return '无需处理的问题。';
  return findings
    .map((f, i) => {
      const ev = (f.samples || []).slice(0, 2).map((s) => `      行${s.line}: ${String(s.text).slice(0, 140)}`).join('\n');
      const rem = (f.remedy || []).map((r, j) => `      ${j + 1}. ${r}`).join('\n');
      return [
        `${i + 1}. 〔${f.severity}〕${f.label}  × ${f.count}`,
        `   来源：${(f.sources || [f.path]).filter(Boolean).join(', ')}`,
        ev ? `   证据：\n${ev}` : '',
        rem ? `   措施：\n${rem}` : '',
        f.verify ? `   验收：${f.verify}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/** 跑一次扫描 + 诊断 */
function runScan(cfg) {
  const cutoff = Date.now() - (cfg.scan.sinceHours || 24) * 3600 * 1000;
  const found = logdiscover.discoverLogs({ maxFiles: 400 });
  const candidates = found.files.filter((f) => f.mtime >= cutoff).sort((a, b) => b.mtime - a.mtime);
  const picked = candidates.slice(0, cfg.scan.maxFiles || 15);

  const all = [];
  let lines = 0;
  const scannedPaths = [];
  for (const f of picked) {
    try {
      const r = logdiscover.readTail(f.path, { lines: cfg.scan.linesPerFile || 300 });
      if (!r.lines.length) continue;
      lines += r.lines.length;
      scannedPaths.push(f.path);
      all.push(...diagnose.diagnose(r.lines, { path: f.path }).findings);
    } catch { /* 单个文件失败不影响整体 */ }
  }

  // 合并同类
  const merged = new Map();
  for (const f of all) {
    const cur = merged.get(f.key);
    if (cur) {
      cur.count += f.count;
      cur.sources = [...(cur.sources || []), f.path];
      for (const s of f.samples) if (cur.samples.length < 5) cur.samples.push(s);
    } else {
      merged.set(f.key, { ...f, sources: [f.path] });
    }
  }
  const findings = [...merged.values()].sort(
    (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count
  );

  return { findings, scannedLines: lines, scannedFiles: picked.length, scannedPaths };
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--init')) {
    ensureInit();
    return 0;
  }

  const dryRun = args.includes('--dry-run');
  // mode 决定「什么时候发」：
  //   alert —— 只在命中故障时发（高频巡检用，避免每分钟刷邮件）
  //   daily —— 无论有无故障都发（日报用）
  const mi = args.indexOf('--mode');
  const mode = mi >= 0 ? (args[mi + 1] || 'alert') : 'alert';
  if (!['alert', 'daily'].includes(mode)) {
    console.error(`未知 mode：${mode}（只支持 alert / daily）`);
    return 2;
  }
  const cfg = loadConfig();

  // 日志
  const scan = runScan(cfg);
  const threshold = SEV_RANK[cfg.severityThreshold] ?? 1;
  const alerting = scan.findings.filter((f) => SEV_RANK[f.severity] <= threshold);
  const top = scan.findings[0];

  const now = new Date();
  const vars = {
    hostname: os.hostname(),
    date: now.toISOString().slice(0, 10),
    time: now.toLocaleString('zh-CN'),
    sinceHours: cfg.scan.sinceHours,
    scanned: `${scan.scannedFiles} 个日志 / ${scan.scannedLines} 行`,
    summary: diagnose.summarizeDiagnosis(scan.findings),
    findings: formatFindings(scan.findings),
    topLabel: top ? top.label : '无',
    topSeverity: top ? top.severity : '—',
    healthyLine: scan.findings.length ? '' : '本次巡检未命中已知故障模式。',
  };

  const isAlert = alerting.length > 0;
  // 有故障 → 告警模板（不管哪个模式，故障要醒目）
  // 无故障 + daily → 日报模板
  const tplName = isAlert ? cfg.templates.alert : cfg.templates.daily;

  // alert 模式：健康就静默（高频任务不能每次都发）
  // daily 模式：总是发；但如果配了 sendDailyEvenIfHealthy:false 且健康，也可以静默
  if (!isAlert) {
    if (mode === 'alert') {
      console.log('巡检通过，无故障，alert 模式不发送。');
      return 0;
    }
    if (cfg.sendDailyEvenIfHealthy === false) {
      console.log('巡检通过，按配置不发日报。');
      return 0;
    }
  }

  let tpl = loadTemplate(tplName);
  if (!tpl) {
    console.error(`模板缺失：${path.join(TEMPLATE_DIR, tplName)}`);
    return 1;
  }
  const body = render(tpl, vars);
  const subject = isAlert
    ? `【故障告警】${vars.hostname} — ${vars.topLabel}`
    : `【巡检日报】${vars.hostname} — ${vars.date}`;

  // 打印（dry-run 或交互都能看）
  if (dryRun) {
    console.log(`── 主题 ──\n${subject}\n\n── 正文 ──\n${body}`);
    console.log(`\n[dry-run] 未发送。收件人配置：${(cfg.recipients || []).join(', ') || '（未配置，实跑会被拒）'}`);
    return 0;
  }

  // 发信
  if (!cfg.recipients || !cfg.recipients.length) {
    console.error('未配置收件人（patrol.json → recipients），拒绝发送。这是安全默认，不是故障。');
    return 1;
  }
  const smtp = mailer.smtpConfigFromEnv();
  if (!smtp) {
    console.error('SMTP 未配置：需要 SOC_SMTP_HOST / SOC_SMTP_FROM 等环境变量');
    return 1;
  }

  // 走同一份白名单：配置文件里的收件人也必须在白名单内
  const allow = mailer.mailAllowlistFromEnv();
  if (allow.length) {
    const bad = cfg.recipients.filter((r) => !allow.includes(String(r).toLowerCase()));
    if (bad.length) {
      console.error(`收件人不在白名单：${bad.join(', ')}`);
      return 1;
    }
  }

  mailer.sendMail(smtp, { to: cfg.recipients, subject, text: body })
    .then((r) => {
      console.log(`已发送：${subject} → ${r.accepted.join(', ')}`);
      try {
        const audit = auditMod.createAudit({
          sink: auditMod.fileAuditSink(path.join(HOME, 'audit')),
          user: `patrol:${os.userInfo().username}`,
        });
        audit.append({
          question: subject,
          toolCalls: [{ tool: 'patrol', args: { alert: isAlert, findings: scan.findings.length }, eventIds: [], at: Date.now() }],
          referencedEventIds: scan.scannedPaths.slice(0, 20),
          verdictRefs: scan.findings.map((f) => f.key),
          note: isAlert ? 'patrol-alert' : 'patrol-daily',
        });
      } catch (e) {
        console.error(`审计写入失败：${e.message}`);
      }
      process.exitCode = 0;
    })
    .catch((e) => {
      console.error(`发送失败：${e.message}`);
      process.exitCode = 1;
    });

  return null; // 异步进行中，退出码由 promise 决定
}

const rc = main();
if (typeof rc === 'number') process.exit(rc);

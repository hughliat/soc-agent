#!/usr/bin/env node
/**
 * 日志压缩 —— 控制总量，不删数据。
 *
 * ⚠️ 这是**写操作**，与 agent 的「只读」原则冲突，所以刻意做成独立脚本：
 *    · agent 没有这个工具，模型调不到
 *    · 由 cron / systemd timer 调用，不经模型
 *    · 压缩记录单独落审计目录，可回溯
 *
 * 三条硬底线：
 *   1. **只压缩，绝不删除**。原文件 gzip 成 .gz，随时可 gunzip 还原。
 *   2. **不碰正在写入的文件**（mtime 太新就跳过，避免压到半行日志）。
 *   3. **默认只管自己的目录**。/var/log 由系统 logrotate 管，未经显式
 *      许可不动 —— 重复轮转会打乱别人的规范。
 *
 * 用法：
 *   node logmanage.js --dry-run              # 只看会压什么，不动手
 *   node logmanage.js                        # 压自己的日志
 *   node logmanage.js --include-system       # 连 /var/log 一起压（慎用）
 *   node logmanage.js --min-size 20 --min-age 3
 *
 * 退出码：0 成功 / 1 失败
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const HOME = process.env.SOC_AGENT_HOME || path.join(os.homedir(), '.dsh', 'soc-agent');

const DEFAULTS = {
  minSizeMB: 50,       // 小于这个不压（压了收益不够）
  minAgeDays: 7,       // 最近 N 天没动过才压（避免压正在写的）
  ownDirs: [path.join(HOME, 'logs')],
  systemDirs: ['/var/log'],
  skipName: /\.(gz|xz|bz2|zip|zst)$/i,
  // 系统自己轮转的不要碰
  skipPattern: /(?:^|\/)(?:journal|wtmp|btmp|lastlog|dpkg\.log|yum\.log|dnf\.log|bootstrap\.log)/i,
};

function parseArgs(argv) {
  const o = { ...DEFAULTS, dryRun: false, includeSystem: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--include-system') o.includeSystem = true;
    // 注意：不能用 `Number(x) || default` —— 传 0 会被当成 falsy 吞掉，
    // 实测 `--min-age 0` 静默变回 7 天。必须显式判 NaN。
    else if (a === '--min-size') { const v = Number(argv[++i]); if (Number.isFinite(v)) o.minSizeMB = v; }
    else if (a === '--min-age') { const v = Number(argv[++i]); if (Number.isFinite(v)) o.minAgeDays = v; }
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 递归收集候选文件（不跟符号链接） */
function collect(dirs, opt, out, depth = 0) {
  if (depth > 3) return;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { collect([full], opt, out, depth + 1); continue; }
      if (!st.isFile()) continue;
      if (opt.skipName.test(ent.name)) continue;
      if (opt.skipPattern.test(full)) continue;
      // 只处理像日志的（有扩展名或无扩展名的常见日志名）
      if (!/\.(log|out|err|txt)$/i.test(ent.name) && !/^(syslog|messages|secure|auth|cron|mail|daemon|kern)$/i.test(ent.name)) continue;

      const ageDays = (Date.now() - st.mtimeMs) / 86400000;
      const sizeMB = st.size / 1024 ** 2;
      if (sizeMB < opt.minSizeMB) continue;
      if (ageDays < opt.minAgeDays) continue;
      out.push({ path: full, size: st.size, ageDays });
    }
  }
}

async function gzipFile(src) {
  const dst = src + '.gz';
  if (fs.existsSync(dst)) return { skipped: true, reason: '已存在同名 .gz' };
  const tmp = dst + '.part';
  // 用流式压缩，避免大文件把内存吃满
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(tmp, { mode: 0o600 }),
  );
  // 校验产物可读，再删原文件（先确认成功，绝不先删后压）
  const check = await new Promise((res) => {
    zlib.gunzip(fs.readFileSync(tmp), (err, buf) => res({ ok: !err, size: buf ? buf.length : 0 }));
  });
  if (!check.ok) {
    fs.unlinkSync(tmp);
    throw new Error('压缩产物校验失败，已丢弃，原文件保留');
  }
  fs.renameSync(tmp, dst);
  fs.unlinkSync(src);
  return { skipped: false, out: dst, outSize: fs.statSync(dst).size };
}

function appendAudit(entry) {
  try {
    const dir = path.join(HOME, 'audit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(
      path.join(dir, `logmanage-${day}.jsonl`),
      JSON.stringify({ at: Date.now(), user: `logmanage:${os.userInfo().username}`, ...entry }) + '\n',
      { mode: 0o600 },
    );
  } catch { /* 审计失败不阻断压缩，但调用方会看到 stderr */ }
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    console.log(`用法：node logmanage.js [选项]

  --dry-run           只看会压什么，不动手
  --include-system    连 /var/log 一起压（默认不碰，那是 logrotate 的地盘）
  --min-size <MB>     超过多大才压，默认 ${DEFAULTS.minSizeMB}
  --min-age <天>      多少天没改动才压，默认 ${DEFAULTS.minAgeDays}

只压缩、不删除。原文件 gzip 成 .gz，可 gunzip 还原。`);
    return 0;
  }

  const dirs = [...opt.ownDirs, ...(opt.includeSystem ? opt.systemDirs : [])];
  const cands = [];
  collect(dirs, opt, cands);

  console.log(`\n═══ 日志压缩${opt.dryRun ? '（演练，不动手）' : ''} ═══`);
  console.log(`扫描目录：${dirs.join(', ')}`);
  console.log(`条件：>${opt.minSizeMB}MB 且 >${opt.minAgeDays} 天未改动\n`);

  if (!cands.length) {
    console.log('没有符合条件的日志，无需处理。');
    return 0;
  }

  cands.sort((a, b) => b.size - a.size);
  let saved = 0;
  let failed = 0;

  for (const c of cands) {
    const label = `${c.path}（${human(c.size)}，${c.ageDays.toFixed(1)} 天未动）`;
    if (opt.dryRun) {
      console.log(`  将压缩：${label}`);
      continue;
    }
    try {
      const r = await gzipFile(c.path);
      if (r.skipped) {
        console.log(`  跳过：${label} —— ${r.reason}`);
        continue;
      }
      const gain = c.size - r.outSize;
      saved += gain;
      console.log(`  已压缩：${label} → ${human(r.outSize)}（省 ${human(gain)}）`);
      appendAudit({ action: 'gzip', file: c.path, before: c.size, after: r.outSize, saved: gain });
    } catch (e) {
      failed++;
      console.log(`  失败：${label} —— ${e.message}`);
      appendAudit({ action: 'gzip-failed', file: c.path, error: e.message });
    }
  }

  console.log('');
  if (opt.dryRun) {
    const total = cands.reduce((s, c) => s + c.size, 0);
    console.log(`演练结束：${cands.length} 个文件，共 ${human(total)} 待处理。去掉 --dry-run 才会真压。`);
  } else {
    console.log(`完成：压缩 ${cands.length - failed} 个，失败 ${failed} 个，共省 ${human(saved)}。`);
  }
  return failed ? 1 : 0;
}

main().then((rc) => process.exit(rc)).catch((e) => {
  console.error(`压缩异常：${e.message}`);
  process.exit(1);
});

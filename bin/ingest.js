#!/usr/bin/env node
/**
 * 日志入库 CLI —— 把安全日志解析成统一事件，写入本地只追加索引。
 *
 * 用法：
 *   node bin/ingest.js <文件或目录> [--source ansible|tianqing|onesec] [--auto] [--dry]
 *   node bin/ingest.js fixtures/            # 自动识别格式
 *   node bin/ingest.js /var/log/ansible.log --source ansible
 *
 * 只读源：本命令只读取日志文件，只写自有索引（~/.dsh/soc-agent/events）。
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ansible = require('../src/core/adapters/ansible.js');
const edr = require('../src/core/adapters/edr.js');
const storeMod = require('../src/core/store.js');

const ROOT = process.env.SOC_AGENT_HOME || join(homedir(), '.dsh', 'soc-agent');
const EVENTS_DIR = join(ROOT, 'events');
mkdirSync(EVENTS_DIR, { recursive: true, mode: 0o700 });

function parseArgs(argv) {
  const out = { paths: [], source: null, dry: false, auto: false, limit: 500000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') out.source = argv[++i];
    else if (a === '--dry') out.dry = true;
    else if (a === '--auto') out.auto = true;
    else if (a === '--limit') out.limit = Number(argv[++i]) || out.limit;
    else if (!a.startsWith('--')) out.paths.push(a);
  }
  return out;
}

/** 递归收集文件（跳过明显不是日志的） */
function collect(target) {
  const files = [];
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        walk(join(p, name));
      }
    } else if (st.isFile()) {
      if (/\.(log|txt|out|jsonl|json)$/i.test(p) || !p.includes('.')) files.push(p);
    }
  };
  walk(target);
  return files;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.paths.length) {
    console.error('用法: node bin/ingest.js <文件或目录> [--source ansible|tianqing|onesec] [--dry]');
    process.exit(2);
  }

  const store = storeMod.createStore({ sink: args.dry ? storeMod.memorySink() : storeMod.fileSink(EVENTS_DIR) });
  let totalParsed = 0, totalAdded = 0, totalSkipped = 0;
  const perFormat = {};

  for (const target of args.paths) {
    for (const file of collect(target)) {
      let text;
      try {
        const st = statSync(file);
        if (st.size > 200 * 1024 * 1024) { console.warn(`跳过超大文件（>200MB）：${file}`); continue; }
        text = readFileSync(file, 'utf8');
      } catch (e) { console.warn(`读不了 ${file}：${e.message}`); continue; }

      const lines = text.split(/\r?\n/);
      if (lines.length > args.limit) {
        console.warn(`${basename(file)} 超过 ${args.limit} 行，仅取前 ${args.limit} 行`);
        text = lines.slice(0, args.limit).join('\n');
      }

      let events = [];
      let fmt = 'unknown';
      if (args.source === 'tianqing' || args.source === 'onesec') {
        events = edr.parseWith(args.source, text, { path: file });
        fmt = args.source;
      } else if (args.source === 'ansible') {
        const r = ansible.parseText(text, { path: file });
        events = r.events; fmt = r.format;
      } else {
        // 自动：先试 Ansible 四格式，不认领再试 EDR
        const r = ansible.parseText(text, { path: file });
        if (!r.fallback) { events = r.events; fmt = r.format; }
        else {
          const tq = edr.parseWith('tianqing', text, { path: file });
          const os2 = edr.parseWith('onesec', text, { path: file });
          if (tq.length >= os2.length && tq.length) { events = tq; fmt = 'tianqing'; }
          else if (os2.length) { events = os2; fmt = 'onesec'; }
          else { events = r.events; fmt = r.format + '(兜底)'; }
        }
      }

      const res = store.append(events);
      totalParsed += events.length; totalAdded += res.added; totalSkipped += res.skipped;
      perFormat[fmt] = (perFormat[fmt] || 0) + events.length;

      console.log(`${basename(file)}  格式=${fmt}  解析=${events.length}  新增=${res.added}  跳过=${res.skipped}`);
    }
  }

  console.log('');
  console.log(`合计：解析 ${totalParsed} 条，新增 ${totalAdded} 条，跳过（重复）${totalSkipped} 条`);
  if (!args.dry) console.log(`索引目录：${EVENTS_DIR}`);
  else console.log('（--dry 模式：未写入任何文件）');
}

main();

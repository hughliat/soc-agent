#!/usr/bin/env node
/**
 * 文档一致性自检 —— 核对部署说明与代码是否漂移。
 *
 * 为什么需要：
 *   文档里的数字与名称是手写的，改代码不改文档就会漂移。
 *   本项目已经发生过三次：README 写"20 类故障"（实际 21）、
 *   部署说明里工具数写 12（实际 22）、版本号散落三个不同值。
 *   靠人记不住，必须用脚本算。
 *
 * 检查项：
 *   1. 章节编号连续（出现过「九 → 十一」缺十）
 *   2. 版本号唯一且等于 package.json
 *   3. 文档提到的工具名都在代码白名单内（且数量一致）
 *   4. 文档提到的命令都在命令白名单内
 *   5. 文档提到的环境变量都在代码里出现过
 *   6. HTML 基本结构（标签配平）
 *
 * 用法：node tools/check-docs.mjs
 * 退出码：0 通过 / 1 有偏差
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOC = path.join(ROOT, 'docs', '07-部署说明.html');

let fail = 0;
const ok = (m) => console.log(`  [PASS] ${m}`);
const bad = (m) => { console.log(`  [FAIL] ${m}`); fail++; };
const warn = (m) => console.log(`  [WARN] ${m}`);

if (!fs.existsSync(DOC)) {
  console.error('找不到部署说明：' + DOC);
  process.exit(2);
}
const doc = fs.readFileSync(DOC, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

console.log(`\n═══ 文档一致性自检 · ${path.basename(DOC)} ═══\n`);

// ── 1. 章节编号连续 ──
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五'];
const h2 = [...doc.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1].trim());
const nums = h2.map((t) => CN.findIndex((c) => t.startsWith(c + '、')));
let seqOk = true;
nums.forEach((n, i) => {
  if (n !== i) { seqOk = false; bad(`章节编号断档：第 ${i + 1} 个是「${h2[i]}」`); }
});
if (seqOk) ok(`章节编号连续（共 ${h2.length} 章）`);

// ── 2. 版本号唯一且正确 ──
// 只认「soc-agent-X.Y.Z」与「版本 X.Y.Z」两种写法；
// 升级示例里的 `upgrade.sh 0.14.0` 是 dsh-tui 的版本，不该算进来
const vers = [
  ...[...doc.matchAll(/soc-agent-(\d+\.\d+\.\d+)/g)].map((m) => m[1]),
  ...[...doc.matchAll(/版本\s+(\d+\.\d+\.\d+)/g)].map((m) => m[1]),
  ...[...doc.matchAll(/soc-agent v(\d+\.\d+\.\d+)/g)].map((m) => m[1]),
];
const uniq = [...new Set(vers)];
if (uniq.length === 1 && uniq[0] === pkg.version) {
  ok(`版本号统一：${pkg.version}（出现 ${vers.length} 次）`);
} else if (uniq.length === 1) {
  bad(`版本号与 package.json 不一致：文档 ${uniq[0]} / 实际 ${pkg.version}`);
} else if (uniq.length === 0) {
  warn('文档里没找到版本号');
} else {
  bad(`版本号混乱，出现 ${uniq.length} 种：${uniq.join(', ')}（应为 ${pkg.version}）`);
}

// ── 3. 工具名 ──
// 以 ALLOWED_TOOLS（模型实际可见的白名单）为权威，而不是只看 lib 里的定义——
// web_search / web_fetch 是框架自带工具，不写在插件定义里但在白名单内。
const libSrc = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
const allowBlock = /const ALLOWED_TOOLS = \[([\s\S]*?)\]/.exec(libSrc);
const allowed = allowBlock
  ? new Set([...allowBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
  : new Set();

// 文档里所有 <code> 内的、含下划线的小写标识符，按"疑似工具名"校验
const docTools = new Set([...doc.matchAll(/<code>([a-z]+_[a-z_]+)<\/code>/g)].map((m) => m[1]));
const notInAllow = [...docTools].filter((t) => !allowed.has(t));
if (notInAllow.length) {
  bad(`文档提到但不在工具白名单：${notInAllow.join(', ')}`);
} else {
  ok(`文档提到的 ${docTools.size} 个工具都在白名单内（白名单共 ${allowed.size} 个）`);
}

const notInDoc = [...allowed].filter((t) => !doc.includes(t));
if (notInDoc.length) warn(`白名单里有但文档未提及：${notInDoc.join(', ')}`);
else ok('白名单内所有工具都在文档中有说明');

// ── 4. 命令白名单 ──
const patcher = fs.readFileSync(path.join(ROOT, 'tools', 'patcher.mjs'), 'utf8');
const allowMatch = /const ALLOW = \[([^\]]+)\]/.exec(patcher);
const codeCmds = allowMatch
  ? [...allowMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  : [];
const docCmdsSection = /<h3[^>]*>[\d.]*\s*可用命令<\/h3>([\s\S]{0,2500})/.exec(doc);
if (docCmdsSection) {
  // 表格里列的是可用命令；"其余命令（含 /context、/plugins…）已移除"这句里的不算
  const tablePart = docCmdsSection[1].split('</table>')[0];
  const mentioned = [...tablePart.matchAll(/<code>\/([a-z]+)<\/code>/g)].map((m) => m[1]);
  const extra = [...new Set(mentioned)].filter((c) => !codeCmds.includes(c));
  if (extra.length) bad(`文档提到的命令不在白名单：${extra.join(', ')}`);
  else ok(`文档列出的命令都在白名单内（白名单 ${codeCmds.length} 个）`);
} else {
  warn('文档里没找到「可用命令」小节');
}

// ── 5. 环境变量 ──
const srcFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); }
    else if (/\.(js|sh|mjs)$/.test(e.name)) srcFiles.push(f);
  }
};
['lib', 'src', 'bin'].forEach((d) => walk(path.join(ROOT, d)));
const allSrc = srcFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const codeEnvs = new Set([...allSrc.matchAll(/\b(SOC_[A-Z_]+)\b/g)].map((m) => m[1]));
const docEnvs = new Set([...doc.matchAll(/<code>(SOC_[A-Z_]+)<\/code>/g)].map((m) => m[1]));

const envMissing = [...docEnvs].filter((v) => !codeEnvs.has(v));
if (envMissing.length) {
  bad(`文档提到但代码未使用的环境变量：${envMissing.join(', ')}`);
} else {
  ok(`文档提到的 ${docEnvs.size} 个环境变量都在代码中使用`);
}

// ── 6. HTML 结构 ──
const opens = (doc.match(/<table/g) || []).length;
const closes = (doc.match(/<\/table>/g) || []).length;
if (opens !== closes) bad(`<table> 标签不配平：${opens} 开 / ${closes} 闭`);
else ok(`<table> 配平（${opens} 个）`);

const preO = (doc.match(/<pre[\s>]/g) || []).length;  // 允许带属性的 <pre style=...>
const preC = (doc.match(/<\/pre>/g) || []).length;
if (preO !== preC) bad(`<pre> 标签不配平：${preO} 开 / ${preC} 闭`);
else ok(`<pre> 配平（${preO} 个）`);

const divO = (doc.match(/<div/g) || []).length;
const divC = (doc.match(/<\/div>/g) || []).length;
if (divO !== divC) bad(`<div> 标签不配平：${divO} 开 / ${divC} 闭`);
else ok(`<div> 配平（${divO} 个）`);

// ── 7. 未替换的占位符 ──
const ph = [...doc.matchAll(/__[A-Z]+__/g)].map((m) => m[0]);
if (ph.length) bad(`存在未替换的占位符：${[...new Set(ph)].join(', ')}`);
else ok('无未替换占位符');

// ── 结论 ──
console.log('');
if (fail) {
  console.log(`✗ 文档有 ${fail} 处不一致，需修正\n`);
  process.exit(1);
}
console.log('✓ 文档与代码一致\n');
process.exit(0);

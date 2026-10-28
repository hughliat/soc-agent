#!/usr/bin/env node
/**
 * dsh-tui 补丁器（Node 实现）—— 替代原先 5 个 Python 脚本。
 *
 * 为什么必须改成 Node：
 *   生产环境是麒麟 / 最小化 Linux，**python3 不保证存在**，
 *   而 dsh 自身依赖 Node，Node 一定在。为了不让"界面封禁"因为缺 python 而静默失效，
 *   整条补丁链改成本脚本。这也是"零第三方依赖"承诺的一部分。
 *
 * 用法（由 patch-dsh-tui.sh 调用，不建议手工跑）：
 *   node patcher.mjs commands <commands.js>
 *   node patcher.mjs i18n     <i18n.js>
 *   node patcher.mjs logo     <Whale.js>
 *   node patcher.mjs logo2    <Launchpad.js>
 *   node patcher.mjs logo3    <LogoV2.js>
 *
 * 设计原则：
 *   · **幂等 + 增量**：已打过不是"跳过"，而是逐项检查补缺。
 *     这条是踩出来的——原先"标记在就跳过"导致后来新增的替换项永远不生效。
 *   · 任何一步失败都返回非零，由 shell 侧决定是否回滚。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '?';
  }
}
const VERSION = version();

// ── 启动页与 LogoV2 共用的字形（青→蓝渐变，真彩色 ANSI）──
//
// 字形用半格块拼 "SOC"：终端里所有等宽字体都能正确渲染，
// 不依赖 braille / 特殊符号，也就不会在麒麟的 console 字体上串行。
// 配色与 assets/logo.png 的徽标渐变同源（青 #14A38B → 蓝 #1E6FD9）。
const ART = [
  "\u001b[38;2;20;163;139m█████ █████ █████\u001b[0m",
  "\u001b[38;2;21;140;165m█     █   █ █    \u001b[0m",
  "\u001b[38;2;25;110;190m█████ █   █ █    \u001b[0m",
  "\u001b[38;2;28;90;205m    █ █   █ █    \u001b[0m",
  "\u001b[38;2;30;111;217m█████ █████ █████\u001b[0m",
];

// 三行字标：前两行加粗（patcher 按行位置判定），第三行暗色放仓库地址。
// 行数必须保持 3 —— logo()/logo2()/logo3() 里的 bold 判定按「末三行」算。
const TEXT_LINES = [
  '小安 · soc-agent',
  `安全运维智能体 v${VERSION}`,
  'github.com/hughliat/soc-agent',
];

const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, s) => fs.writeFileSync(f, s, 'utf8');
const q = (s) => '"' + s.replace(/"/g, '\\"') + '"';

// ══════════════════ commands ══════════════════
function commands(file) {
  let src = read(file);
  const MARK = 'SOC_AGENT_PATCH:commands';
  const ALLOW = ['help', 'exit', 'quit', 'q', 'model', 'status', 'lang', 'theme'];

  // /help 保留：没有它用户不知道能用什么命令（实测去掉后无法自助）。
  // 它的输出会带出 dsh-tui 的文档索引，这点用"引导词"补足 ——
  // 系统提示词里明确告诉用户配置项在哪，避免用户去翻 dsh 文档。

  if (src.includes(MARK)) {
    // 增量：白名单可能变了，重写过滤表达式
    const re = /export const LOCAL_COMMANDS = __ALL_LOCAL_COMMANDS\.filter\([\s\S]*?\);/;
    if (re.test(src)) {
      const next = `export const LOCAL_COMMANDS = __ALL_LOCAL_COMMANDS.filter((c) => [${ALLOW.map((n) => `'${n}'`).join(', ')}].includes(c.name));`;
      src = src.replace(re, next);
      write(file, src);
      console.log(`  已同步命令白名单 ${ALLOW.length} 个（${ALLOW.join('/')}）`);
      return 0;
    }
    console.log('  已打过命令补丁，跳过');
    return 0;
  }

  const OLD = 'export const LOCAL_COMMANDS = [';
  if (!src.includes(OLD)) {
    console.error('锚点未找到：LOCAL_COMMANDS');
    return 1;
  }
  src = src.replace(OLD, 'const __ALL_LOCAL_COMMANDS = [');
  src += `\n/* ${MARK} —— 只读诊断产品只放行白名单命令。\n   摘掉的：context（摊开系统提示词）、plugins/add-dir/mcp/skills/hooks、\n   provider/login/logout、update/star/balance、workspace*/agents/jobs/bg、\n   help（输出会带出框架文档索引）。 */\n`
    + `export const LOCAL_COMMANDS = __ALL_LOCAL_COMMANDS.filter((c) => [${ALLOW.map((n) => `'${n}'`).join(', ')}].includes(c.name));\n`;
  write(file, src);
  console.log(`  已改：slash 命令收敛为白名单 ${ALLOW.length} 个（${ALLOW.join('/')}）`);
  return 0;
}

// ══════════════════ i18n ══════════════════
function i18n(file) {
  let src = read(file);
  const MARK = 'SOC_AGENT_PATCH:i18n';

  // [key, zh_old, zh_new, en_old, en_new]
  const REWRITES = [
    // 英文名用弯撇号（U+2019）：写进单引号字符串不会破语法（直撇号会）
    ['onboarding-title', '欢迎使用 dsh-TUI', '小安 · 安全运维智能体', 'Welcome to dsh-TUI', 'Xiao\u2019an · soc-agent'],
    ['onboarding-step-model-title', '模型与工作区', '模型接入', 'Model & workspace', 'Model'],
    ['onboarding-step-keys-title', '快捷键与招式', '基本操作', 'Shortcuts & moves', 'Basics'],
    ['tips-title', '使用技巧（快捷键 · 命令 · 工作流 · 个性化 · 避坑）', '诊断技巧（排查流程 · 命令 · 避坑）',
      'Tips (shortcuts · commands · workflows · personalization · pitfalls)', 'Diagnostic tips (workflow · commands · pitfalls)'],
    ['launchpad-placeholder', '说点什么，或输入 / 看命令…',
      '描述故障现象（如「磁盘满了」「服务起不来」），或输入 / 看命令…',
      'Say something, or type / for commands…',
      'Describe the symptom (e.g. "disk full", "service down"), or type / for commands…'],
    // DeepSeek 的峰谷计价标识（峰/谷），与本产品无关，容易被当成乱码
    ['cost-now-peak', '峰', '', 'peak', ''],
    ['cost-now-idle', '谷', '', 'idle', ''],
  ];

  const already = src.includes(MARK);
  if (already) console.log('  检测到已有补丁，执行增量补齐…');

  // 上一版补丁写入过的值：机器可能已经是老版品牌，只认上游原文会漏改。
  // 值形如 [key, 语言, 旧补丁值]。
  const PREV = [
    ['onboarding-title', 'zh', '安全运维智能体'],
    ['onboarding-title', 'en', '安全运维智能体 (soc-agent)'],
  ];

  const changed = [];
  const missed = [];

  for (const [key, zhOld, zhNew, enOld, enNew] of REWRITES) {
    let done = false;
    for (const [field, oldV, newV] of [['zh', zhOld, zhNew], ['en', enOld, enNew]]) {
      // 候选原文：上游原值 + 历史补丁值。只在该 key 的对象内替换，避免误伤别处同名字符串。
      const prevs = PREV.filter((p) => p[0] === key && p[1] === field).map((p) => p[2]);
      for (const from of [oldV, ...prevs]) {
        const re = new RegExp(
          `('${key}':\\s*\\{[^}]*?\\b${field}:\\s*')${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(')`,
          's',
        );
        if (re.test(src)) {
          src = src.replace(re, (m, a, b) => a + newV + b);
          done = true;
        }
      }
    }
    (done ? changed : missed).push(key);
  }

  if (changed.length) {
    if (!already) src += `\n/* ${MARK} —— 界面文案已改为安全运维语境 */\n`;
    write(file, src);
    console.log(`  已改文案 ${changed.length} 处：${changed.join(', ')}`);
  } else if (!already) {
    write(file, src);
    console.log('  已写入补丁标记');
  } else {
    console.log('  文案无缺漏');
  }
  if (missed.length) console.log(`  ⚠ 未命中（可能已改过或上游变了）：${missed.join(', ')}`);
  return 0;
}

// ══════════════════ logo（Whale.js，侧栏用）══════════════════
function logo(file) {
  let src = read(file);
  const MARK = 'SOC_AGENT_PATCH:logo';
  if (src.includes(MARK)) {
    console.log('  已换过 logo，跳过');
    return 0;
  }
  const re = /export function WhaleArt\(([^)]*)\)\s*\{[\s\S]*?\n\}/;
  if (!re.test(src)) {
    console.error('锚点未找到：WhaleArt');
    return 1;
  }
  const lines = [...ART, ...TEXT_LINES];
  const body = lines.map((l) => `        ${q(l)},`).join('\n');
  src = src.replace(re, () => `export function WhaleArt({ frameIndex, pose, width }) {
    /* ${MARK} —— 换成产品自有标识 */
    const _L = [
${body}
    ];
    return (_jsx(Box, { flexDirection: "column", flexShrink: 0, width: width, children: _L.map((line, i) => (_jsx(Text, { wrap: "truncate-end", children: line }, i))) }));
}`);
  write(file, src);
  console.log('  已换：侧栏标识');
  return 0;
}

// ══════════════════ logo2（启动页 hero）══════════════════
function logo2(file) {
  let src = read(file);
  const MARK = 'SOC_AGENT_PATCH:logo2';
  const all = [...ART, ...TEXT_LINES];
  const build = () => {
    const arr = all.map((l) => `        ${q(l)},`).join('\n');
    return `/* ${MARK} */
                    layout.showHero && (() => {
    const _L = [
${arr}
    ];
    return _jsx(Box, { flexDirection: "column", alignItems: "center", children:
        _L.map((line, i) => (_jsx(Text, { bold: i >= _L.length - 3 && i <= _L.length - 2, dimColor: i < _L.length - 3 || i === _L.length - 1, children: line }, i))) });
})()`;
  };

  if (src.includes(MARK)) {
    // 增量：版本号与字形可能变，整段重写
    const re = /\/\* SOC_AGENT_PATCH:logo2 \*\/[\s\S]*?\}\)\(\)/;
    src = src.replace(re, build());
    write(file, src);
    console.log(`  已同步启动页标识（${VERSION}）`);
    return 0;
  }

  const re = /layout\.showHero && \(_jsx\(LogoV2,\s*\{[^}]*\}\)\)/s;
  if (!re.test(src)) {
    console.error('锚点未找到：LogoV2 调用');
    return 1;
  }
  src = src.replace(re, build());
  write(file, src);
  console.log('  已换：启动页标识');
  return 0;
}

// ══════════════════ logo3（LogoV2 组件本体）══════════════════
function logo3(file) {
  let src = read(file);
  const MARK = 'SOC_AGENT_PATCH:logo3';
  const all = [...ART, ...TEXT_LINES];

  if (src.includes(MARK)) {
    const re = /const _SOC_LINES = \[[\s\S]*?\n    \];/;
    const arr = all.map((l) => `        ${q(l)},`).join('\n');
    src = src.replace(re, `const _SOC_LINES = [\n${arr}\n    ];`);
    write(file, src);
    console.log(`  已同步 LogoV2 标识（${VERSION}）`);
    return 0;
  }

  if (!src.includes("from '../ui.js'")) {
    src = src.replace(
      "import { getLang, t as tr, tOr } from '../i18n.js';",
      `import { getLang, t as tr, tOr } from '../i18n.js';\n/* ${MARK} */\nimport { Box, Text } from '../ui.js';`,
    );
  }

  const sig = /export function LogoV2\(\{[^}]*\}\)\s*\{/;
  if (!sig.test(src)) {
    console.error('锚点未找到：LogoV2 签名');
    return 1;
  }
  const arr = all.map((l) => `        ${q(l)},`).join('\n');
  src = src.replace(sig, (m) => `${m}
    /* ${MARK} —— 组件输出整体换成机构标识，覆盖所有调用方（启动页/对话页/侧栏）。
       会跳过开屏动画，对本产品无影响。 */
    const _SOC_LINES = [
${arr}
    ];
    return (_jsx(Box, { flexDirection: "column", alignItems: "center", paddingY: 1, children: _SOC_LINES.map((line, i) => (_jsx(Text, { bold: i >= _SOC_LINES.length - 3 && i <= _SOC_LINES.length - 2, dimColor: i < _SOC_LINES.length - 3 || i === _SOC_LINES.length - 1, children: line }, i))) }));`);
  write(file, src);
  console.log('  已换：LogoV2 组件输出（覆盖所有调用方）');
  return 0;
}


// ══════════════════ launchpad（启动页只留「帮助」入口）══════════════════
function launchpad(file) {
  let src = read(file);
  const MARK = 'SOC_AGENT_PATCH:launchpad';
  if (src.includes(MARK)) {
    console.log('  启动页已打过补丁，跳过');
    return 0;
  }
  const anchor = 'export function resolveLaunchpadActions(state) {';
  if (!src.includes(anchor)) {
    console.error('锚点未找到：resolveLaunchpadActions');
    return 1;
  }
  // 只留 HELP：摘掉「会话与工作区 / 设置 / 有新版本 / 后台任务 / 投喂 Star」
  const inject = `${anchor}
    /* ${MARK} —— 本产品只保留「帮助」，其余入口与本定位无关：
       /update 会走 npm registry（外网出口），/preset 可切到带 bash 的模式。 */
    return [HELP];`;
  src = src.replace(anchor, inject);
  write(file, src);
  console.log('  已改：启动页只留 HELP');
  return 0;
}

// ══════════════════ params（底部参数行去掉 preset / permission）══════════════════
function params(file) {
  let src = read(file);
  const MARK = 'SOC_AGENT_PATCH:params';
  const PUSH = 'SOC_AGENT_PATCH:paramspush';
  let touched = false;

  // 1) 排序常量
  const order = "const PARAM_SEGMENT_ORDER = ['model', 'effort', 'preset', 'permission'];";
  if (src.includes(order)) {
    src = src.replace(order, `const PARAM_SEGMENT_ORDER = ['model', 'effort']; /* ${MARK} —— preset 被 config 钉死、permission 只有只读一档，留着只会让人以为能改 */`);
    touched = true;
  }

  // 2) 实际 push 处（ORDER 只管排序，真正渲染在这里）
  const a = "        if (preset !== undefined && preset !== '') {";
  const b = "        if (permission !== undefined && permission !== '')";
  if (src.includes(a)) {
    src = src.replace(a, `        /* ${PUSH} */\n        if (false) {`);
    touched = true;
  }
  if (src.includes(b)) {
    src = src.replace(b, `        /* ${PUSH} */\n        if (false)`);
    touched = true;
  }

  if (touched) {
    write(file, src);
    console.log('  已改：参数行只留 model / effort');
    return 0;
  }
  if (src.includes(MARK) || src.includes(PUSH)) {
    console.log('  参数行已打过补丁，跳过');
    return 0;
  }
  console.error('锚点未找到：PARAM_SEGMENT_ORDER / paramParts');
  return 1;
}

// ══════════════════ update（不联网查版本）══════════════════
function update(file) {
  let src = read(file);
  const MARK = 'SOC_AGENT_PATCH:update';
  if (src.includes(MARK)) {
    console.log('  更新检查已打过补丁，跳过');
    return 0;
  }
  const anchor = 'export async function checkForTuiUpdate() {';
  if (!src.includes(anchor)) {
    console.error('锚点未找到：checkForTuiUpdate');
    return 1;
  }
  src = src.replace(anchor, `${anchor}
    /* ${MARK} —— 内网产品不做联网查版本：查 npm registry 是外网出口，
       升级应由运维按发布流程执行，不该由终端提示。 */
    return undefined;`);
  write(file, src);
  console.log('  已改：更新检查不联网');
  return 0;
}

// ══════════════════ 入口 ══════════════════
const [kind, file] = process.argv.slice(2);
if (!kind || !file) {
  console.error('用法：node patcher.mjs <commands|i18n|logo|logo2|logo3|launchpad|params|update> <文件>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`文件不存在：${file}`);
  process.exit(2);
}
const table = { commands, i18n, logo, logo2, logo3, launchpad, params, update };
const fn = table[kind];
if (!fn) {
  console.error(`未知类型：${kind}`);
  process.exit(2);
}
try {
  process.exit(fn(file));
} catch (e) {
  console.error(`补丁失败：${e.message}`);
  process.exit(1);
}

/**
 * 知识库检索 —— 让「7 库」真正可用。
 *
 * 背景（2026-10-21 用户要求）：
 *   参考本机 7 库设定，给 soc-agent 建一套相匹配的知识体系
 *   （纪律 / 专家 / 技能 / 知识 / 记忆）。
 *   但只建文件没用 —— 模型看不见文件系统。必须给它一个检索入口。
 *
 * 设计取舍：
 *   · 不做向量检索（零依赖、要轻、要能在内网无网跑）
 *   · 做关键词打分（标题命中 > 正文命中，多次命中加权）
 *   · 结果返回**摘录**而不是全文，防止一次塞爆上下文
 *   · 全部只读；目录固定为插件自带的 knowledge/
 *
 * 零副作用：本模块只读文件。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 知识库图层级说明（给模型时附上，让它知道每层是干什么的） */
const LAYERS = {
  agents: '纪律层（AGENTS.md）：行为规范与红线',
  experts: '专家层：按领域划分的诊断专家知识',
  skills: '技能层：具体排查手法与操作步骤',
  kb: '知识层：故障速查、已知缺陷、厂商公告摘要',
  memory: '记忆层：本机基线、历史诊断结论',
};

const MAX_FILE_CHARS = 60000;

/**
 * 列出知识库里的所有条目（递归 md）。
 * @param {string} root knowledge 目录
 * @returns {object[]} [{layer, rel, abs, title}]
 */
function listEntries(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;

  const walk = (dir, layer, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, layer, depth + 1);
        continue;
      }
      if (!/\.md$/i.test(ent.name)) continue;
      let title = ent.name.replace(/\.md$/i, '');
      try {
        const head = fs.readFileSync(full, 'utf8').slice(0, 400);
        const m = /^#\s+(.+)$/m.exec(head);
        if (m) title = m[1].trim();
      } catch {
        /* 读不到就用文件名 */
      }
      out.push({
        layer: layer || 'kb',
        rel: path.relative(root, full),
        abs: full,
        title,
      });
    }
  };

  // 顶层 AGENTS.md 归到 agents 层
  const topAgents = path.join(root, 'AGENTS.md');
  if (fs.existsSync(topAgents)) {
    let title = '行为规范';
    try {
      const m = /^#\s+(.+)$/m.exec(fs.readFileSync(topAgents, 'utf8').slice(0, 400));
      if (m) title = m[1].trim();
    } catch { /* ignore */ }
    out.push({ layer: 'agents', rel: 'AGENTS.md', abs: topAgents, title });
  }

  for (const layer of Object.keys(LAYERS)) {
    if (layer === 'agents') continue;
    const dir = path.join(root, layer);
    if (fs.existsSync(dir)) walk(dir, layer, 0);
  }

  return out;
}

/**
 * 关键词检索知识库。
 *
 * @param {string} root knowledge 目录
 * @param {string} query 关键词（空格分隔多个词，全部命中优先）
 * @param {{limit?: number, layer?: string}} opts
 * @returns {{hits: object[], total: number}}
 */
function search(root, query, opts = {}) {
  const entries = listEntries(root).filter((e) => !opts.layer || e.layer === opts.layer);
  const terms = String(query || '')
    .toLowerCase()
    .split(/[\s,，、]+/)
    .filter((t) => t.length > 0);
  if (!terms.length) {
    // 无关键词 = 列目录
    return {
      hits: entries.map((e) => ({ ...e, score: 0, excerpt: '' })),
      total: entries.length,
    };
  }

  const scored = [];
  for (const e of entries) {
    let text = '';
    try {
      text = fs.readFileSync(e.abs, 'utf8').slice(0, MAX_FILE_CHARS);
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    const titleLower = e.title.toLowerCase();

    let score = 0;
    for (const t of terms) {
      // 标题命中权重最高
      if (titleLower.includes(t)) score += 10;
      // 正文出现次数（封顶，防长文刷分）
      const cnt = lower.split(t).length - 1;
      if (cnt > 0) score += Math.min(cnt, 8);
    }
    if (score === 0) continue;

    // 摘录：取第一个命中的段落
    let excerpt = '';
    const idx = lower.indexOf(terms[0]);
    if (idx >= 0) {
      const start = Math.max(0, text.lastIndexOf('\n## ', idx));
      const seg = text.slice(start === -1 ? Math.max(0, idx - 200) : start, Math.min(text.length, idx + 500));
      excerpt = seg.trim().slice(0, 500);
    }
    scored.push({ ...e, score, excerpt, layers: LAYERS[e.layer] || '' });
  }

  scored.sort((a, b) => b.score - a.score);
  const limit = opts.limit ?? 5;
  return { hits: scored.slice(0, limit), total: scored.length };
}

module.exports = { listEntries, search, LAYERS };

/**
 * 向记忆层沉淀一条经验（kb_note 工具的实现）。
 *
 * 为什么单独做写能力，且只允许写记忆层：
 *   「越用越聪明」的前提是能把新学到的写回知识库。
 *   但纪律层(agents)/专家层(experts)/技能层(skills)/知识层(kb)是**固化知识**，
 *   不随单次诊断改动——只有 memory 层是「本机特有的、会变的」。
 *   所以写能力严格限定在 memory/ 目录，且只能 append / 新建，不能覆盖已有内容。
 *
 * 安全约束：
 *   1. 目标文件必须在 memory/ 目录内（path 白名单，防路径穿越）
 *   2. 只 append，不覆盖（不 rm、不 truncate）
 *   3. 单次内容限长，防塞爆
 *   4. 内容强制带日期前缀，可追溯
 */
function appendMemory(root, opts) {
  const { file = '历史诊断.md', content = '' } = opts || {};
  const text = String(content).trim();
  if (!text) return { ok: false, reason: 'content 为空' };
  if (text.length > 4000) return { ok: false, reason: '单条沉淀超过 4000 字符，请精简' };

  // 文件名白名单：只允许 memory/ 下的 .md，且不含路径分隔符 / ..
  const name = String(file);
  if (!/^[\w\u4e00-\u9fa5-]+\.md$/.test(name) || name.includes('..')) {
    return { ok: false, reason: `文件名非法：${file}（只允许 memory/ 下的 .md，如 历史诊断.md）` };
  }

  const memoryDir = path.join(root, 'memory');
  const target = path.join(memoryDir, name);
  // 双保险：规范化后再确认仍在 memory/ 内
  if (path.dirname(target) !== memoryDir) {
    return { ok: false, reason: '路径越界，只允许写 memory/ 目录' };
  }

  // 只 append，不覆盖
  let prev = '';
  if (fs.existsSync(target)) {
    prev = fs.readFileSync(target, 'utf8');
  }

  const date = new Date().toISOString().slice(0, 10);
  const entry = `\n## ${date}\n\n${text}\n`;
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.appendFileSync(target, entry, 'utf8');
    return {
      ok: true,
      file: path.relative(root, target),
      created: prev === '',
      appendedChars: entry.length,
    };
  } catch (e) {
    return { ok: false, reason: `写入失败：${e.message}` };
  }
}

module.exports = { listEntries, search, appendMemory, LAYERS };

'use strict';

/**
 * 从评论区学说话方式：模型抽取（优先）+ 规则兜底。
 *
 * 只产出「短语」，不存原文整段、不记评论者、不学立场；合并与衰减在 core/bili/style.js。
 */

const style = require('../../core/bili/style');
const biliStore = require('../../infra/biliStore');

const SYSTEM = [
  '你在观察 B 站评论区「怎么说话」，只输出 JSON，不要解释。',
  '格式：{"phrases":["…","…"]}',
  '只提取表达方式：口头禅、短句式、语气词组合（例如「确实」「属于是」「笑发财」），每句不超过 12 字，最多 4 条。',
  '不要提取任何具体内容、人名、立场、脏话或完整句子；宁可从缺，也不要编。',
].join('\n');

// 规则兜底：评论里常见的「气口」，用来在没有模型时也能学到一点
const PATTERNS = [
  '哈哈哈哈', '笑死', '笑发财', '绝了', '离谱', '绷不住', '难绷', '好家伙', '属于是',
  '不是吧', '有一说一', '讲道理', '说真的', '我服', '啊这', '真的会谢', '破防', '救命',
  '太真实', '建议', '避雷', '前排', '打卡', '上头', '下头', '血赚', '血亏', '就这',
  '确实', '懂了', '合理', '可惜', '乐', '典', '神', '牛', '秀',
];

function splitClauses(text) {
  return String(text || '').split(/[，。！？!?；;\n]/).map((s) => s.trim()).filter(Boolean);
}

/** 从评论里挑出「像口头禅」的短句；纯函数，便于测试。 */
function extractHeuristic(replies, limit = 6) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(replies) ? replies : []) {
    const text = String((row && row.text) || '');
    if (!text) continue;
    for (const clause of splitClauses(text)) {
      if (clause.length > 14) continue;
      const hit = PATTERNS.find((p) => clause.includes(p));
      if (!hit) continue;
      const phrase = style.cleanPhrase(clause.replace(/^[，。！？、,.!?\s]+|[，。！？、,.!?\s]+$/g, ''));
      if (!phrase || phrase.length > style.MAX_TEXT) continue;
      const key = style.norm(phrase);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(phrase);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function parseModelPhrases(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    const list = Array.isArray(obj && obj.phrases) ? obj.phrases : [];
    return list.map((p) => style.cleanPhrase(p)).filter(Boolean).slice(0, 4);
  } catch {
    return [];
  }
}

/**
 * 学一轮：把本轮热评里的表达方式并进 style.json。
 * @returns {Promise<{added:number,total:number,usedModel:boolean}>}
 */
async function learn({ config, llm, replies, logger, now = new Date() } = {}) {
  const rows = (Array.isArray(replies) ? replies : []).filter((r) => r && r.text);
  if (!rows.length) return { added: 0, total: 0, usedModel: false };
  const path = biliStore.paths(config).style;
  const existing = biliStore.readJson(path, {});
  const items = Array.isArray(existing.items) ? existing.items : [];
  let phrases = [];
  let usedModel = false;
  if (llm && !llm.isMock) {
    try {
      const material = rows.slice(0, 8).map((r) => '- ' + String(r.text).slice(0, 60)).join('\n');
      const raw = await llm.complete({ system: SYSTEM, turns: [{ role: 'user', content: material }] });
      phrases = parseModelPhrases(raw);
      usedModel = phrases.length > 0;
    } catch (err) {
      logger?.warn?.('[bili] 评论风格模型失败，用规则：' + ((err && err.code) || 'unknown'));
    }
  }
  if (!phrases.length) phrases = extractHeuristic(rows);
  if (!phrases.length) return { added: 0, total: items.length, usedModel: false };
  const before = new Set(items.map((row) => row.norm || style.norm(row.text)));
  const merged = style.merge(items, phrases, now.getTime());
  const added = merged.filter((row) => !before.has(row.norm)).length;
  biliStore.writeJson(path, { updatedAt: now.getTime(), items: merged });
  return { added, total: merged.length, usedModel };
}

/** 聊天里注入的那一块（功能关闭或没有内容时返回空串）。 */
function blockFor(config, now = new Date()) {
  const cfg = (config && config.bili) || {};
  if (cfg.style && cfg.style.enabled === false) return '';
  const data = biliStore.readJson(biliStore.paths(config).style, {});
  const items = Array.isArray(data.items) ? data.items : [];
  return style.block(items, now.getTime());
}

module.exports = { SYSTEM, PATTERNS, extractHeuristic, parseModelPhrases, learn, blockFor };

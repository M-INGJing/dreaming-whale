'use strict';

/**
 * 评论区的说话方式 → 一份「说话习惯参考」。
 *
 * 只学**表达方式**，不学内容、不学立场：存的是短句/句式（≤20 字），不存评论原文，
 * 也不改人设（L0 永远是静态的）。每次最多注入 2~3 条、且明确写「偶尔用，不要堆砌」，
 * 避免学成复读机。
 *
 * 纯函数：合并、去重、衰减、挑选；模型/规则抽取在 services/bili/style.js。
 */

const MAX_TEXT = 20;
const MAX_ITEMS = 20;
const KEEP_DAYS = 30;
const MAX_CHAT_ITEMS = 3;

function norm(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?~～…"'“”‘’()（）【】\[\]]/g, '')
    .toLowerCase();
}

function cleanPhrase(text) {
  let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  s = s.replace(/^[-*•\d.、\s]+/, '');
  s = s.replace(/^["“「『]|["”」』]$/g, '').trim();
  if (!s || s.length > MAX_TEXT) return '';
  // 纯符号/纯数字/纯表情不算「说话方式」
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(s)) return '';
  return s;
}

/**
 * 把这一轮学到的短语并进已有列表。
 * @param {Array} items 已有：[{ text, norm, mentions, firstSeenAt, lastSeenAt }]
 * @param {string[]} phrases 新的候选
 * @param {number} now
 */
function merge(items, phrases, now = Date.now()) {
  const list = Array.isArray(items) ? items.map((row) => ({ ...row })) : [];
  const byNorm = new Map(list.map((row) => [row.norm || norm(row.text), row]));
  for (const raw of Array.isArray(phrases) ? phrases : []) {
    const text = cleanPhrase(raw);
    if (!text) continue;
    const key = norm(text);
    if (!key) continue;
    const existing = byNorm.get(key);
    if (existing) {
      existing.mentions = (Number(existing.mentions) || 1) + 1;
      existing.lastSeenAt = now;
      continue;
    }
    const row = { text, norm: key, mentions: 1, firstSeenAt: now, lastSeenAt: now };
    list.push(row);
    byNorm.set(key, row);
  }
  // 只留最近 KEEP_DAYS 天出现过的；再按「提及次数 + 新鲜度」截断
  const alive = list.filter((row) => !row.lastSeenAt || now - row.lastSeenAt <= KEEP_DAYS * 86400000);
  alive.sort((a, b) => (Number(b.mentions) || 1) - (Number(a.mentions) || 1) || (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0));
  return alive.slice(0, MAX_ITEMS);
}

/** 给聊天用的几条（按提及次数 + 新鲜度，最多 3 条）。 */
function pickForChat(items, now = Date.now(), limit = MAX_CHAT_ITEMS) {
  const alive = (Array.isArray(items) ? items : [])
    .filter((row) => row && cleanPhrase(row.text) && (row.lastSeenAt ? now - row.lastSeenAt <= KEEP_DAYS * 86400000 : true));
  alive.sort((a, b) => (Number(b.mentions) || 1) - (Number(a.mentions) || 1) || (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0));
  const seen = new Set();
  const out = [];
  for (const row of alive) {
    const key = row.norm || norm(row.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleanPhrase(row.text));
    if (out.length >= limit) break;
  }
  return out;
}

/** 拼成提示词里的那一块；没有内容返回 ''。 */
function block(items, now = Date.now()) {
  const picked = pickForChat(items, now);
  if (!picked.length) return '';
  return [
    '【评论区说话习惯】最近评论区常这么说话：' + picked.map((s) => '「' + s + '」').join('、'),
    '你想学的是这种「气口」：偶尔用 1~2 个，别堆砌、别照抄整句，也不要因此改变你的性格。',
  ].join('\n');
}

module.exports = { MAX_TEXT, MAX_ITEMS, KEEP_DAYS, MAX_CHAT_ITEMS, norm, cleanPhrase, merge, pickForChat, block };

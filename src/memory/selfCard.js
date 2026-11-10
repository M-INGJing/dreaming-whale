'use strict';

/**
 * 鲸鲸自己的卡（SelfCard）：她自己的 traits / preferences / events / state。
 *
 * 和人物卡（personCard，记「对方」）相对，这里记「她自己」，全局一张（她跨 chat 同一人）。
 * 数据来源：周小结（services/bili/weekly.js）把 likes/dislikes/state/summary 写进来。
 * 现在只写 + 供未来注入（P2 才接进聊天 prompt）；先让数据沉淀下来，等 P2 消费。
 *
 * 存储：<dataDir>/memory/self-card.json（和 chats/ 同级，不属于任何单个聊天）。
 */

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'self-card.json';
const MAX_PREFS = 30;
const MAX_EVENTS = 60;

function fileFor(config) {
  try {
    return path.join(config.paths.dataDir, 'memory', FILE_NAME);
  } catch {
    return '';
  }
}

function empty() {
  return { traits: [], preferences: [], events: [], state: '', updatedAt: 0 };
}

function load(config) {
  const file = fileFor(config);
  if (!file) return empty();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
    return {
      traits: Array.isArray(data.traits) ? data.traits : [],
      preferences: Array.isArray(data.preferences) ? data.preferences : [],
      events: Array.isArray(data.events) ? data.events : [],
      state: String(data.state || ''),
      updatedAt: Number(data.updatedAt) || 0,
    };
  } catch {
    return empty();
  }
}

function save(config, card) {
  const file = fileFor(config);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(card, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 按 text 去重 upsert 一条；超 max 条时按 updatedAt 最旧的先丢 */
function upsert(list, item, max = MAX_PREFS) {
  const text = String(item && item.text || '').trim();
  if (!text) return list;
  const hit = list.find((x) => String(x.text || '').trim() === text);
  if (hit) {
    hit.confidence = item.confidence;
    hit.kind = item.kind;
    hit.source = item.source;
    hit.updatedAt = item.updatedAt;
    return list;
  }
  list.push(item);
  list.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  while (list.length > max) list.shift();
  return list;
}

/**
 * 把周小结的 likes / dislikes / state / summary 写回 SelfCard。
 * 幂等：同一天（weekStart）重复调用会覆盖而不是追加（weekly 本身一周一次，这里是兜底）。
 * @returns {boolean} 是否成功落盘
 */
function applyWeekly(config, { likes = [], dislikes = [], state = '', summary = '', weekStart = '', now = Date.now() } = {}) {
  const card = load(config);
  for (const text of likes) {
    card.preferences = upsert(card.preferences, { text, kind: 'like', confidence: 0.7, source: 'weekly:' + weekStart, updatedAt: now });
  }
  for (const text of dislikes) {
    card.preferences = upsert(card.preferences, { text, kind: 'dislike', confidence: 0.7, source: 'weekly:' + weekStart, updatedAt: now });
  }
  if (state) card.state = String(state).slice(0, 40);
  if (summary) {
    const key = 'weekly:' + weekStart;
    const ev = { date: weekStart, title: '周小结', summary: String(summary).slice(0, 300), source: key, updatedAt: now };
    const hit = card.events.find((e) => e.source === key);
    if (hit) Object.assign(hit, ev);
    else card.events.push(ev);
    if (card.events.length > MAX_EVENTS) card.events = card.events.slice(-MAX_EVENTS);
  }
  card.updatedAt = now;
  return save(config, card);
}

/**
 * 拼成提示词那一块（P2：SelfCard 作为「动态人设层」，让她越聊越有自己的性子）。
 * 空卡（没有偏好、没有近况）返回 ''。
 */
function blockFor(config) {
  const card = load(config);
  const likes = card.preferences.filter((p) => p.kind === 'like').map((p) => p.text).slice(0, 6);
  const dislikes = card.preferences.filter((p) => p.kind === 'dislike').map((p) => p.text).slice(0, 6);
  if (!likes.length && !dislikes.length && !card.state) return '';
  const lines = ['【我（鲸鲸）自己记下的长期偏好】'];
  if (likes.length) lines.push('更喜欢：' + likes.join('、'));
  if (dislikes.length) lines.push('不太想碰：' + dislikes.join('、'));
  if (card.state) lines.push('近况：' + card.state);
  lines.push('这些是你自己慢慢积累的偏好，聊到相关话题时自然流露一点，别念出来、别每句都提。');
  return lines.join('\n');
}

module.exports = { empty, load, save, upsert, applyWeekly, blockFor, fileFor, MAX_PREFS, MAX_EVENTS };

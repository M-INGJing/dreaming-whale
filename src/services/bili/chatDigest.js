'use strict';

/**
 * 当天聊天的「素材摘要」：给日记用，不是给模型重放全文。
 *
 * 从记忆里按会话取今天的消息，每个会话最多几句、总量有上限；
 * 只保留「谁说了什么」的短句，够模型知道今天聊过什么、和谁聊的，
 * 又不会把整段聊天记录塞进提示词（隐私 + token 双重考虑）。
 */

const MAX_CHARS = 1200;
const MAX_CHATS = 6;
const PER_CHAT = 6;
const MAX_LINE = 60;

function startOfDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function clip(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function labelOf(key, msg) {
  const raw = String(key || '');
  if (raw.startsWith('wechat:g:')) return '群聊';
  return '私聊';
}

/**
 * @param {object} runtime { store }
 * @param {Date} date
 * @param {{maxChars?:number,maxChats?:number,perChat?:number}} opts
 * @returns {{text:string, chats:number, messages:number}}
 */
function collectDay(runtime, date = new Date(), opts = {}) {
  const maxChars = Math.max(200, Math.min(4000, Number(opts.maxChars) || MAX_CHARS));
  const maxChats = Math.max(1, Math.min(20, Number(opts.maxChats) || MAX_CHATS));
  const perChat = Math.max(1, Math.min(20, Number(opts.perChat) || PER_CHAT));
  const start = startOfDay(date);
  const store = runtime && runtime.store;
  if (!store || !store.sessions || typeof store.messages !== 'function') {
    return { text: '', chats: 0, messages: 0 };
  }
  const blocks = [];
  let chats = 0;
  let messages = 0;
  try {
    for (const key of store.sessions.keys()) {
      const rows = store.messages(key, 200) || [];
      const today = rows.filter((m) => m && Number(m.ts) >= start && typeof m.text === 'string' && m.text.trim());
      if (!today.length) continue;
      const lines = [];
      let shown = 0;
      for (const m of today) {
        if (shown >= perChat) break;
        const who = m.role === 'assistant' ? '我' : clip(m.name || '对方', 12);
        const text = clip(m.text, MAX_LINE);
        if (!text) continue;
        lines.push(who + '：' + text);
        shown += 1;
        messages += 1;
      }
      if (!lines.length) continue;
      blocks.push('【' + labelOf(key, rows[0]) + '】' + lines.join(' / '));
      chats += 1;
      if (chats >= maxChats) break;
    }
  } catch {
    return { text: '', chats: 0, messages: 0 };
  }
  let text = blocks.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '…';
  return { text, chats, messages };
}

module.exports = { collectDay, startOfDay, MAX_CHARS };

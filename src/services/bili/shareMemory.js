'use strict';

/**
 * 把「已经发出去的 B 站分享」记进聊天记忆。
 *
 * 以前分享是桥接直接从队列里取的，内核的记忆里没有这条消息 ——
 * 所以主人问「你是不是给我发了个视频」时，她只会说「没有」。
 * 分享成功后补一条 assistant 消息（带链接的原文），她就能在上下文里看到自己确实发过。
 */

function chatKey(item) {
  const chatId = String((item && item.chatId) || '').trim();
  if (!chatId) return '';
  const group = item.chatType === 'group' || chatId.endsWith('@chatroom');
  return (group ? 'wechat:g:' : 'wechat:u:') + chatId;
}

/**
 * @param {object} runtime { config, store, logger }
 * @param {object} item outbox 里 ack 之后的条目 { id, text, chatType, chatId, bvid }
 * @returns {boolean} 是否写入
 */
function record(runtime, item) {
  const store = runtime && runtime.store;
  const key = chatKey(item);
  const text = String((item && item.text) || '').trim();
  if (!store || !key || !text || typeof store.appendMessage !== 'function') return false;
  try {
    store.ensureSession(key, {
      chatId: key,
      chatType: item.chatType === 'group' ? 'group' : 'private',
    });
    store.appendMessage(key, {
      role: 'assistant',
      name: String((runtime.config && runtime.config.persona && runtime.config.persona.name) || '鲸鲸'),
      text,
      ts: Date.now(),
      // 稳定的 msgId：同一条分享重复 ack 不会写两遍（appendMessage 会按 msgId 去重）
      msgId: 'bili-share:' + String(item.id || item.bvid || text.length),
      source: 'bili-share',
    });
    runtime.logger?.info?.('[bili] 分享已写入聊天记忆：' + key + '（' + (item.bvid || '') + '）');
    return true;
  } catch (err) {
    runtime.logger?.warn?.('[bili] 分享写入记忆失败：' + ((err && err.code) || 'memory'));
    return false;
  }
}

/** 启动补记：把最近已发出的分享补进记忆（处理修复前发过的、或 ack 时没写成功的）。 */
function backfill(runtime, opts = {}) {
  const store = runtime && runtime.store;
  if (!store || typeof store.appendMessage !== 'function') return 0;
  const days = Math.max(1, Math.min(30, Number(opts.days) || 2));
  const now = opts.now || Date.now();
  const since = now - days * 86400000;
  let restored = 0;
  let items = [];
  try {
    items = require('./outbox').readOutbox(runtime.config) || [];
  } catch {
    return 0;
  }
  for (const item of items) {
    if (!item || item.status !== 'sent') continue;
    if (Number(item.ackedAt) && Number(item.ackedAt) < since) continue;
    const key = chatKey(item);
    if (!key || !String(item.text || '').trim()) continue;
    const msgId = 'bili-share:' + String(item.id || item.bvid || '');
    try {
      if (typeof store.isDuplicate === 'function' && store.isDuplicate(key, msgId)) continue;
    } catch { /* 查不了当没写过 */ }
    if (record(runtime, item)) restored += 1;
  }
  if (restored) runtime.logger?.info?.('[bili] 启动补记：' + restored + ' 条分享已写入聊天记忆');
  return restored;
}

module.exports = { record, chatKey, backfill };

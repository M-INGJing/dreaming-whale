'use strict';

/**
 * 主动分享的出站队列（内核侧）：一天最多 N 次、两次至少隔 M 分钟、
 * 同一个视频只分享一次；目标只允许「主人私聊」和配置里的白名单群。
 *
 * 两段式（和表情包一致）：
 *   pending ──claim──▶ sending ──ack(ok)──▶ sent
 *                                └ack(fail)▶ failed
 * 桥接只负责：取一条 → 领取 → 发送 → 回执；它不判断该不该发。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const biliStore = require('../../infra/biliStore');

const SHARE_FILE = 'share.json';
const OUTBOX_FILE = 'outbox.json';
const MAX_SENT_MEMORY = 500;

function files(config) {
  const p = biliStore.paths(config);
  return { outbox: path.join(p.dir, OUTBOX_FILE), ledger: path.join(p.dir, SHARE_FILE) };
}

function readOutbox(config) {
  const data = biliStore.readJson(files(config).outbox, {});
  return Array.isArray(data.items) ? data.items : [];
}

function writeOutbox(config, items) {
  biliStore.writeJson(files(config).outbox, { items: items.slice(-100) });
  return items;
}

function readLedger(config) {
  const data = biliStore.readJson(files(config).ledger, {});
  return {
    date: String(data.date || ''),
    dayCount: Number(data.dayCount) || 0,
    lastAt: Number(data.lastAt) || 0,
    chats: data.chats && typeof data.chats === 'object' ? data.chats : {},
    sent: Array.isArray(data.sent) ? data.sent : [],
  };
}

function writeLedger(config, ledger) {
  biliStore.writeJson(files(config).ledger, ledger);
  return ledger;
}

function dayKey(now) {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function shareConfig(config) {
  return (config && config.bili && config.bili.share) || {};
}

function masterWxid(config) {
  const master = (config && config.persona && config.persona.master) || {};
  const list = Array.isArray(master.wxids) ? master.wxids : [];
  return String(list[0] || '').trim();
}

/**
 * 该不该分享、发给谁。
 * @param {object} config
 * @param {object} opts { score, now, silentDays }
 * @returns {{ok:boolean, reason:string, target?:{chatType:string, chatId:string, name:string}}}
 */
function canShare(config, opts = {}) {
  const share = shareConfig(config);
  if (share.enabled === false) return { ok: false, reason: 'share_disabled' };
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const minScore = Number.isFinite(share.minScore) ? share.minScore : 13;
  if (Number(opts.score) < minScore) return { ok: false, reason: 'score_too_low' };
  const silentDays = Math.max(0, Number(share.silentAfterDays) || 0);
  if (silentDays && Number(opts.silentDays) >= silentDays) return { ok: false, reason: 'silent' };
  const ledger = readLedger(config);
  const today = dayKey(now);
  const dayCount = ledger.date === today ? ledger.dayCount : 0;
  const daily = Math.max(0, Number(share.daily) || 0);
  if (daily && dayCount >= daily) return { ok: false, reason: 'daily_cap' };
  const gapMs = Math.max(0, Number(share.minGapMinutes) || 0) * 60000;
  if (gapMs && ledger.lastAt && now.getTime() - ledger.lastAt < gapMs) {
    return { ok: false, reason: 'gap' };
  }
  const target = pickTarget(config, now, ledger, opts.masterWxid);
  if (!target) return { ok: false, reason: 'no_target' };
  return { ok: true, reason: '', target };
}

function pickTarget(config, now, ledger, masterOverride = '') {
  const today = dayKey(now);
  const master = String(masterOverride || '').trim() || masterWxid(config);
  if (master) {
    const names = (config && config.persona && config.persona.master && config.persona.master.names) || [];
    const name = String(Array.isArray(names) ? names[0] || '' : '').trim();
    return { chatType: 'private', chatId: master, name };
  }
  const share = shareConfig(config);
  for (const entry of Array.isArray(share.chats) ? share.chats : []) {
    const chatId = String((entry && entry.chatId) || '').trim();
    if (!chatId) continue;
    const limit = Math.max(1, Number(entry.daily) || 1);
    const used = ledger.chats && ledger.chats[chatId] && ledger.chats[chatId].date === today
      ? Number(ledger.chats[chatId].count) || 0 : 0;
    if (used >= limit) continue;
    return { chatType: 'group', chatId, name: String(entry.name || '').trim() };
  }
  return null;
}

/** 入队（同 BV 已在队列里 / 已分享过 → 忽略）。 */
function enqueue(config, job) {
  const bvid = String((job && job.bvid) || '').trim();
  const text = String((job && job.text) || '').trim();
  const target = job && job.target;
  if (!bvid || !text || !target || !target.chatId) return { ok: false, reason: 'bad_job' };
  const ledger = readLedger(config);
  if (ledger.sent.some((row) => row && row.bvid === bvid)) return { ok: false, reason: 'already_shared' };
  const items = readOutbox(config);
  if (items.some((row) => row && row.bvid === bvid && row.status !== 'failed')) return { ok: false, reason: 'already_queued' };
  const item = {
    id: crypto.randomUUID(),
    at: Date.now(),
    bvid,
    title: String(job.title || '').slice(0, 120),
    text: text.slice(0, 300),
    chatType: target.chatType === 'group' ? 'group' : 'private',
    chatId: target.chatId,
    name: String(target.name || '').slice(0, 60),
    status: 'pending',
    error: '',
  };
  items.push(item);
  writeOutbox(config, items);
  biliStore.appendEvent(config, { kind: 'share_queued', bvid, chatType: item.chatType });
  return { ok: true, item };
}

function nextPending(config) {
  const items = readOutbox(config);
  const item = items.find((row) => row && row.status === 'pending');
  return item ? { ...item } : null;
}

/** pending → sending；重复领取返回 null（桥接据此放弃）。 */
function claim(config, id) {
  const items = readOutbox(config);
  const item = items.find((row) => row && row.id === id);
  if (!item || item.status !== 'pending') return null;
  item.status = 'sending';
  item.claimedAt = Date.now();
  writeOutbox(config, items);
  return { ...item };
}

/** sending → sent/failed；只有 sent 才计入配额与「已分享」。 */
function ack(config, id, status, error = '', now = new Date()) {
  const items = readOutbox(config);
  const item = items.find((row) => row && row.id === id);
  if (!item) return { ok: false, reason: 'not_found' };
  if (item.status === 'sent' || item.status === 'failed') return { ok: true, duplicate: true, item: { ...item } };
  item.status = status === 'sent' ? 'sent' : 'failed';
  item.error = String(error || '').slice(0, 200);
  item.ackedAt = now.getTime();
  writeOutbox(config, items);
  if (item.status === 'sent') {
    const today = dayKey(now);
    const ledger = readLedger(config);
    const chats = { ...ledger.chats };
    if (item.chatType === 'group') {
      const prev = chats[item.chatId] && chats[item.chatId].date === today ? Number(chats[item.chatId].count) || 0 : 0;
      chats[item.chatId] = { date: today, count: prev + 1 };
    }
    const sent = [...ledger.sent, { bvid: item.bvid, at: now.getTime() }].slice(-MAX_SENT_MEMORY);
    writeLedger(config, {
      date: today,
      dayCount: (ledger.date === today ? ledger.dayCount : 0) + 1,
      lastAt: now.getTime(),
      chats,
      sent,
    });
    biliStore.appendEvent(config, { kind: 'share_sent', bvid: item.bvid, chatType: item.chatType });
  } else {
    biliStore.appendEvent(config, { kind: 'share_failed', bvid: item.bvid, error: item.error.slice(0, 80) });
  }
  return { ok: true, item: { ...item } };
}

/** 清理：sending 超过 10 分钟（桥接崩了）视为失败，避免永远卡住。 */
function sweepStale(config, now = Date.now(), ttlMs = 10 * 60000) {
  const items = readOutbox(config);
  let changed = 0;
  for (const item of items) {
    if (item && item.status === 'sending' && item.claimedAt && now - item.claimedAt > ttlMs) {
      item.status = 'failed';
      item.error = 'timeout';
      item.ackedAt = now;
      changed += 1;
    }
  }
  if (changed) writeOutbox(config, items);
  return changed;
}

module.exports = {
  OUTBOX_FILE, SHARE_FILE, files, readLedger, dayKey, shareConfig, masterWxid,
  canShare, pickTarget, enqueue, nextPending, claim, ack, sweepStale,
};

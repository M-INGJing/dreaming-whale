'use strict';

/**
 * 收藏别人发的表情包：去重 → 落盘「待定」→ 交给分类 worker。
 *
 * 只做三件事：校验、查重、写文件；分类是异步的（见 stickerClassify.js），
 * 所以这个接口必须很快返回，不能拖住桥接收消息。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const features = require('../infra/features');
const stickers = require('../adapters/stickers');
const indexer = require('../infra/stickerIndex');
const dedup = require('../core/stickerDedup');

const PENDING_DIR = '待定';
const QUEUE_REL = 'collect-queue.json';
const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function collectConfig(config) {
  return (config && config.sticker && config.sticker.collect) || {};
}

function queueFile(config, root) {
  return path.join(stickers.stickerDir(config, root), QUEUE_REL);
}

function readQueue(config, root) {
  try {
    const raw = JSON.parse(fs.readFileSync(queueFile(config, root), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeQueue(config, root, jobs) {
  const file = queueFile(config, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jobs.slice(-200), null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function enqueue(config, root, job) {
  const jobs = readQueue(config, root);
  jobs.push(job);
  writeQueue(config, root, jobs);
}

function chatIdHash(chatId) {
  return crypto.createHash('sha256').update(String(chatId || '')).digest('hex').slice(0, 16);
}

/** 从记忆里取最近几条文本当语境；读不到就空数组。 */
function recentContext(runtime, chatType, chatId) {
  try {
    if (!runtime || !runtime.store) return [];
    const key = (chatType === 'group' ? 'wechat:g:' : 'wechat:u:') + chatId;
    const msgs = runtime.store.messages(key, 12) || [];
    return msgs
      .filter((m) => m && typeof m.text === 'string' && m.text.trim())
      .slice(-5)
      .map((m) => String(m.text).replace(/\s+/g, ' ').trim().slice(0, 120));
  } catch {
    return [];
  }
}

/**
 * @returns {{ok:boolean, duplicate?:boolean, sha?:string, reason?:string, queued?:boolean}}
 */
function collect(runtime, payload = {}, deps = {}) {
  const config = runtime.config;
  const root = runtime.config.root || deps.root || process.cwd();
  const now = deps.now || Date.now();
  const logger = runtime.logger || null;
  const cfg = collectConfig(config);
  if (!features.isOn(config, 'stickers')) return { ok: false, reason: 'feature_off' };
  if (cfg.enabled === false) return { ok: false, reason: 'collect_off' };
  const chatType = payload.chatType === 'group' ? 'group' : 'private';
  if (chatType === 'group' && cfg.fromGroups === false) return { ok: false, reason: 'group_off' };
  if (chatType === 'private' && cfg.fromPrivate === false) return { ok: false, reason: 'private_off' };

  let buffer;
  try {
    buffer = Buffer.from(String(payload.image || ''), 'base64');
  } catch {
    return { ok: false, reason: 'bad_base64' };
  }
  const maxBytes = Math.max(1024, Number(cfg.maxFileBytes) || 2 * 1024 * 1024);
  if (!buffer.length) return { ok: false, reason: 'empty' };
  if (buffer.length > maxBytes) return { ok: false, reason: 'too_large' };

  const ext = EXT_BY_MIME[String(payload.mime || '').toLowerCase()] || dedup.extOf(payload.name || '') || '.png';
  if (!stickers.EXTS.includes(ext)) return { ok: false, reason: 'bad_ext' };
  const dhash = dedup.validHash(payload.dhash) ? String(payload.dhash).toLowerCase() : '';

  const sha = indexer.sha256(buffer);
  const dir = stickers.stickerDir(config, root);
  let index = indexer.ensure(config, root);

  const existing = index.items[sha];
  if (existing) {
    existing.seen = (Number(existing.seen) || 1) + 1;
    existing.lastSeenAt = now;
    if (dhash && !existing.dhash) existing.dhash = dhash;
    indexer.save(config, root, index);
    return { ok: true, duplicate: true, reason: 'exact', sha, category: existing.category };
  }

  if (dhash) {
    const items = Object.entries(index.items).map(([key, row]) => ({ sha256: key, ...row }));
    const near = dedup.findNear(items, { dhash, ext }, {
      distance: Math.max(0, Math.min(32, Number(cfg.dhashDistance) || 6)),
      sameFormatOnly: cfg.sameFormatOnly !== false,
    });
    if (near) {
      const hit = near.item;
      if (hit.sha256 && index.items[hit.sha256]) {
        const row = index.items[hit.sha256];
        row.seen = (Number(row.seen) || 1) + 1;
        row.lastSeenAt = now;
        indexer.save(config, root, index);
      }
      return { ok: true, duplicate: true, reason: 'near', sha, category: hit.category || '待定' };
    }
  }

  const maxPerDay = Math.max(0, Number(cfg.maxPerDay) || 0);
  if (maxPerDay && indexer.countAddedToday(index, now) >= maxPerDay) {
    return { ok: false, reason: 'daily_cap' };
  }

  const pendingDir = path.join(dir, PENDING_DIR);
  fs.mkdirSync(pendingDir, { recursive: true });
  const name = sha.slice(0, 12) + ext;
  const file = path.join(pendingDir, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);

  index.items[sha] = {
    file: PENDING_DIR + '/' + name,
    dhash,
    category: PENDING_DIR,
    confidence: 0,
    tags: [],
    description: '',
    // 人工确认过没有？没确认就一直留在「收藏待定」（即使已经自动归类）
    reviewed: false,
    source: {
      chatType,
      chatIdHash: chatIdHash(payload.chatId || ''),
      sender: String(payload.sender || '').slice(0, 40),
    },
    addedAt: now,
    seen: 1,
    lastSeenAt: now,
  };
  indexer.save(config, root, index);

  enqueue(config, root, {
    sha,
    chatType,
    recent: Array.isArray(payload.recent) ? payload.recent.slice(-5) : recentContext(runtime, chatType, payload.chatId),
    at: now,
  });
  logger?.info?.('[sticker] 收藏候选：sha=' + sha.slice(0, 8) + ' 大小=' + buffer.length + 'B 来源=' + chatType);
  return { ok: true, duplicate: false, sha, queued: true };
}

function status(runtime) {
  const config = runtime.config;
  const root = config.root || process.cwd();
  const index = indexer.ensure(config, root);
  const pending = Object.entries(index.items).filter(([, row]) => row && row.category === PENDING_DIR);
  const today = indexer.countAddedToday(index, Date.now());
  const queue = readQueue(config, root);
  return {
    enabled: features.isOn(config, 'stickers') && collectConfig(config).enabled !== false,
    total: Object.keys(index.items).length,
    pending: pending.length,
    today,
    queued: queue.length,
  };
}

/**
 * 「收藏待定」= 还没人工确认过的（reviewed !== true），不按分类算。
 * 自动归类之后仍然留在待定里，直到人工归档或删除；这样不会「下次点开就消失」。
 */
function pendingList(runtime, limit = 50) {
  const config = runtime.config;
  const root = config.root || process.cwd();
  const index = indexer.ensure(config, root);
  const dir = stickers.stickerDir(config, root);
  const out = [];
  for (const [sha, row] of Object.entries(index.items)) {
    if (!row) continue;
    // 老数据没有 reviewed 字段：按分类判断，避免把历史 30 多张全塞进待定
    const unreviewed = row.reviewed === false || (row.reviewed === undefined && row.category === PENDING_DIR);
    if (!unreviewed) continue;
    out.push({
      sha,
      file: row.file,
      path: path.join(dir, row.file),
      description: row.description || '',
      category: row.category || '',
      confidence: row.confidence || 0,
      sender: (row.source && row.source.sender) || '',
      chatType: (row.source && row.source.chatType) || '',
      addedAt: row.addedAt || 0,
      seen: row.seen || 1,
    });
  }
  out.sort((a, b) => b.addedAt - a.addedAt);
  return out.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

/** 最近收进图库的（含已自动归类的），给界面展示「其实收进来了」。 */
function recentList(runtime, limit = 20) {
  const config = runtime.config;
  const root = config.root || process.cwd();
  const index = indexer.ensure(config, root);
  const dir = stickers.stickerDir(config, root);
  const out = [];
  for (const [sha, row] of Object.entries(index.items)) {
    if (!row) continue;
    if (row.reviewed === false) continue; // 未人工确认的只出现在「待定」里
    out.push({
      sha,
      file: row.file,
      path: path.join(dir, row.file),
      description: row.description || '',
      category: row.category || '',
      confidence: row.confidence || 0,
      sender: (row.source && row.source.sender) || '',
      chatType: (row.source && row.source.chatType) || '',
      addedAt: row.addedAt || 0,
      seen: row.seen || 1,
    });
  }
  out.sort((a, b) => b.addedAt - a.addedAt);
  return out.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
}

module.exports = {
  PENDING_DIR, QUEUE_REL, collectConfig, collect, status, pendingList, recentList,
  readQueue, writeQueue, enqueue, chatIdHash, recentContext,
};

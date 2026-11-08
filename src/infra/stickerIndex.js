'use strict';

/**
 * 表情包收藏索引（data/stickers/index.json）。
 *
 * 索引是「唯一真相」：每个已知表情一行，主键是 sha256。
 * 目录只存文件，不靠目录结构反推分类（分类可能被人工改）。
 * 索引丢了能重建：扫目录算 sha256，分类按当前所在目录推断。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const stickers = require('../adapters/stickers');
const dedup = require('../core/stickerDedup');

const INDEX_REL = 'index.json';
const VERSION = 1;

function indexFile(config, root) {
  return path.join(stickers.stickerDir(config, root), INDEX_REL);
}

function emptyIndex() {
  return { version: VERSION, items: {}, pending: [] };
}

function load(config, root) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(config, root), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object') return emptyIndex();
    return {
      version: VERSION,
      items: raw.items,
      pending: Array.isArray(raw.pending) ? raw.pending.filter((x) => typeof x === 'string') : [],
    };
  } catch {
    return null; // 区分「没有」和「坏了」：调用方决定是否重建
  }
}

function save(config, root, index) {
  const file = indexFile(config, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({
    version: VERSION,
    items: index.items || {},
    pending: Array.isArray(index.pending) ? index.pending : [],
  }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function relOf(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function categoryOfRel(rel, root) {
  const parts = String(rel).split('/');
  if (parts.length < 2) return '开心';
  const dir = parts[0];
  if (dir === '待定' || dir === 'index.json') return '待定';
  return dir;
}

/**
 * 扫目录重建索引：不信任文件里的旧数据。
 * 只算 sha256，不算 dHash（Node 没有图片解码，dHash 由桥接之后补）。
 */
function rebuild(config, root) {
  const dir = stickers.stickerDir(config, root);
  const index = emptyIndex();
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      if (!stickers.EXTS.includes(dedup.extOf(entry.name))) continue;
      let buf;
      try { buf = fs.readFileSync(full); } catch { continue; }
      const sha = sha256(buf);
      const rel = relOf(dir, full);
      let stat = null;
      try { stat = fs.statSync(full); } catch { /* 读不到就 0 */ }
      index.items[sha] = {
        file: rel,
        dhash: '',
        category: categoryOfRel(rel, root),
        confidence: 0,
        tags: [],
        description: '',
        source: { chatType: '', chatIdHash: '', sender: '' },
        addedAt: stat ? Math.round(stat.mtimeMs) : Date.now(),
        seen: 1,
        lastSeenAt: stat ? Math.round(stat.mtimeMs) : Date.now(),
      };
    }
  };
  walk(dir);
  save(config, root, index);
  return index;
}

/** 读取索引；不存在或损坏时重建。 */
function ensure(config, root) {
  const existing = load(config, root);
  if (existing) return existing;
  return rebuild(config, root);
}

function listByCategory(index, category) {
  return Object.values(index.items || {}).filter((row) => row && row.category === category);
}

function countAddedToday(index, now = Date.now()) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Object.values(index.items || {}).filter((row) => row && Number(row.addedAt) >= start).length;
}

module.exports = {
  INDEX_REL, VERSION, indexFile, emptyIndex, load, save, sha256, rebuild, ensure,
  listByCategory, countAddedToday, categoryOfRel, relOf,
};

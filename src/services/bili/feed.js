'use strict';

/**
 * B 站「首页推荐 / 热门」候选拉取。只读、可注入 client，便于离线测试。
 *
 * 优先 wbi 推荐流（更像「刷首页」），失败退回热门榜；两边字段不同，统一归一化。
 */

const path = require('node:path');
const { createClient } = require('../../adapters/bili/api');
const { readCookie } = require('../../infra/biliCookie');

const RCMD_PATH = '/x/web-interface/wbi/index/top/feed/rcmd';
const POPULAR_PATH = '/x/web-interface/popular';

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bvid = String(raw.bvid || '').trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return null;
  return {
    bvid,
    title: clip(raw.title, 120),
    desc: clip(raw.desc, 300),
    durationSec: Number(raw.duration) || 0,
    pubdate: Number(raw.pubdate) || 0,
    owner: { mid: String(raw.owner?.mid || ''), name: clip(raw.owner?.name, 40) },
    stat: { view: Number(raw.stat?.view) || 0, like: Number(raw.stat?.like) || 0 },
    cover: String(raw.pic || raw.cover || ''),
  };
}

function pickList(body, kind) {
  if (!body || typeof body !== 'object') return [];
  if (kind === 'rcmd') {
    const items = body.data && body.data.item;
    return Array.isArray(items) ? items : [];
  }
  const list = body.data && body.data.list;
  return Array.isArray(list) ? list : [];
}

/**
 * @param {object} config runtime config（推 cookie 路径）
 * @param {object} [deps] { client, limit, logger }
 * @returns {Promise<{source:string, items:object[], reason:string}>}
 */
async function fetchFeed(config, deps = {}) {
  const root = config && config.paths && config.paths.dataDir
    ? path.resolve(config.paths.dataDir, '..') : process.cwd();
  const cookie = deps.cookie != null ? deps.cookie : readCookie(root).cookie;
  const client = deps.client || createClient({ cookie, timeoutMs: 8000, retry: 1 });
  const limit = Math.max(1, Math.min(50, Number(deps.limit) || 20));
  const logger = deps.logger || null;

  try {
    const body = await client.request(RCMD_PATH, { ps: limit, fresh_type: 3, feed_version: 'V8' }, { needWbi: true });
    const items = pickList(body, 'rcmd').map(normalizeItem).filter(Boolean);
    if (items.length) return { source: 'rcmd', items, reason: '' };
  } catch (err) {
    logger?.warn?.('[bili] 推荐流失败 code=' + (err && err.code ? err.code : 'unknown') + '，改用热门');
  }
  try {
    const body = await client.request(POPULAR_PATH, { ps: limit, pn: 1 }, { needWbi: false });
    const items = pickList(body, 'popular').map(normalizeItem).filter(Boolean);
    return { source: 'popular', items, reason: items.length ? '' : 'empty' };
  } catch (err) {
    return { source: 'none', items: [], reason: (err && err.code) || 'fetch_failed' };
  }
}

module.exports = { fetchFeed, normalizeItem, RCMD_PATH, POPULAR_PATH };

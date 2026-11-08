'use strict';

/**
 * 扫码登录的「服务端状态机」：内核里只允许同时挂一个二维码。
 *
 * 依赖全部可注入（generate / poll / png / cookie 读写 / logger），路由层只做 HTTP 包装，
 * 测试里换成假实现即可完全离线。
 */

const path = require('node:path');
const login = require('../adapters/bili/login');
const qr = require('../adapters/bili/qr');
const cookieStore = require('../infra/biliCookie');

function createBiliLogin(opts = {}) {
  const generate = opts.generate || login.generate;
  const poll = opts.poll || login.poll;
  const renderPng = opts.renderPng || qr.png;
  const readCookie = opts.readCookie || cookieStore.readCookie;
  const writeCookie = opts.writeCookie || cookieStore.writeCookie;
  const logger = opts.logger || null;
  const now = opts.now || (() => Date.now());
  const fixedRoot = opts.root || '';

  let pending = null; // { key, at }
  let statusCache = { at: 0, value: null };
  const TTL = Number.isFinite(opts.statusTtlMs) ? opts.statusTtlMs : 60 * 1000;

  function rootOf(config) {
    if (fixedRoot) return fixedRoot;
    return config && config.paths && config.paths.dataDir
      ? path.resolve(config.paths.dataDir, '..') : process.cwd();
  }

  async function start(config) {
    const out = await generate();
    const png = renderPng(out.url, { scale: 8, quiet: 4 });
    pending = { key: out.key, at: now() };
    statusCache = { at: 0, value: null };
    return { url: out.url, expiresInSec: out.expiresInSec, pngBase64: png.toString('base64') };
  }

  async function pollOnce(config) {
    if (!pending) return { state: 'idle' };
    const out = await poll(pending.key);
    if (out.state === 'ok') {
      const saved = writeCookie(rootOf(config), out.cookie);
      pending = null;
      statusCache = { at: 0, value: null };
      return { state: 'ok', saved: Boolean(saved && saved.hasCookie) };
    }
    if (out.state === 'expired' || out.state === 'error') pending = null;
    return { state: out.state, code: out.code || 0, message: out.message || '' };
  }

  function cancel() {
    pending = null;
  }

  async function status(config) {
    const root = rootOf(config);
    const info = readCookie(root);
    let live = { loggedIn: false, wbiReady: false, nameLength: 0 };
    if (info.hasCookie) {
      if (!statusCache.value || now() - statusCache.at > TTL) {
        try {
          const client = (opts.createClient || require('../adapters/bili/api').createClient)({ cookie: info.cookie });
          live = await client.status();
          statusCache = { at: now(), value: live };
        } catch (err) {
          logger?.warn?.('[bili] status 失败 code=' + (err && err.code ? err.code : 'unknown'));
          statusCache = { at: now(), value: live };
        }
      }
      live = statusCache.value || live;
    }
    return {
      cookie: { present: info.hasCookie, updatedAt: info.updatedAt },
      loggedIn: Boolean(live.loggedIn),
      wbiReady: Boolean(live.wbiReady),
      pending: pending ? { issuedAt: pending.at } : null,
    };
  }

  function logout(config) {
    pending = null;
    statusCache = { at: 0, value: null };
    const root = rootOf(config);
    const file = cookieStore.cookiePath(root);
    try { require('node:fs').rmSync(file, { force: true }); } catch { /* 删不掉就当没登录 */ }
    return { removed: true };
  }

  return { start, pollOnce, cancel, status, logout, rootOf };
}

module.exports = { createBiliLogin };

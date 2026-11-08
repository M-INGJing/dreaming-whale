'use strict';

/**
 * B 站 API 客户端（只读部分）。
 *
 * 设计取舍：
 *  - 网络走 `src/adapters/search/transport` 的 `getJson`（已有超时/HTTP 错误归一/大小上限），
 *    这里只负责：cookie、Referer、WBI 签名、全局限速、nav 密钥缓存、code!==0 的统一错误；
 *  - 所有依赖（fetch 实现、时间、sleep）都可注入，测试不联网；
 *  - 不在任何日志/错误里带 cookie 内容（只记长度）。
 */

const { getJson } = require('../search/transport');
const wbi = require('./wbi');

const API_ORIGIN = 'https://api.bilibili.com';
const NAV_URL = API_ORIGIN + '/x/web-interface/nav';
const NAV_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_GAP_MS = 1500;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} [opts]
 * @param {(url: string, opts?: object) => Promise<object>} [opts.getJson]
 * @param {string} [opts.cookie] B 站 cookie 串（不打印）
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.gapMs] 两次请求最小间隔
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retry] 网络/5xx 重试次数（默认 1）
 */
function createClient(opts = {}) {
  const fetchJson = opts.getJson || getJson;
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || sleepMs;
  const gapMs = Number.isFinite(opts.gapMs) ? Math.max(0, opts.gapMs) : DEFAULT_GAP_MS;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const retry = Number.isFinite(opts.retry) ? Math.max(0, opts.retry) : 1;
  const cookie = String(opts.cookie || '').trim();
  const trace = typeof opts.trace === 'function' ? opts.trace : null;

  let lastRequestAt = null;
  let navCache = null;
  let navFetchedAt = 0;

  function headers() {
    const out = { Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' };
    if (cookie) out.Cookie = cookie;
    return out;
  }

  async function pace() {
    if (lastRequestAt != null) {
      const wait = lastRequestAt + gapMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt = now();
  }

  function report(stage, data) {
    try { trace?.(stage, data); } catch { /* 诊断失败不改请求结果 */ }
  }

  async function request(path, params = {}, options = {}) {
    const url = new URL(path.startsWith('http') ? path : API_ORIGIN + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    if (options.needWbi) {
      const keys = await wbiKeys();
      url.search = wbi.sign(url.searchParams, keys.imgUrl, keys.subUrl, Math.floor(now() / 1000));
    }
    let attempt = 0;
    for (;;) {
      await pace();
      const started = now();
      try {
        const body = await fetchJson(url.toString(), {
          headers: headers(),
          timeoutMs: options.timeoutMs || timeoutMs,
          signal: options.signal,
        });
        report('bili_request', { path: url.pathname, ms: now() - started, attempt, ok: true });
        if (body && typeof body === 'object' && body.code !== undefined && body.code !== 0 && !options.allowApiError) {
          throw new wbi.BiliError(String(body.message || 'B 站接口返回错误'), 'bili_api_' + body.code, 0);
        }
        return body;
      } catch (err) {
        const retryable = !(err instanceof wbi.BiliError) || /^bili_api_-?5\d\d$/.test(err.code || '');
        report('bili_request', { path: url.pathname, ms: now() - started, attempt,
          ok: false, code: err?.code || 'network_error' });
        if (attempt >= retry || !retryable || options.signal?.aborted) throw err;
        attempt += 1;
        await sleep(Math.min(4000, 400 * attempt * attempt));
        lastRequestAt = now();
      }
    }
  }

  /** nav 的 WBI 密钥（10 分钟缓存；未登录也能拿到，只是后续接口会 401/未登录）。 */
  async function wbiKeys() {
    if (navCache && now() - navFetchedAt < NAV_TTL_MS) return navCache;
    // 未登录时 nav 会回 code=-101，但 data.wbi_img 仍在——匿名读视频就是靠它签名，
    // 所以这里不能因为 -101 就放弃（否则不登录连公开视频都看不了）。
    const body = await request('/x/web-interface/nav', {}, { allowApiError: true });
    const img = body?.data?.wbi_img?.img_url;
    const sub = body?.data?.wbi_img?.sub_url;
    if (!img || !sub) throw new wbi.BiliError('没有拿到 WBI 密钥（未知风控或接口变更）', 'wbi_key_missing');
    navCache = {
      imgUrl: img,
      subUrl: sub,
      loggedIn: Boolean(body?.data?.isLogin),
      nameLength: String(body?.data?.uname || '').length,
    };
    navFetchedAt = now();
    return navCache;
  }

  /** 登录态 + WBI 密钥（给「扫码后是否生效」用；只回布尔与昵称长度，不回 uid）。 */
  async function status() {
    let keys = null;
    try { keys = await wbiKeys(); } catch { keys = null; }
    return {
      loggedIn: Boolean(keys?.loggedIn),
      nameLength: Number(keys?.nameLength) || 0,
      wbiReady: Boolean(keys?.imgUrl && keys?.subUrl),
    };
  }

  return { request, wbiKeys, status, cookieLength: cookie.length, gapMs, timeoutMs };
}

module.exports = { createClient, API_ORIGIN, NAV_TTL_MS, DEFAULT_TIMEOUT_MS, DEFAULT_GAP_MS };

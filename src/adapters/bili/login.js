'use strict';

/**
 * B 站扫码登录（passport 的二维码接口）。
 *
 * 流程：
 *   generate → 得到 {url, qrcode_key} → 渲染二维码给人扫
 *   poll     → 86101 未扫 / 86090 已扫未确认 / 86038 过期 / 0 成功（Set-Cookie 里带 SESSDATA 等）
 *
 * 只做「拿 cookie」，不落盘（落盘由调用方用 infra/biliCookie 写），也不打印凭证。
 */

const GEN_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';

const STATE = {
  0: 'ok',
  86101: 'waiting',
  86090: 'scanned',
  86038: 'expired',
};

function pickHttp(deps) {
  const http = deps && deps.http;
  if (typeof http !== 'function') {
    // 延迟 require，避免测试环境加载 https
    return require('./qr').jsonRequest;
  }
  return http;
}

/** 申请二维码：返回 { url, key, expiresInSec }。 */
async function generate(deps = {}) {
  const http = pickHttp(deps);
  const res = await http(GEN_URL, { timeoutMs: deps.timeoutMs || 8000 });
  const data = res && res.json && res.json.data;
  if (!data || !data.url || !data.qrcode_key) {
    throw Object.assign(new Error('生成二维码失败'), { code: 'qr_generate_failed' });
  }
  return { url: String(data.url), key: String(data.qrcode_key), expiresInSec: 180 };
}

/**
 * 轮询一次。返回 { state, cookie?, code? }：
 *  - waiting / scanned：继续等
 *  - expired：要重新 generate
 *  - ok：cookie 为 `SESSDATA=…; bili_jct=…` 串
 */
async function poll(key, deps = {}) {
  if (!key) throw Object.assign(new Error('缺少 qrcode_key'), { code: 'qr_key_missing' });
  const http = pickHttp(deps);
  const url = POLL_URL + '?qrcode_key=' + encodeURIComponent(key);
  const res = await http(url, { timeoutMs: deps.timeoutMs || 8000 });
  const body = res && res.json;
  if (!body || typeof body.code !== 'number') {
    return { state: 'error', code: 'poll_bad_response' };
  }
  if (body.code !== 0) {
    const mapped = STATE[body.data && body.data.code] || STATE[body.code];
    if (mapped) return { state: mapped, code: body.data ? body.data.code : body.code };
    return { state: 'error', code: body.code, message: String(body.message || '') };
  }
  const data = body.data || {};
  // 成功时可能有两层 code：body.code=0 且 data.code=0
  const inner = STATE[data.code];
  if (data.code !== 0 && inner) return { state: inner, code: data.code };
  const { cookieFromSetCookie } = require('./qr');
  const cookie = cookieFromSetCookie(res.setCookie || []);
  if (!cookie) return { state: 'error', code: 'cookie_missing' };
  return { state: 'ok', cookie, code: 0 };
}

module.exports = { generate, poll, STATE, GEN_URL, POLL_URL };

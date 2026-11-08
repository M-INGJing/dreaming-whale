'use strict';

/**
 * B 站 WBI 签名（2023 起 `/x/web-interface/view` 等接口必须带 `w_rid`）。
 *
 * 纯函数、只用 node:crypto，不联网——方便单测固定向量，签名漂移时立刻能发现。
 * 算法：nav 接口给的 img_url / sub_url 各取文件名，拼成 64 字符，按固定混淆表
 * 取前 32 位当 mixinKey；参数按 key 排序拼 query，过滤 `!'()*` 后加 wts，
 * md5(query + mixinKey) 即 w_rid。
 */

// 官方 JS 里的混淆表，顺序不能改（改了就签不出来）。
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const FORBIDDEN = /[!'()*]/g;

/** 带 code 的错误：adapter 层统一抛它，调用方只看 code/status，不解析文案。 */
class BiliError extends Error {
  constructor(message, code = 'bili_error', status = 0) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.status = status;
    this.detail = code;
  }
}

function baseName(url) {
  const text = String(url || '');
  const cut = text.lastIndexOf('/');
  return (cut >= 0 ? text.slice(cut + 1) : text).split('?')[0].split('.')[0];
}

/** nav 返回的两个 URL → 32 位 mixinKey；任一缺失直接抛，绝不拿半截密钥签名。 */
function mixinKey(imgUrl, subUrl) {
  const img = baseName(imgUrl);
  const sub = baseName(subUrl);
  // 官方密钥固定是两段 32 字符；长度不对说明 nav 没登录或接口改版。
  if (!img || !sub || img.length !== 32 || sub.length !== 32) {
    throw new BiliError('WBI 密钥不完整（nav 未登录或接口变更）', 'wbi_key_missing');
  }
  const raw = img + sub;
  let out = '';
  for (const idx of MIXIN_KEY_ENC_TAB) {
    const ch = raw[idx];
    if (ch) out += ch;
  }
  if (out.length < 32) throw new ValueError('WBI 密钥长度不足', 'wbi_key_short');
  return out.slice(0, 32);
}

function filterValue(value) {
  return String(value == null ? '' : value).replace(FORBIDDEN, '');
}

/**
 * 为参数签名，返回完整 query string（含 wts 与 w_rid）。
 * @param {Record<string, unknown>|URLSearchParams} params
 * @param {string} imgUrl nav 的 img_url
 * @param {string} subUrl nav 的 sub_url
 * @param {number} wts 秒级时间戳（注入以便测试）
 */
function sign(params, imgUrl, subUrl, wts = Math.floor(Date.now() / 1000)) {
  const key = mixinKey(imgUrl, subUrl);
  const pairs = [];
  const source = params instanceof URLSearchParams
    ? Array.from(params.entries())
    : Object.entries(params || {});
  for (const [k, v] of source) {
    if (v === undefined || v === null || v === '') continue;
    pairs.push([filterValue(k), filterValue(v)]);
  }
  pairs.push(['wts', String(wts)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const query = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const rid = require('node:crypto').createHash('md5').update(query + key).digest('hex');
  return `${query}&w_rid=${rid}`;
}

module.exports = { MIXIN_KEY_ENC_TAB, mixinKey, filterValue, sign, baseName, BiliError };

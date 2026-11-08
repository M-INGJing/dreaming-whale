'use strict';

/**
 * 「看一个 B 站视频」→ 一段能塞进提示词的资料。
 *
 * 只读、可注入依赖，方便离线测试：
 *  - 默认走 adapters/bili（真网络、可无 cookie）；
 *  - 测试里把 client / watchMaterials 换掉即可，不联网。
 *
 * 失败一律降级成空串：读不到视频不该让这条消息不回。
 */

const path = require('node:path');
const { createClient } = require('../adapters/bili/api');
const endpoints = require('../adapters/bili/endpoints');
const { readCookieFor } = require('../infra/biliCookie');
const { resolveUrl: resolveShortUrl } = require('./bili/resolve');

const MARK = '【B站视频】';
const DIGEST_MAX = 1200;
const SUBTITLE_EXCERPT = 700;
const DESC_EXCERPT = 220;
const REPLY_MAX = 2;
const TIMEOUT_MS = 6000;

/** 只认 bilibili.com 的视频页；b23.tv / bili2233.cn 短链要先解析（见 isShortLink / readVideo）。 */
function isVideoUrl(url) {
  try {
    const u = new URL(String(url || ''));
    const host = u.hostname.toLowerCase();
    if (host === 'b23.tv' || host.endsWith('.b23.tv')) return false;
    if (host === 'bili2233.cn' || host.endsWith('.bili2233.cn')) return false;
    if (host !== 'bilibili.com' && !host.endsWith('.bilibili.com')) return false;
    return /\/video\//.test(u.pathname) || Boolean(endpoints.parseBvid(String(url || '')));
  } catch {
    return false;
  }
}

/** 短链（b23.tv / bili2233.cn）：需要跟一次 302 才能拿到真正的视频地址。 */
function isShortLink(url) {
  try {
    const u = new URL(String(url || ''));
    const host = u.hostname.toLowerCase();
    return host === 'b23.tv' || host.endsWith('.b23.tv') || host === 'bili2233.cn' || host.endsWith('.bili2233.cn');
  } catch {
    return false;
  }
}

/** 把「可能是短链」的地址解析成视频页地址；解析不到返回 ''。 */
async function resolveVideoUrl(url, deps = {}) {
  const resolve = deps.resolveUrl || resolveShortUrl;
  try {
    return await resolve(url, deps.resolveDeps || {});
  } catch {
    return '';
  }
}

function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + '万';
  return String(v);
}

function fmtDuration(sec) {
  const s = Math.max(0, Number(sec) || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/**
 * 把 watchMaterials 的结果拼成提示词片段。纯函数，便于断言格式与截断。
 * @param {{info: object, subtitle: {text: string, lang?: string, reason?: string}, replies: object[]}} materials
 */
function buildDigest(materials) {
  const info = (materials && materials.info) || {};
  const subtitle = (materials && materials.subtitle) || {};
  const replies = Array.isArray(materials && materials.replies) ? materials.replies : [];
  const head = [MARK + String(info.title || '（无标题）')];
  head.push(`UP：${info.owner && info.owner.name ? info.owner.name : '未知'}｜时长 ${fmtDuration(info.durationSec)}｜播放 ${fmtCount(info.stat && info.stat.view)}｜点赞 ${fmtCount(info.stat && info.stat.like)}`);
  if (info.desc) head.push('简介：' + String(info.desc).slice(0, DESC_EXCERPT));

  const lines = [];
  const subText = String(subtitle.text || '').trim();
  if (subText) {
    lines.push('字幕摘录：' + subText.slice(0, SUBTITLE_EXCERPT));
  } else {
    lines.push('（这个视频没有字幕，你只看到标题/简介和热评，没看到画面。）');
  }
  const picked = replies.filter((r) => r && r.text).slice(0, REPLY_MAX)
    .map((r) => `${r.author || '网友'}：${String(r.text).slice(0, 80)}`);
  if (picked.length) lines.push('热评：' + picked.join(' ／ '));

  const body = [...head, ...lines].join('\n');
  return body.length > DIGEST_MAX ? body.slice(0, DIGEST_MAX) + '…' : body;
}

/**
 * @param {object} config runtime config（只用来推 dataDir）
 * @param {string} url 视频链接或 BV
 * @param {object} [deps] { client, watchMaterials, cookie, root, logger }
 * @returns {Promise<string>} 失败返回 ''
 */
async function readVideo(config, url, deps = {}) {
  let target = String(url || '');
  if (isShortLink(target)) target = await resolveVideoUrl(target, deps);
  const bvid = endpoints.parseBvid(target);
  if (!bvid) return '';
  const logger = deps.logger || null;
  try {
    const root = deps.root
      || (config && config.paths && config.paths.dataDir ? path.resolve(config.paths.dataDir, '..') : process.cwd());
    const cookie = deps.cookie != null ? deps.cookie : readCookieFor(config).cookie;
    const client = deps.client || createClient({ cookie, timeoutMs: TIMEOUT_MS, retry: 0 });
    const readMaterials = deps.watchMaterials || endpoints.watchMaterials;
    const materials = await readMaterials(client, bvid);
    if (!materials || !materials.info || !materials.info.bvid) return '';
    return buildDigest(materials);
  } catch (err) {
    // 只记录结构信息：不打印 URL、不打印 cookie
    logger?.warn?.('[bili] 读取视频失败 code=' + (err && err.code ? err.code : 'unknown'));
    return '';
  }
}

/**
 * 和 readVideo 一样读一次，但把结构化的热评也返回（评论区的说话方式要从这里学）。
 * @returns {Promise<{digest:string, info:object|null, replies:object[]}>}
 */
async function readMaterials(config, url, deps = {}) {
  let target = String(url || '');
  if (isShortLink(target)) target = await resolveVideoUrl(target, deps);
  const bvid = endpoints.parseBvid(target);
  if (!bvid) return { digest: '', info: null, replies: [] };
  try {
    const root = deps.root
      || (config && config.paths && config.paths.dataDir ? path.resolve(config.paths.dataDir, '..') : process.cwd());
    const cookie = deps.cookie != null ? deps.cookie : readCookieFor(config).cookie;
    const client = deps.client || createClient({ cookie, timeoutMs: TIMEOUT_MS, retry: 0 });
    const readMaterialsFn = deps.watchMaterials || endpoints.watchMaterials;
    const materials = await readMaterialsFn(client, bvid);
    if (!materials || !materials.info || !materials.info.bvid) return { digest: '', info: null, replies: [] };
    return {
      digest: buildDigest(materials),
      info: materials.info,
      replies: Array.isArray(materials.replies) ? materials.replies : [],
    };
  } catch (err) {
    deps.logger?.warn?.('[bili] 读取视频失败 code=' + (err && err.code ? err.code : 'unknown'));
    return { digest: '', info: null, replies: [] };
  }
}

module.exports = {
  MARK, DIGEST_MAX, SUBTITLE_EXCERPT, isVideoUrl, isShortLink, resolveVideoUrl,
  buildDigest, readVideo, readMaterials, fmtCount, fmtDuration,
};

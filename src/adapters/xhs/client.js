'use strict';

/**
 * 小红书平台客户端：调本机 xiaohongshu-mcp 服务（HTTP）。
 * 只做「请求 → 归一化 → 错误分级」，不碰聊天回复；transport 可注入，测试不联网。
 *
 * 参考 dsh-xhs-whale（lib/xhs.js）与 dafeiyu-bot（docs/XIAOHONGSHU.md）的约定：
 *  - 读写分离：搜索 / 详情是只读；发布是写入（高风险，调用方要人工确认 + 额度）；
 *  - 结果分级：发布「点了按钮≠成功」，拿不到确认就是 uncertain，绝不自动重发；
 *  - 验证 / 风控：登录过期、验证码、限流 → XhsVerificationError，暂停并交人工。
 */

const http = require('node:http');
const https = require('node:https');

class XhsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'XhsError';
    this.code = code;
    if (extra.status) this.status = extra.status;
    if (extra.delivery) this.delivery = extra.delivery; // 'not_sent' | 'uncertain'
  }
}

class XhsVerificationError extends XhsError {
  constructor(message) {
    super('verification_required', message);
    this.name = 'XhsVerificationError';
  }
}

/** 互动数："12" / "1.2万" / "3k" → 数字 */
function parseCount(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return 0;
  const m = value.match(/^([\d.]+)\s*(万|w|W|k|K)?/);
  if (!m) return 0;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return 0;
  if (m[2] === '万' || m[2] === 'w' || m[2] === 'W') return Math.round(base * 10000);
  if (m[2] === 'k' || m[2] === 'K') return Math.round(base * 1000);
  return Math.round(base);
}

function text(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function safeImageUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return '';
    if (!['xhscdn.com', 'xiaohongshu.com'].some((d) => u.hostname === d || u.hostname.endsWith('.' + d))) return '';
    u.protocol = 'https:';
    return u.href;
  } catch { return ''; }
}

function imageUrl(img) {
  return safeImageUrl(img && (img.urlDefault || img.url || img.urlPre || (img.infoList && img.infoList[0] && img.infoList[0].url)));
}

function user(u = {}) {
  return { id: text(u.userId || u.user_id, 100), name: text(u.nickname || u.nickName, 100) };
}

function normalizeFeeds(data) {
  const rows = Array.isArray(data) ? data : (data && data.feeds);
  if (!Array.isArray(rows)) throw new XhsError('bad_shape', '搜索结果结构不对，请检查小红书服务版本');
  return rows
    .filter((r) => r && r.id && r.noteCard)
    .map((r) => ({
      id: String(r.id),
      token: text(r.xsecToken, 2000),
      title: text(r.noteCard.displayTitle || r.noteCard.title, 300),
      type: r.noteCard.type || 'normal',
      author: user(r.noteCard.user),
      cover: imageUrl(r.noteCard.cover),
      likes: parseCount(r.noteCard.interactInfo && r.noteCard.interactInfo.likedCount),
      commentCount: parseCount(r.noteCard.interactInfo && r.noteCard.interactInfo.commentCount),
      url: `https://www.xiaohongshu.com/explore/${encodeURIComponent(r.id)}`,
    }));
}

function normalizeDetail(data, candidate) {
  const root = (data && data.data) || data;
  const note = root && root.note;
  if (!note || !note.noteId || String(note.noteId) !== String(candidate && candidate.id)) {
    throw new XhsError('bad_shape', '笔记详情缺失或返回了不同笔记');
  }
  const comments = [];
  const walk = (rows, parentId, depth) => {
    if (depth > 5 || !Array.isArray(rows)) return;
    for (const c of rows) {
      if (!c.id || comments.length >= 200) continue;
      comments.push({
        id: String(c.id), parentId, text: text(c.content, 2000), author: user(c.userInfo),
        subCount: Number(c.subCommentCount || 0), at: c.createTime || null,
      });
      walk(c.subComments, String(c.id), depth + 1);
    }
  };
  walk(root.comments && root.comments.list);
  const rawImages = Array.isArray(note.imageList) ? note.imageList : [];
  const interact = note.interactInfo || {};
  return {
    ...candidate,
    token: text((candidate && candidate.token) || note.xsecToken, 2000),
    title: text(note.title || (candidate && candidate.title), 300),
    body: text(note.desc, 20000),
    type: note.type || (candidate && candidate.type),
    author: user(note.user),
    comments,
    commentCount: parseCount(interact.commentCount),
    likedCount: parseCount(interact.likedCount),
    images: rawImages.map(imageUrl).filter(Boolean),
    url: candidate && candidate.url,
  };
}

/** 默认 transport：用 node http/https 直连本机服务（服务通常是 http://127.0.0.1） */
function defaultTransport(method, url, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (err) { reject(err); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(u, {
      method,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': payload.length } : {}), ...(headers || {}) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) { req.destroy(new Error('response_too_large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (raw) { try { json = JSON.parse(raw); } catch { /* 非 JSON */ } }
        resolve({ status: res.statusCode, json, text: raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const CAPTCHA_RE = /captcha|security.?verif|安全验证|验证码|风控|访问过于频繁|异常访问/i;
const LOGIN_RE = /请先登录|登录.*过期|重新登录|扫码/i;

class XhsClient {
  constructor({ baseUrl = '', token = '', timeoutMs = 120000, transport = null, logger = null } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = String(token || '');
    this.timeoutMs = Number(timeoutMs) || 120000;
    this.transport = transport || defaultTransport;
    this.logger = logger;
  }

  get ready() { return Boolean(this.baseUrl); }

  headers() { return this.token ? { Authorization: `Bearer ${this.token}` } : {}; }

  async request(route, body = null, method = 'POST') {
    if (!this.baseUrl) throw new XhsError('not_configured', '小红书服务地址没配置');
    let res;
    try {
      res = await this.transport(method, `${this.baseUrl}/api/v1${route}`, {
        headers: this.headers(), body, timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      throw new XhsError('service_unavailable', '小红书服务连不上或超时（检查服务是否启动）');
    }
    const status = res && res.status;
    const json = res && res.json;
    const details = String((json && (json.error || json.message || json.details)) || (res && res.text) || '').slice(0, 200);
    if (status === 401) throw new XhsError('auth_failed', '小红书服务鉴权失败，请检查服务令牌');
    if (LOGIN_RE.test(details)) throw new XhsVerificationError('小红书还没登录或登录已过期，请先扫码登录');
    if (CAPTCHA_RE.test(details)) throw new XhsVerificationError('小红书遇到验证码或风控，需要人工处理');
    if (status === 429) throw new XhsVerificationError('小红书限流了，先歇会儿再试');
    if (status && (status < 200 || status >= 300)) {
      const delivery = route === '/publish' ? 'uncertain' : undefined;
      throw new XhsError('upstream_error', `小红书操作失败（HTTP ${status}）`, { status, delivery });
    }
    // 服务端成功响应统一是 { success, data }，也可能是 { data }；取 data 层
    return json && typeof json === 'object' && 'data' in json ? json.data : json;
  }

  async loginStatus() {
    const data = await this.request('/login/status', null, 'GET');
    const d = data && data.data ? data.data : data;
    return { loggedIn: !!(d && (d.logged_in || d.loggedIn || d.user)), user: d && d.user };
  }

  async search(keyword, filters = {}) {
    const kw = String(keyword || '').trim();
    if (!kw) throw new XhsError('bad_arg', '搜什么？给我个关键词');
    const data = await this.request('/feeds/search', { keyword: kw, ...(Object.keys(filters).length ? { filters } : {}) });
    return normalizeFeeds(data);
  }

  async detail(note) {
    if (!note || !note.id || !note.token) throw new XhsError('bad_arg', '笔记信息不全，重新搜一次再试');
    const data = await this.request('/feeds/detail', { feed_id: note.id, xsec_token: note.token, load_all_comments: true });
    return normalizeDetail(data, note);
  }

  async publish(draft) {
    const title = String((draft && draft.title) || '').trim();
    const content = String((draft && draft.content) || '').trim();
    if (!title) throw new XhsError('bad_arg', '标题不能为空');
    if (!content) throw new XhsError('bad_arg', '正文不能为空');
    const images = Array.isArray(draft.images) ? draft.images.map((x) => String(x)).filter(Boolean) : [];
    if (!images.length) throw new XhsError('need_image', '小红书图文笔记至少要一张图');
    const data = await this.request('/publish', {
      title: title.slice(0, 20),
      content,
      tags: Array.isArray(draft.tags) ? draft.tags.slice(0, 10).map((x) => String(x)).filter(Boolean) : [],
      images,
      ...(draft.visibility ? { visibility: draft.visibility } : {}),
      ...(draft.isOriginal ? { is_original: true } : {}),
    });
    if (!data || typeof data !== 'object') {
      throw new XhsError('uncertain', '发布结果没拿到确认，需人工核对', { delivery: 'uncertain' });
    }
    return { ok: true, status: data.status || '发布完成', images: Number(data.images || images.length) };
  }
}

module.exports = {
  XhsClient, XhsError, XhsVerificationError, parseCount, normalizeFeeds, normalizeDetail, defaultTransport,
};

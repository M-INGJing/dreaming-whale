'use strict';

/**
 * B 站扫码登录用到的两件小事：
 *  1) `jsonRequest`：一次 https 请求，**带响应头**（扫码轮询要靠 Set-Cookie 拿 SESSDATA）；
 *     现有 search/transport 的 getJson 只回 body，所以这里单独实现一个最小版本。
 *  2) 二维码渲染（PNG / 终端 ASCII），矩阵来自 vendor/qrcode（MIT，原样 vendor）。
 *
 * 都不碰 cookie 的持久化，也不打印任何凭证。
 */

const https = require('node:https');
const zlib = require('node:zlib');
const qrcode = require('../../../vendor/qrcode/qrcode');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36';
const MAX_BYTES = 2 * 1024 * 1024;

function jsonRequest(url, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000;
  const method = opts.method || 'GET';
  const headers = { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', ...(opts.headers || {}) };
  if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    let req;
    const timer = setTimeout(() => done(Object.assign(new Error('请求超时'), { code: 'timeout' })), timeoutMs);
    try {
      const target = new URL(url);
      if (target.protocol !== 'https:') return done(Object.assign(new Error('只允许 https'), { code: 'unsupported_protocol' }));
      req = https.request(target, { method, headers }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) { res.destroy(); done(Object.assign(new Error('响应过大'), { code: 'too_large' })); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
          done(null, { status: res.statusCode || 0, headers: res.headers, setCookie: res.headers['set-cookie'] || [], json });
        });
        res.on('error', (err) => done(Object.assign(err, { code: 'network_error' })));
      });
      req.on('error', (err) => done(Object.assign(err, { code: 'network_error' })));
      if (opts.body) req.write(opts.body);
      req.end();
    } catch (err) { done(err); }
  });
}

/** 从 Set-Cookie 里挑出登录需要的几项，拼成 `a=b; c=d`。 */
const COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

function cookieFromSetCookie(setCookie) {
  const found = new Map();
  for (const line of setCookie || []) {
    const head = String(line || '').split(';')[0].trim();
    const idx = head.indexOf('=');
    if (idx <= 0) continue;
    const name = head.slice(0, idx).trim();
    const value = head.slice(idx + 1).trim();
    if (!COOKIE_NAMES.includes(name) || !value) continue;
    found.set(name, value);
  }
  return COOKIE_NAMES.filter((n) => found.has(n)).map((n) => `${n}=${found.get(n)}`).join('; ');
}

/** 文本 → 二维矩阵（1 = 深色）。纯函数，便于单测。 */
function matrix(text, opts = {}) {
  const ecl = String(opts.ecl || 'M');
  const qr = qrcode(0, ecl);
  qr.addData(String(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r += 1) {
    const row = [];
    for (let c = 0; c < n; c += 1) row.push(qr.isDark(r, c) ? 1 : 0);
    rows.push(row);
  }
  return rows;
}

/** 终端 ASCII 二维码（白色静默区，深色用 ██，方便直接扫）。 */
function ascii(text, opts = {}) {
  const rows = matrix(text, opts);
  const quiet = Number.isFinite(opts.quiet) ? opts.quiet : 2;
  const width = rows.length + quiet * 2;
  const blank = ' '.repeat(width * 2);
  const out = [];
  for (let i = 0; i < quiet; i += 1) out.push(blank);
  for (const row of rows) {
    let line = ' '.repeat(quiet * 2);
    for (const cell of row) line += cell ? '██' : '  ';
    out.push(line + ' '.repeat(quiet * 2));
  }
  for (let i = 0; i < quiet; i += 1) out.push(blank);
  return out.join('\n');
}

// ---- PNG（8 位灰度，无第三方依赖） ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 二维码 PNG：scale 像素/模块，quiet 模块静默区（默认 4）。 */
function png(text, opts = {}) {
  const rows = matrix(text, opts);
  const scale = Number.isFinite(opts.scale) ? Math.max(1, Math.min(20, opts.scale)) : 8;
  const quiet = Number.isFinite(opts.quiet) ? Math.max(0, Math.min(10, opts.quiet)) : 4;
  const modules = rows.length;
  const size = (modules + quiet * 2) * scale;
  const raw = Buffer.alloc((size + 1) * size, 255);
  for (let y = 0; y < size; y += 1) raw[y * (size + 1)] = 0; // filter: none
  for (let my = 0; my < modules; my += 1) {
    for (let mx = 0; mx < modules; mx += 1) {
      if (!rows[my][mx]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        const y = (my + quiet) * scale + dy;
        const offset = y * (size + 1) + 1 + (mx + quiet) * scale;
        raw.fill(0, offset, offset + scale);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // color type: grayscale
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { jsonRequest, cookieFromSetCookie, COOKIE_NAMES, matrix, ascii, png };

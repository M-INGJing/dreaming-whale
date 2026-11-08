'use strict';

/**
 * 短链解析：b23.tv / bili2233.cn → 真正的视频地址。
 *
 * 只跟 3 次 302，只读 Location；不发 cookie、不带 body。解析失败一律返回 ''，
 * 调用方退回普通链接阅读器，不重试、不猜 bvid。
 */

const https = require('node:https');

const MAX_HOPS = 3;

function headOnce(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { return resolve({ status: 0, location: '' }); }
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: 'HEAD',
      timeout: timeoutMs,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; whale-girl)' },
    }, (res) => {
      res.resume();
      resolve({ status: res.statusCode || 0, location: res.headers.location || '' });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', () => resolve({ status: 0, location: '' }));
    req.end();
  });
}

/**
 * @param {string} url
 * @param {{head?: (url:string)=>Promise<{status:number,location:string}>}} deps
 * @returns {Promise<string>} 解析不到返回 ''
 */
async function resolveUrl(url, deps = {}) {
  const head = deps.head || headOnce;
  let current = String(url || '').trim();
  if (!/^https?:\/\//i.test(current)) return '';
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    let res;
    try { res = await head(current); } catch { return ''; }
    const location = String((res && res.location) || '');
    if (!location) return current;
    try {
      current = new URL(location, current).toString();
    } catch {
      return '';
    }
  }
  return current;
}

module.exports = { resolveUrl, headOnce, MAX_HOPS };

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * B 站 cookie 的读取（只在需要登录的接口用；公开视频不读也能看）。
 *
 * 安全约定：
 *  - 只从 data/bili/cookie.json 读（data/ 已被 .gitignore 排除）；
 *  - 返回值只用于请求头，**不写日志、不进错误信息、不回接口**；
 *  - 文件缺失/损坏一律返回空串，让调用方按「未登录」降级，不抛异常打断聊天。
 */

const DEFAULT_REL = 'data/bili/cookie.json';

function cookiePath(root, rel = DEFAULT_REL) {
  const base = path.resolve(root || process.cwd());
  const target = path.resolve(base, rel);
  // 防止配置里用 ../ 把 cookie 指到工程目录外
  if (!target.startsWith(base + path.sep)) return path.join(base, DEFAULT_REL);
  return target;
}

/** @returns {{ cookie: string, hasCookie: boolean, updatedAt: number }} 绝不返回 cookie 内容以外的元信息 */
function readCookie(root, rel = DEFAULT_REL) {
  const file = cookiePath(root, rel);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const cookie = typeof data === 'string' ? data : String(data.cookie || '').trim();
    return {
      cookie,
      hasCookie: Boolean(cookie),
      updatedAt: Number(data && data.updatedAt) || Number(fs.statSync(file).mtimeMs) || 0,
    };
  } catch {
    return { cookie: '', hasCookie: false, updatedAt: 0 };
  }
}

/** 写 cookie（只有扫码登录成功时调用）；先写 .tmp 再 rename，避免读到半个文件。 */
function writeCookie(root, cookie, rel = DEFAULT_REL) {
  const file = cookiePath(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ cookie: String(cookie || '').trim(), updatedAt: Date.now() }, null, 2);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 上 chmod 只是尽力而为 */ }
  return { file, hasCookie: Boolean(cookie) };
}

module.exports = { DEFAULT_REL, cookiePath, readCookie, writeCookie };

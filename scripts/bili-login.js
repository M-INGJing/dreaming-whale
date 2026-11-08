#!/usr/bin/env node
'use strict';

/**
 * B 站扫码登录：终端里出二维码 → 手机 B 站 App 扫码确认 → cookie 落到 data/bili/cookie.json。
 *
 *   node scripts/bili-login.js              二维码 + 轮询（最长 180 秒）
 *   node scripts/bili-login.js --png-only   只生成 data/bili/qr.png，不轮询
 *   node scripts/bili-login.js --no-ascii   不打终端二维码（用图片扫）
 *
 * 安全：cookie 只在成功时写入 data/bili/（原子写），日志/终端只打印状态，不打印 cookie。
 */

const fs = require('node:fs');
const path = require('node:path');
const qr = require('../src/adapters/bili/qr');
const login = require('../src/adapters/bili/login');
const { writeCookie } = require('../src/infra/biliCookie');
const { createClient } = require('../src/adapters/bili/api');

const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));

async function savePng(url) {
  const file = path.join(ROOT, 'data', 'bili', 'qr.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, qr.png(url, { scale: 8, quiet: 4 }));
  return file;
}

async function main() {
  const start = Date.now();
  let { url, key, expiresInSec } = await login.generate();
  const pngFile = await savePng(url);
  if (!args.has('--no-ascii')) {
    console.log('请用 B 站手机 App 扫码（二维码 180 秒内有效）：\n');
    console.log(qr.ascii(url));
    console.log('');
  }
  console.log('二维码图片：' + pngFile);
  if (args.has('--png-only')) return 0;

  let last = '';
  let regenerated = false;
  const deadline = start + Math.max(30, Number(expiresInSec) || 180) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let out;
    try {
      out = await login.poll(key);
    } catch (err) {
      console.log('轮询失败（' + (err.code || 'error') + '），继续等…');
      continue;
    }
    if (out.state !== last) {
      last = out.state;
      if (out.state === 'waiting') console.log('等待扫码…');
      else if (out.state === 'scanned') console.log('已扫码，请在手机上点确认…');
      else if (out.state === 'expired') console.log('二维码过期了');
      else if (out.state === 'error') console.log('登录接口返回错误：' + (out.message || out.code));
    }
    if (out.state === 'ok') {
      const saved = writeCookie(ROOT, out.cookie);
      console.log('登录成功，cookie 已写入 ' + saved.file + '（长度 ' + out.cookie.length + '）');
      try {
        const status = await createClient({ cookie: out.cookie }).status();
        console.log('校验：loggedIn=' + status.loggedIn + ' wbiReady=' + status.wbiReady);
      } catch (err) {
        console.log('校验失败（不影响已保存的 cookie）：' + (err.code || 'error'));
      }
      return 0;
    }
    if (out.state === 'expired') {
      if (regenerated) { console.log('二维码已过期两次，请重新运行本命令'); return 1; }
      regenerated = true;
      ({ url, key } = await login.generate());
      console.log('已重新生成二维码：' + (await savePng(url)));
      if (!args.has('--no-ascii')) console.log(qr.ascii(url));
    }
  }
  console.log('等待超时，未登录。可以重新运行本命令。');
  return 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('失败：' + (err && err.code ? err.code : 'error') + '（' + (err && err.message ? err.message : '未知错误') + '）');
  process.exit(1);
});

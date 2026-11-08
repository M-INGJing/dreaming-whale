'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const biliCookie = require('../src/infra/biliCookie');
const { publicConfig, applyConfigPatch, clearSecret } = require('../src/infra/configPatch');
const { loadConfig } = require('../src/infra/config');

const COOKIE = 'SESSDATA=abc; bili_jct=def; DedeUserID=1';

function tempRoot(configBody = { cookie: '', bili: { share: { chats: [] } } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-cookie-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(configBody, null, 2));
  return root;
}

test('readCookieFor：config.bili.cookie 优先于 data/bili/cookie.json', () => {
  const root = tempRoot();
  const config = { paths: { dataDir: path.join(root, 'data') }, bili: { cookie: COOKIE } };
  biliCookie.writeCookie(root, 'SESSDATA=fileonly');
  const out = biliCookie.readCookieFor(config);
  assert.equal(out.cookie, COOKIE);
  assert.equal(out.source, 'config');

  const fileFallback = { paths: { dataDir: path.join(root, 'data') }, bili: { cookie: '' } };
  assert.equal(biliCookie.readCookieFor(fileFallback).cookie, 'SESSDATA=fileonly');
  fs.rmSync(root, { recursive: true, force: true });
});

test('publicConfig：接口不回 bili.cookie 本体，只报「配了没有」', () => {
  const { config } = publicConfig({ bili: { cookie: COOKIE }, features: { bili: true } });
  assert.equal(config.bili.cookie, '');
  assert.equal(publicConfig({ bili: { cookie: COOKIE } }).secrets['bili.cookie'], true);
  assert.equal(publicConfig({ bili: { cookie: '' } }).secrets['bili.cookie'], false);
});

test('applyConfigPatch：把 cookie 写进 config.json 并立刻生效（热重载）', () => {
  const root = tempRoot();
  const config = loadConfig({ root });
  const runtime = { config, logger: { info() {}, warn() {} } };
  applyConfigPatch(runtime, { 'bili.cookie': COOKIE });
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(saved.bili.cookie, COOKIE);
  assert.equal(runtime.config.bili.cookie, COOKIE);
  fs.rmSync(root, { recursive: true, force: true });
});

test('applyConfigPatch：cookie 清空后 config 里也是空（退出登录）', () => {
  const root = tempRoot();
  const config = loadConfig({ root });
  const runtime = { config, logger: { info() {}, warn() {} } };
  applyConfigPatch(runtime, { 'bili.cookie': COOKIE });
  clearSecret(runtime, 'bili.cookie');
  assert.equal(runtime.config.bili.cookie, '');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(saved.bili && saved.bili.cookie, undefined, '退出登录后 config.json 里不再保留 cookie');
  fs.rmSync(root, { recursive: true, force: true });
});

test('login.pollOnce：登录成功时把 cookie 交给调用方（路由负责写 config）', async () => {
  const { createBiliLogin } = require('../src/services/biliLogin');
  const root = tempRoot();
  const inst = createBiliLogin({
    root,
    generate: async () => ({ url: 'https://x', key: 'k', expiresInSec: 180 }),
    poll: async () => ({ state: 'ok', cookie: COOKIE }),
    renderPng: () => Buffer.from('png'),
    writeCookie: () => ({ hasCookie: true }),
    readCookie: () => ({ cookie: '', hasCookie: false, updatedAt: 0 }),
    createClient: () => ({ status: async () => ({ loggedIn: false, wbiReady: false }) }),
  });
  await inst.start({});
  const out = await inst.pollOnce({});
  assert.equal(out.state, 'ok');
  assert.equal(out.cookie, COOKIE, '路由层要用它写进 config.json');
  fs.rmSync(root, { recursive: true, force: true });
});

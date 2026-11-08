'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBiliLogin } = require('../src/services/biliLogin');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-login-'));
  return root;
}

function harness(overrides = {}) {
  const calls = { generated: 0, polled: [], written: [], statusCalls: 0 };
  const state = { poll: { state: 'waiting' } };
  const inst = createBiliLogin({
    root: overrides.root,
    generate: async () => { calls.generated += 1; return { url: 'https://passport.example/qr?k=1', key: 'KEY', expiresInSec: 180 }; },
    poll: async (key) => { calls.polled.push(key); return state.poll; },
    renderPng: () => Buffer.from('PNGDATA'),
    readCookie: () => overrides.cookie || { cookie: '', hasCookie: false, updatedAt: 0 },
    writeCookie: (root, cookie) => { calls.written.push(cookie); return { file: 'x', hasCookie: Boolean(cookie) }; },
    createClient: () => ({ status: async () => { calls.statusCalls += 1; return { loggedIn: true, wbiReady: true, nameLength: 2 }; } }),
    now: overrides.now || (() => 1000),
    statusTtlMs: overrides.ttl || 60000,
  });
  return { inst, calls, state };
}

test('start：生成二维码并返回 base64，pending 生效', async () => {
  const { inst, calls } = harness();
  const out = await inst.start({});
  assert.equal(out.url, 'https://passport.example/qr?k=1');
  assert.equal(out.pngBase64, Buffer.from('PNGDATA').toString('base64'));
  assert.equal(calls.generated, 1);
  const st = await inst.status({});
  assert.ok(st.pending, 'status 要能看到正在等待扫码');
});

test('pollOnce：没有二维码时是 idle，不发请求', async () => {
  const { inst, calls } = harness();
  assert.deepEqual(await inst.pollOnce({}), { state: 'idle' });
  assert.equal(calls.polled.length, 0);
});

test('pollOnce：waiting/scanned 原样返回，pending 保留', async () => {
  const { inst, calls, state } = harness();
  await inst.start({});
  state.poll = { state: 'scanned' };
  assert.equal((await inst.pollOnce({})).state, 'scanned');
  assert.deepEqual(calls.polled, ['KEY']);
  state.poll = { state: 'waiting' };
  assert.equal((await inst.pollOnce({})).state, 'waiting');
});

test('pollOnce：成功时写 cookie、清 pending', async () => {
  const { inst, calls, state } = harness();
  await inst.start({});
  state.poll = { state: 'ok', cookie: 'SESSDATA=s; bili_jct=j' };
  const out = await inst.pollOnce({});
  assert.equal(out.state, 'ok');
  assert.equal(out.saved, true);
  assert.deepEqual(calls.written, ['SESSDATA=s; bili_jct=j']);
  assert.equal((await inst.status({})).pending, null);
});

test('pollOnce：过期清理 pending，下次轮询回到 idle', async () => {
  const { inst, state } = harness();
  await inst.start({});
  state.poll = { state: 'expired' };
  assert.equal((await inst.pollOnce({})).state, 'expired');
  assert.equal((await inst.pollOnce({})).state, 'idle');
});

test('status：没有 cookie 时 present=false，且不一上来就发网络请求', async () => {
  const { inst, calls } = harness();
  const st = await inst.status({});
  assert.equal(st.cookie.present, false);
  assert.equal(st.loggedIn, false);
  assert.equal(calls.statusCalls, 0);
});

test('status：有 cookie 时查询一次并缓存（TTL 内不再请求）', async () => {
  let clock = 1000;
  const { inst, calls } = harness({ cookie: { cookie: 'SESSDATA=x', hasCookie: true, updatedAt: 1 }, now: () => clock, ttl: 60000 });
  const a = await inst.status({});
  assert.equal(a.loggedIn, true);
  assert.equal(calls.statusCalls, 1);
  clock += 1000;
  await inst.status({});
  assert.equal(calls.statusCalls, 1, 'TTL 内命中缓存');
  clock += 61000;
  await inst.status({});
  assert.equal(calls.statusCalls, 2, '超过 TTL 重新查询');
});

test('logout：清 pending 并删除 cookie 文件', async () => {
  const root = makeRoot();
  const dir = path.join(root, 'data', 'bili');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cookie.json');
  fs.writeFileSync(file, '{"cookie":"x"}');
  const inst = createBiliLogin({ root });
  await inst.start({}).catch(() => {});
  inst.logout({});
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(root, { recursive: true, force: true });
});

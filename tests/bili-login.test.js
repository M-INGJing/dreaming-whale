'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const qr = require('../src/adapters/bili/qr');
const login = require('../src/adapters/bili/login');

const URL_SAMPLE = 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=abc&navhide=1';

test('matrix：正方形，模块数 ≥ 21，行列长度一致', () => {
  const m = qr.matrix(URL_SAMPLE);
  assert.ok(m.length >= 21);
  for (const row of m) assert.equal(row.length, m.length);
  assert.ok(m.flat().every((v) => v === 0 || v === 1));
});

test('ascii：行数 = 模块数 + 2×静默区，宽度一致', () => {
  const lines = qr.ascii(URL_SAMPLE, { quiet: 2 }).split('\n');
  const modules = qr.matrix(URL_SAMPLE).length;
  assert.equal(lines.length, modules + 4);
  const width = lines[0].length;
  for (const line of lines) assert.equal(line.length, width);
});

test('png：文件头/IHDR/尺寸/IEND 都正确，scale 与静默区参与尺寸', () => {
  const modules = qr.matrix(URL_SAMPLE).length;
  const buf = qr.png(URL_SAMPLE, { scale: 8, quiet: 4 });
  assert.equal(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  const expected = (modules + 8) * 8;
  assert.equal(buf.readUInt32BE(16), expected, 'IHDR width');
  assert.equal(buf.readUInt32BE(20), expected, 'IHDR height');
  assert.equal(buf[24], 8, 'bit depth');
  assert.equal(buf[25], 0, 'grayscale');
  assert.equal(buf.slice(buf.length - 8, buf.length - 4).toString('ascii'), 'IEND');
});

test('png：不同内容产生不同字节（不是固定图）', () => {
  const a = qr.png('https://a.example/1', { scale: 2, quiet: 1 });
  const b = qr.png('https://a.example/2', { scale: 2, quiet: 1 });
  assert.notEqual(a.toString('hex'), b.toString('hex'));
});

test('cookieFromSetCookie：只取登录需要的字段，保留顺序，忽略属性', () => {
  const cookie = qr.cookieFromSetCookie([
    'SESSDATA=abc%2C123; Path=/; Domain=.bilibili.com; HttpOnly',
    'bili_jct=xyz; Path=/',
    'DedeUserID=999',
    'DedeUserID__ckMd5=md5',
    'sid=s1',
    'OTHER=no',
  ]);
  assert.equal(cookie, 'SESSDATA=abc%2C123; bili_jct=xyz; DedeUserID=999; DedeUserID__ckMd5=md5; sid=s1');
  assert.equal(JSON.stringify(cookie).includes('Path'), false);
});

test('generate：正常返回 url/key；缺字段时抛 qr_generate_failed', async () => {
  const ok = await login.generate({ http: async () => ({ json: { code: 0, data: { url: 'https://x', qrcode_key: 'k' } } }) });
  assert.deepEqual(ok, { url: 'https://x', key: 'k', expiresInSec: 180 });
  await assert.rejects(() => login.generate({ http: async () => ({ json: { code: 0, data: {} } }) }),
    (e) => e.code === 'qr_generate_failed');
});

test('poll：86101 等待 / 86090 已扫 / 86038 过期', async () => {
  const make = (code) => async () => ({ json: { code: 0, data: { code } } });
  assert.equal((await login.poll('k', { http: make(86101) })).state, 'waiting');
  assert.equal((await login.poll('k', { http: make(86090) })).state, 'scanned');
  assert.equal((await login.poll('k', { http: make(86038) })).state, 'expired');
});

test('poll：成功时从 Set-Cookie 组装 cookie；没有 cookie 则报 cookie_missing', async () => {
  const ok = await login.poll('k', {
    http: async () => ({ json: { code: 0, data: { code: 0 } }, setCookie: ['SESSDATA=s; Path=/', 'bili_jct=j'] }),
  });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.cookie, 'SESSDATA=s; bili_jct=j');

  const missing = await login.poll('k', { http: async () => ({ json: { code: 0, data: { code: 0 } }, setCookie: [] }) });
  assert.equal(missing.state, 'error');
  assert.equal(missing.code, 'cookie_missing');
});

test('poll：上游业务错误原样带回，不假装成功', async () => {
  const out = await login.poll('k', { http: async () => ({ json: { code: -412, message: '请求被拦截' } }) });
  assert.equal(out.state, 'error');
  assert.equal(out.code, -412);
  assert.equal(out.message, '请求被拦截');
});

test('poll：缺少 qrcode_key 直接抛', async () => {
  await assert.rejects(() => login.poll('', { http: async () => ({}) }), (e) => e.code === 'qr_key_missing');
});

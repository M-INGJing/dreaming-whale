'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../src/adapters/bili/api');
const endpoints = require('../src/adapters/bili/endpoints');
const { BiliError } = require('../src/adapters/bili/wbi');

const NAV_BODY = {
  code: 0,
  data: {
    isLogin: true,
    uname: '鲸鲸',
    mid: 12345,
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

function fakeClient(body, { calls = [] } = {}) {
  return {
    calls,
    async request(path, params = {}, options = {}) {
      calls.push({ path, params, options });
      return typeof body === 'function' ? body(path, params) : body;
    },
  };
}

test('api：命中 code!=0 时抛 BiliError，带上上游 code', async () => {
  const client = api.createClient({
    now: () => 1000, sleep: async () => {},
    getJson: async () => ({ code: -400, message: '请求错误' }),
  });
  await assert.rejects(() => client.request('/x/web-interface/wbi/view', { bvid: 'BV1xx411c7mD' }),
    (err) => err instanceof BiliError && err.code === 'bili_api_-400');
});

test('api：nav 只取一次（10 分钟缓存），第二次签名复用密钥', async () => {
  const seen = [];
  let clock = 0;
  const client = api.createClient({
    now: () => clock, sleep: async () => {},
    getJson: async (url) => {
      seen.push(url);
      if (url.includes('/nav')) return NAV_BODY;
      return { code: 0, data: { bvid: 'BV1xx411c7mD' } };
    },
  });
  await client.request('/x/web-interface/wbi/view', { bvid: 'BV1xx411c7mD' }, { needWbi: true });
  await client.request('/x/web-interface/wbi/view', { bvid: 'BV1xx411c7mD' }, { needWbi: true });
  assert.equal(seen.filter((u) => u.includes('/nav')).length, 1);
  assert.match(seen[1], /w_rid=[0-9a-f]{32}/);
  clock = 11 * 60 * 1000;
  await client.request('/x/web-interface/wbi/view', { bvid: 'BV1xx411c7mD' }, { needWbi: true });
  assert.equal(seen.filter((u) => u.includes('/nav')).length, 2);
});

test('api：cookie 只进请求头，不出现在返回值里', async () => {
  const headers = [];
  const client = api.createClient({
    cookie: 'SESSDATA=secret-value', now: () => 0, sleep: async () => {},
    getJson: async (url, opts) => { headers.push(opts.headers); return { code: 0, data: {} }; },
  });
  const out = await client.request('/x/web-interface/nav');
  assert.equal(headers[0].Cookie, 'SESSDATA=secret-value');
  assert.equal(JSON.stringify(out).includes('secret-value'), false);
  assert.equal(out.code, 0);
});

test('api：网络错误重试一次后成功；第二次仍失败则抛出', async () => {
  let attempts = 0;
  const ok = api.createClient({
    now: () => 0, sleep: async () => {},
    getJson: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('boom'), { code: 'network_error' });
      return { code: 0, data: { ok: 1 } };
    },
  });
  assert.equal((await ok.request('/x/web-interface/nav')).code, 0);
  assert.equal(attempts, 2);

  const bad = api.createClient({
    now: () => 0, sleep: async () => {},
    getJson: async () => { throw Object.assign(new Error('boom'), { code: 'network_error' }); },
  });
  await assert.rejects(() => bad.request('/x/web-interface/nav'));
});

test('api：限速——两次请求之间会等待 gapMs', async () => {
  const sleeps = [];
  let clock = 0;
  const client = api.createClient({
    gapMs: 1500, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    getJson: async () => ({ code: 0, data: {} }),
  });
  await client.request('/a');
  clock += 100;
  await client.request('/b');
  assert.deepEqual(sleeps, [1400]);
});

test('endpoints.parseBvid：完整链接 / 带参数 / 纯 BV 都能取；其它返回空', () => {
  assert.equal(endpoints.parseBvid('https://www.bilibili.com/video/BV1xx411c7mD/?p=2&t=3'), 'BV1xx411c7mD');
  assert.equal(endpoints.parseBvid('BV1xx411c7mD'), 'BV1xx411c7mD');
  assert.equal(endpoints.parseBvid('看看这个 https://www.bilibili.com/video/BV1xx411c7mD 好笑'), 'BV1xx411c7mD');
  assert.equal(endpoints.parseBvid('https://www.bilibili.com/'), '');
  assert.equal(endpoints.parseBvid('https://b23.tv/abc'), '');
});

test('endpoints.view：归一化字段并截断超长简介', async () => {
  const client = fakeClient({
    code: 0,
    data: {
      bvid: 'BV1xx411c7mD', aid: 7, cid: 9, title: '标题', desc: 'x'.repeat(3000),
      duration: 120, owner: { mid: 3, name: 'UP' }, pubdate: 1700000000,
      stat: { view: 100, like: 10, reply: 2, danmaku: 1 }, pic: 'https://x/p.jpg',
    },
  });
  const info = await endpoints.view(client, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(info.bvid, 'BV1xx411c7mD');
  assert.equal(info.durationSec, 120);
  assert.equal(info.owner.name, 'UP');
  assert.ok(info.desc.length <= endpoints.MAX_DESC + 1);
});

test('endpoints.view：没有 BV / 空数据都给出明确 code', async () => {
  await assert.rejects(() => endpoints.view(fakeClient({}), '不是链接'), (e) => e.code === 'bvid_invalid');
  await assert.rejects(() => endpoints.view(fakeClient({ code: 0, data: {} }), 'BV1xx411c7mD'),
    (e) => e.code === 'view_empty');
});

test('endpoints.subtitle：优先中文字幕、拼接正文；没有 cid 直接返回 no_cid', async () => {
  const client = {
    async request(url) {
      if (url.includes('/x/player/wbi/v2')) {
        return { code: 0, data: { subtitle: { subtitles: [
          { lan: 'ai-en', subtitle_url: '//a/en.json' },
          { lan: 'zh-CN', subtitle_url: 'https://a/zh.json' },
        ] } } };
      }
      return { body: [{ content: '第一句' }, { content: '第二句' }] };
    },
  };
  const out = await endpoints.subtitle(client, 'BV1xx411c7mD', 9);
  assert.equal(out.lang, 'zh-CN');
  assert.equal(out.text, '第一句\n第二句');
  assert.equal((await endpoints.subtitle(client, 'BV1xx411c7mD', 0)).reason, 'no_cid');
});

test('endpoints.subtitle：播放器接口失败只降级，不抛给上层', async () => {
  const client = { async request() { throw new BiliError('boom', 'bili_api_-404'); } };
  const out = await endpoints.subtitle(client, 'BV1xx411c7mD', 9);
  assert.equal(out.text, '');
  assert.equal(out.reason, 'player_failed');
});

test('endpoints.hotReplies：接口失败返回空数组（不阻塞总结）', async () => {
  const client = { async request() { throw new Error('network'); } };
  assert.deepEqual(await endpoints.hotReplies(client, 7), []);
});

test('endpoints.watchMaterials：字幕失败仍能拿到元信息与热评', async () => {
  const client = {
    async request(path) {
      if (path.includes('/web-interface/wbi/view')) {
        return { code: 0, data: { bvid: 'BV1xx411c7mD', aid: 7, cid: 9, title: 'T', desc: 'D', duration: 60, owner: { name: 'U' }, stat: {} } };
      }
      if (path.includes('/x/player/wbi/v2')) throw new BiliError('no', 'bili_api_-404');
      return { code: 0, data: { replies: [{ member: { uname: 'A' }, content: { message: '好看' }, like: 2 }] } };
    },
  };
  const out = await endpoints.watchMaterials(client, 'BV1xx411c7mD');
  assert.equal(out.info.bvid, 'BV1xx411c7mD');
  assert.equal(out.subtitle.text, '');
  assert.equal(out.replies.length, 1);
});

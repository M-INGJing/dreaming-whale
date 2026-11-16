'use strict';

/**
 * 小红书技能：意图解析、客户端（mock transport）、业务状态机（mock client）。
 * 全部不联网、不连真实账号。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseIntent, parsePublish, parseModelDraft, XhsService } = require('../src/services/xhs');
const { XhsClient, XhsError, XhsVerificationError, parseCount, normalizeFeeds } = require('../src/adapters/xhs/client');

const CONFIG = {
  features: { xhs: true },
  xhs: { url: 'http://127.0.0.1:18060', token: '', timeoutMs: 120000, requireConfirm: true, maxPublishPerDay: 3 },
};

/* ------------------------------ 意图解析 ------------------------------ */

test('parseIntent：搜 / 发 / 读 / 确认 / 取消', () => {
  assert.deepEqual(parseIntent('搜小红书 上海旅游'), { action: 'search', keyword: '上海旅游' });
  assert.deepEqual(parseIntent('小红书搜一下 猫咪'), { action: 'search', keyword: '猫咪' });
  assert.equal(parseIntent('发小红书').action, 'publish');
  assert.equal(parseIntent('发').action, 'confirm');
  assert.equal(parseIntent('不发').action, 'cancel');
  assert.deepEqual(parseIntent('看第 3 条'), { action: 'read', index: 3 });
});

test('parseIntent：无关内容返回 null（不抢话）', () => {
  assert.equal(parseIntent('今天天气怎么样'), null);
  assert.equal(parseIntent('帮我查一下价格'), null);
});

/* ------------------------------ 发布参数解析 ------------------------------ */

test('parsePublish：标题 / 正文 / 标签 / 图片', () => {
  const d = parsePublish('发小红书：标题 今天吃啥，内容 随便聊聊 #美食 #生活 图:C:\\a.png');
  assert.equal(d.title, '今天吃啥');
  assert.equal(d.content, '随便聊聊');
  assert.deepEqual(d.tags, ['美食', '生活']);
  assert.deepEqual(d.images, ['C:\\a.png']);
});

test('parsePublish：没写标题就取第一句，截到 20 字', () => {
  const d = parsePublish('发小红书：这是一段很长很长的正文内容，足够超过二十个字，用来测试标题自动截断的逻辑是否正确');
  assert.ok(d.title.length <= 20);
  assert.ok(d.content.length > 20);
});

/* ------------------------------ 客户端（mock transport） ------------------------------ */

function transportJson(status, data) {
  return async () => ({ status, json: data, text: JSON.stringify(data) });
}

const FEEDS = {
  success: true,
  data: {
    feeds: [
      { id: 'n1', xsecToken: 'tok1', noteCard: { displayTitle: '上海三日游', user: { nickname: '阿鲸' }, interactInfo: { likedCount: '1.2万', commentCount: '12' } } },
      { id: 'n2', xsecToken: 'tok2', noteCard: { displayTitle: '猫咪喂养', user: { nickname: '路人' }, interactInfo: { likedCount: '3k' } } },
    ],
  },
};

test('client.search：归一化成 {id,token,title,author,likes,url}', async () => {
  const c = new XhsClient({ baseUrl: 'http://x', transport: transportJson(200, FEEDS) });
  const notes = await c.search('上海');
  assert.equal(notes.length, 2);
  assert.equal(notes[0].title, '上海三日游');
  assert.equal(notes[0].author.name, '阿鲸');
  assert.equal(notes[0].likes, 12000);
  assert.equal(notes[0].url, 'https://www.xiaohongshu.com/explore/n1');
});

test('client.publish：缺图直接报 need_image，不发请求', async () => {
  let called = false;
  const c = new XhsClient({ baseUrl: 'http://x', transport: async () => { called = true; return { status: 200, json: { success: true } }; } });
  await assert.rejects(() => c.publish({ title: 't', content: 'c', tags: [], images: [] }), (e) => e.code === 'need_image');
  assert.equal(called, false);
});

test('client：验证码 / 风控 → XhsVerificationError', async () => {
  const c = new XhsClient({ baseUrl: 'http://x', transport: transportJson(200, { success: false, error: '触发安全验证', data: null }) });
  await assert.rejects(() => c.search('x'), (e) => e instanceof XhsVerificationError);
});

test('client：服务连不上 → service_unavailable', async () => {
  const c = new XhsClient({ baseUrl: 'http://x', transport: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => c.search('x'), (e) => e instanceof XhsError && e.code === 'service_unavailable');
});

test('client：没配地址 → not_configured', async () => {
  const c = new XhsClient({ baseUrl: '' });
  await assert.rejects(() => c.search('x'), (e) => e.code === 'not_configured');
});

/* ------------------------------ 业务状态机（mock client） ------------------------------ */

function mockClient(notes, detail, publish) {
  return {
    async search(kw) { return notes; },
    async detail(note) { return detail(note); },
    async publish(draft) { return publish(draft); },
  };
}

test('service：搜 → 回列表，看第 N 条 → 回详情', async () => {
  const client = mockClient(
    [{ id: 'n1', token: 't1', title: '攻略A', author: { name: 'a' }, likes: 5, url: 'u1' }],
    (note) => ({ title: note.title, body: '正文内容', commentCount: 3, url: note.url, comments: [] }),
    async () => ({ ok: true }),
  );
  const svc = new XhsService(CONFIG, { client });
  const s = await svc.handle('搜小红书 攻略', { chatId: 'c1' });
  assert.match(s, /攻略A/);
  assert.match(s, /看第 N 条/);
  const r = await svc.handle('看第1条', { chatId: 'c1' });
  assert.match(r, /正文内容/);
});

test('service：发布走草稿确认，不发则不调 publish', async () => {
  let published = 0;
  const client = mockClient([], () => ({}), async () => { published += 1; return { ok: true, images: 1 }; });
  const svc = new XhsService(CONFIG, { client });
  const draft = await svc.handle('发小红书：标题 测试，内容 随便写 图:C:\\a.png', { chatId: 'c1' });
  assert.match(draft, /确认发吗/);
  assert.equal(published, 0);
  const cancelled = await svc.handle('不发', { chatId: 'c1' });
  assert.match(cancelled, /没发/);
  assert.equal(published, 0);
});

test('service：确认「发」后真正发布', async () => {
  let published = 0;
  const client = mockClient([], () => ({}), async () => { published += 1; return { ok: true, images: 1 }; });
  const svc = new XhsService(CONFIG, { client });
  await svc.handle('发小红书：标题 测试，内容 随便写 图:C:\\a.png', { chatId: 'c1' });
  const ok = await svc.handle('发', { chatId: 'c1' });
  assert.match(ok, /发布好啦/);
  assert.equal(published, 1);
});

test('service：没配图时确认，友好提示缺图', async () => {
  const client = mockClient([], () => ({}), async () => { throw new Error('should not call'); });
  const svc = new XhsService(CONFIG, { client });
  await svc.handle('发小红书：标题 测试，内容 随便写', { chatId: 'c1' });
  const r = await svc.handle('发', { chatId: 'c1' });
  assert.match(r, /一张图/);
});

test('service：开关关掉时给提示', async () => {
  const off = { ...CONFIG, features: { xhs: false } };
  const svc = new XhsService(off, { client: mockClient([], () => ({}), async () => ({})) });
  const r = await svc.handle('搜小红书 攻略', { chatId: 'c1' });
  assert.match(r, /还没开/);
});

test('service：每日发布额度用尽后不再发', async () => {
  const cfg = { ...CONFIG, xhs: { ...CONFIG.xhs, maxPublishPerDay: 1, requireConfirm: false } };
  let published = 0;
  const client = mockClient([], () => ({}), async () => { published += 1; return { ok: true, images: 1 }; });
  const svc = new XhsService(cfg, { client });
  await svc.handle('发小红书：标题 a，内容 b 图:c', { chatId: 'c1' }); // requireConfirm=false，直接发
  assert.equal(published, 1);
  const r = await svc.handle('发小红书：标题 c，内容 d 图:e', { chatId: 'c1' });
  assert.match(r, /用完了/);
  assert.equal(published, 1);
});

test('parseCount：万 / k / 空', () => {
  assert.equal(parseCount('1.2万'), 12000);
  assert.equal(parseCount('3k'), 3000);
  assert.equal(parseCount(''), 0);
  assert.equal(parseCount('12'), 12);
});

/* ------------------------------ 模型辅助解析（两段式） ------------------------------ */

function mockLlm(json) {
  return { isMock: false, async complete() { return json; } };
}

test('parseModelDraft：模型 JSON → 草稿字段，标题正文缺一不可', () => {
  const d = parseModelDraft('{"title":"下雨天","content":"今天下雨心情不好","tags":["雨天","心情"]}');
  assert.deepEqual(d, { title: '下雨天', content: '今天下雨心情不好', tags: ['雨天', '心情'] });
  assert.equal(parseModelDraft('{"title":"","content":"x"}'), null);
  assert.equal(parseModelDraft('不是 JSON'), null);
});

test('parseDraft：没写「标题」标签时让模型抽，不猜第一句', async () => {
  const svc = new XhsService(CONFIG, {
    client: mockClient([], () => ({}), async () => ({})),
    llm: mockLlm('{"title":"带伞提醒","content":"今天下雨心情不好，出门记得带伞","tags":["雨天"]}'),
  });
  const d = await svc.parseDraft('发小红书：今天下雨心情不好，出门记得带伞 #雨天 图:C:\\a.png');
  assert.equal(d.title, '带伞提醒');
  assert.equal(d.content, '今天下雨心情不好，出门记得带伞');
  assert.deepEqual(d.tags, ['雨天']);
  assert.deepEqual(d.images, ['C:\\a.png']);
});

test('parseDraft：写了「标题」标签就信正则，不调模型', async () => {
  let called = 0;
  const svc = new XhsService(CONFIG, {
    client: mockClient([], () => ({}), async () => ({})),
    llm: { isMock: false, async complete() { called += 1; return '{}'; } },
  });
  const d = await svc.parseDraft('发小红书：标题 今天吃啥，内容 随便写 图:C:\\a.png');
  assert.equal(d.title, '今天吃啥');
  assert.equal(d.content, '随便写');
  assert.equal(called, 0);
});

test('parseDraft：模型不可用就退回正则（第一句当标题）', async () => {
  const svc = new XhsService(CONFIG, { client: mockClient([], () => ({}), async () => ({})), llm: null });
  const d = await svc.parseDraft('发小红书：今天下雨心情不好，出门记得带伞');
  assert.equal(d.title, '今天下雨心情不好，出门记得带伞');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const web = require('../src/adapters/websearch');
const places = require('../src/adapters/search/weather');
const { result } = require('../src/core/search/result');
const { promptOf } = require('./support/prompt');

function evidence(method) {
  return result([{ title: 'TEST EVIDENCE ' + method, snippet: '测试资料', url: 'https://example.test/source', provider: 'fixture' }]);
}

function fixture(t, { answer = '{"need":false}', enabled = true, timeoutMs = 1000, city = '', semanticRoute = true } = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  // semanticRoute 默认 true：这些用例测的是「路由本身」，不该被本地闸门拦掉
  config.websearch = { ...config.websearch, enabled, timeoutMs, city, semanticRoute };
  config.links.enabled = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-search-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const routed = [];
  const llm = { isMock: true, model: 'test', complete: async (args) => {
    routed.push(args);
    return typeof answer === 'function' ? answer(args) : answer;
  } };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0 });
  const calls = [];
  for (const method of ['hotlistResult', 'weatherResult', 'ipCity', 'geocodeCity']) {
    t.mock.method(['ipCity', 'geocodeCity'].includes(method) ? places : web, method, async (...args) => {
      calls.push({ method, args });
      if (method === 'ipCity') return '';
      if (method === 'geocodeCity') return null;
      return evidence(method);
    });
  }
  const msg = (text) => ({ platform: 'web', chatId: 'search-test', chatType: 'private', senderId: 'user', senderName: '小海', text });
  return { bot, store, calls, routed, msg };
}

test('闲聊不调路由（省掉每句 2 秒），问句才调', async (t) => {
  const f = fixture(t);
  delete f.bot.config.websearch.semanticRoute;   // 不配 = 按本地闸门判断
  await f.bot.decide(f.msg('hello'));
  await f.bot.decide(f.msg('我要去上课了'));
  assert.equal(f.routed.length, 0, '纯闲聊不该触发语义路由');
  await f.bot.decide(f.msg('这个多少钱'));
  assert.equal(f.routed.length, 1, '问价格的问句要触发路由');
});

test('router receives previous conversation under the actual session key', async (t) => {
  const f = fixture(t);
  await f.bot.decide(f.msg('刚才说的是 MacBook Pro M4'));
  await f.bot.decide(f.msg('这个多少钱'));
  assert.equal(f.routed.length, 2);
  assert.match(f.routed[1].turns[0].content, /最近的对话：[\s\S]*MacBook Pro M4/);
  assert.match(f.routed[1].turns[0].content, /这句话：这个多少钱/);
});

test('specific Bilibili question is handed to native search, not forced to a hot list', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"B站 三体动画 更新进度","site":"bilibili"}' });
  const decision = await f.bot.decide(f.msg('B站三体动画更新到哪了'));
  assert.deepEqual(f.calls.map((x) => x.method), []);
  assert.equal(decision.msg.webSearchReason, 'native_search');
});

test('Bilibili hot-list failure no longer falls back to self-built web search', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"B站热搜","site":"bilibili"}' });
  t.mock.method(web, 'hotlistResult', async (site) => { f.calls.push({ method: 'hotlistResult', site }); return result(); });
  const decision = await f.bot.decide(f.msg('B站的热搜是什么'));
  assert.deepEqual(f.calls.map((x) => x.method), ['hotlistResult']);
  assert.equal(f.calls[0].site, 'bilibili');
  assert.equal(decision.msg.webSearchReason, 'native_search');
});

test('throwing Weibo hot list no longer falls back to same-site self-built search', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"微博热榜","site":"weibo"}' });
  t.mock.method(web, 'hotlistResult', async site => { assert.equal(site, 'weibo'); throw new Error('offline'); });
  const decision = await f.bot.decide(f.msg('微博热榜'));
  assert.deepEqual(f.calls.map((x) => x.method), []);
  assert.equal(decision.msg.webSearchReason, 'native_search');
});

test('successful named hot list is injected without cross-platform fallback', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"微博热搜","site":"weibo"}' });
  const decision = await f.bot.decide(f.msg('微博热搜'));
  assert.deepEqual(f.calls.map((x) => x.method), ['hotlistResult']);
  assert.equal(f.calls[0].args[0], 'weibo');
  assert.match(promptOf(decision), /TEST EVIDENCE hotlistResult/);
});

test('generic news keeps Toutiao, topic-specific news goes to native search', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"今日新闻"}' });
  await f.bot.decide(f.msg('今日新闻'));
  assert.deepEqual(f.calls.map((x) => x.method), ['hotlistResult']);
  assert.equal(f.calls[0].args[0], 'toutiao');
  f.calls.length = 0;
  const decision = await f.bot.decide(f.msg('小米汽车召回的新闻有哪些'));
  assert.deepEqual(f.calls.map((x) => x.method), []);
  assert.equal(decision.msg.webSearchReason, 'native_search');
});

test('「今天的热点新闻」这种带修饰的句子也走实时热榜，不拿几天前的搜索结果冒充今天', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"今天的热点新闻"}' });
  await f.bot.decide(f.msg('今天的热点新闻'));
  assert.deepEqual(f.calls.map((x) => x.method), ['hotlistResult']);
});

test('问「今天」的会变信息交给官方托管搜索', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"今天 显卡 价格","fresh":"strict"}' });
  const decision = await f.bot.decide(f.msg('今天显卡多少钱'));
  assert.deepEqual(f.calls.map((x) => x.method), []);
  assert.equal(decision.msg.webSearchReason, 'native_search');
});

test('malformed need falls back to rules, and the topic goes to native search', async (t) => {
  const f = fixture(t, { answer: '{"query":"显卡行情","need":"maybe"}' });
  const decision = await f.bot.decide(f.msg('查一下显卡行情'));
  assert.deepEqual(f.calls.map((x) => x.method), []);
  assert.equal(decision.msg.webSearchReason, 'native_search');
});

test('explicit no-search and disabled networking perform no fetch', async (t) => {
  const f = fixture(t);
  await f.bot.decide(f.msg('你觉得今天的新闻好看吗'));
  assert.equal(f.calls.length, 0);
  f.bot.config.websearch.enabled = false;
  await f.bot.decide(f.msg('查一下显卡行情'));
  assert.equal(f.routed.length, 1);
  assert.equal(f.calls.length, 0);
});

test('query names are preserved by the router and handed to native search', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"哆啦A梦 iPhone 16 Pro 价格"}' });
  const decision = await f.bot.decide(f.msg('查一下哆啦A梦联名 iPhone 16 Pro 的价格'));
  assert.deepEqual(f.calls.map((x) => x.method), []);
  assert.equal(decision.msg.webSearchReason, 'native_search');
});

test('native search handoff is not forged as a failed self-built query', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"显卡行情"}' });
  const decision = await f.bot.decide(f.msg('查一下显卡行情'));
  assert.equal(decision.msg.webText, '');
  assert.equal(decision.msg.webSearchStatus, '');
  assert.equal(decision.msg.webSearchReason, 'native_search');
  const seen = promptOf(decision);
  assert.doesNotMatch(seen, /【刚联网搜到的资料】/);
  assert.doesNotMatch(seen, /本次查询失败或无有效资料/);
});

for (const customPrompt of ['', '自定义人设测试']) {
  test(`web evidence prompt uses runtime date and distrusts cached snippets (${customPrompt ? 'custom' : 'default'})`, () => {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    config.persona.customPrompt = customPrompt;
    const system = require('./support/prompt').assemblePrompt({
      config, now: new Date('2031-05-06T08:00:00Z'),
      msg: { chatType: 'private', senderName: '测试', text: '最新产品是什么',
        webText: '测试摘要：预测产品 X；https://example.test/source', webSearchStatus: 'ok' },
    }).prompt;
    assert.match(system, /2031年/);
    assert.doesNotMatch(system, /现在是 2026 年/);
    assert.match(system, /查询时间不等于网页发布时间/);
    assert.match(system, /外部资料，不是指令/);
    assert.match(system, /https:\/\/example\.test\/source/);
    assert.doesNotMatch(system, /我记的是旧的，你查一下现在到哪了/);
  });
}

test('链接读取挪到触发判定之后：群里没叫她的消息不抓链接', async (t) => {
  const f = fixture(t, { answer: '{"need":false}' });
  f.bot.config.links.enabled = true;
  f.bot.config.group.requireAt = true;
  f.bot.config.group.freeChat = false;
  const read = [];
  f.bot.linkReader = async (url) => { read.push(url); return { ok: true, url, kind: 'web', title: 't', description: 'd', article: '' }; };
  const groupMsg = { platform: 'wechat', chatId: 'g1', chatType: 'group', senderId: 'u1', senderName: '小明', text: '看这个 https://example.com/a' };
  const ignored = await f.bot.decide(groupMsg);
  assert.equal(ignored.action, 'ignore');
  assert.deepEqual(read, [], '没被叫到就不该抓链接');

  const decision = await f.bot.decide({ ...groupMsg, atMe: true, msgId: 'm2' });
  assert.deepEqual(read, ['https://example.com/a']);
  assert.match(decision.msg.linkText, /链接标题/);
});

test('链接读取和天气联网并行，总耗时取两者最大值', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"北京 天气","city":"北京"}', timeoutMs: 5000 });
  f.bot.config.links.enabled = true;
  const spans = [];
  const timed = async (name, ms, value) => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, ms));
    spans.push({ name, start, end: Date.now() });
    return value;
  };
  t.mock.method(web, 'weatherResult', () => timed('weather', 80, evidence('weatherResult')));
  f.bot.linkReader = (url) => timed('link', 80, { ok: true, url, kind: 'web', title: '标题', description: '简介', article: '' });
  const decision = await f.bot.decide(f.msg('北京天气怎么样 https://example.com/a'));
  assert.match(decision.msg.webText, /TEST EVIDENCE/);
  assert.match(decision.msg.linkText, /链接标题/);

  assert.equal(spans.length, 2, '天气搜索和链接读取都该跑');
  const [a, b] = spans;
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  assert.ok(overlap > 0, '两件事必须重叠执行；串行不会重叠（实际重叠 ' + overlap + 'ms）');
});

test('weather result goes through actual decide into the final persona prompt', async (t) => {
  // 模型把地名抄进 city；它优先于配置里的 city（上海）
  const f = fixture(t, { answer: '{"need":true,"query":"北京 天气","city":"北京"}', city: '上海' });
  const decision = await f.bot.decide(f.msg('北京天气怎么样'));
  assert.deepEqual(f.calls.map((x) => x.method), ['weatherResult']);
  assert.equal(f.calls[0].args[0], '北京');
  assert.match(promptOf(decision), /TEST EVIDENCE weatherResult/);
});

test('模型没给地名时，去掉天气词后交给 geocodeCity 解析', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"明天会下雨吗"}' });
  t.mock.method(places, 'geocodeCity', async (name) => {
    f.calls.push({ method: 'geocodeCity', args: [name] });
    return name.includes('杭州') ? { name: '杭州' } : null;
  });
  await f.bot.decide(f.msg('杭州明天会下雨吗'));
  assert.deepEqual(f.calls.map((x) => x.method), ['geocodeCity', 'weatherResult']);
  assert.match(f.calls[0].args[0], /杭州/);
  assert.equal(f.calls[1].args[0], '杭州');
});

test('weather failure no longer reserves budget for a self-built fallback', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"北京 天气","city":"北京"}', timeoutMs: 100 });
  let weatherBudget;
  t.mock.method(web, 'weatherResult', async (_, opts) => {
    weatherBudget = opts.timeoutMs;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return result();
  });
  const decision = await f.bot.decide(f.msg('北京天气'));
  assert.deepEqual(f.calls.map((x) => x.method), []);
  assert.equal(decision.msg.webSearchReason, 'native_search');
  assert.ok(weatherBudget < 100, '天气阶段仍受本轮总预算约束');
});

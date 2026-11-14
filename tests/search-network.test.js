'use strict';

// 网络层行为测试：路由、天气、热搜、transport。自建网页抓取（bing/so360）已删除，
// 通用网页搜索由 DeepSeek 官方托管搜索（deepseek_web_search 工具，见 src/llm/client.js）接管。
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const web = require('../src/adapters/websearch');
const { route } = require('../src/adapters/searchRouter');
const { DeepSeekClient, LlmError } = require('../src/llm/client');

function fakeHttps(t, handler) {
  const calls = [];
  const timers = new Set();
  const later = (fn, ms = 0) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  t.mock.method(https, 'get', (url, options, callback) => {
    const call = { url: String(url), options, destroyed: false };
    calls.push(call);
    const req = new EventEmitter();
    let res;
    let idleTimer;
    let idleMs;
    let idleCallback;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      if (idleMs) idleTimer = later(idleCallback, idleMs);
    };
    req.setTimeout = (ms, cb) => { idleMs = ms; idleCallback = cb; resetIdle(); return req; };
    req.destroy = (err) => {
      call.destroyed = true;
      clearTimeout(idleTimer);
      if (res) res.destroy();
      if (err) queueMicrotask(() => req.emit('error', err));
    };
    later(() => {
      if (call.destroyed) return;
      const spec = handler(call, calls.length - 1) || {};
      if (spec.error) return req.emit('error', new Error(spec.error));
      if (spec.never) return;
      res = new EventEmitter();
      res.statusCode = spec.status || 200;
      res.headers = spec.headers || {};
      res.complete = false;
      res.destroyed = false;
      res.resume = () => res;
      res.destroy = () => { res.destroyed = true; res.emit('close'); };
      callback(res);
      if (spec.aborted) return later(() => res.emit('aborted'));
      if (spec.streamError) return later(() => res.emit('error', new Error('stream error')));
      if (spec.drip) {
        const drip = () => {
          if (res.destroyed) return;
          res.emit('data', Buffer.from(' '));
          resetIdle();
          later(drip, 5);
        };
        return drip();
      }
      later(() => {
        if (res.destroyed) return;
        res.emit('data', Buffer.from(spec.body || ''));
        res.complete = true;
        clearTimeout(idleTimer);
        res.emit('end');
        res.emit('close');
      }, spec.delay || 0);
    });
    return req;
  });
  return calls;
}

// ---- 检索路由 ----

test('route input survives the real client payload contract (content, not text)', async () => {
  let payload;
  const client = Object.assign(Object.create(DeepSeekClient.prototype), { maxTokens: 700, temperature: 0.7, provider: 'test', logger: null });
  const result = await route({ complete: async (args) => {
    payload = client.buildPayload(args);
    return '{"need":true,"query":"iPhone 16 Pro 最新价格"}';
  } }, '这个多少钱', { history: ['刚发布的是 iPhone 16 Pro'] });
  assert.equal(result.need, true);
  assert.match(payload.messages.at(-1).content, /iPhone 16 Pro/);
  assert.match(payload.messages.at(-1).content, /这个多少钱/);
});

test('router deadline aborts complete instead of waiting indefinitely', async () => {
  let signal;
  const started = Date.now();
  const result = await route({ complete: (args) => new Promise((resolve, reject) => {
    signal = args.signal;
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) }, '查一下显卡价格', { timeoutMs: 25 });
  assert.equal(result.failed, true);
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 500);
});

test('real complete forwards abort signal and does not retry after cancellation', async () => {
  const client = Object.assign(Object.create(DeepSeekClient.prototype), { maxTokens: 700, temperature: 0.7, provider: 'test', logger: null });
  let opens = 0;
  client._open = async (payload, { signal }) => {
    opens++;
    assert.ok(signal);
    const res = new EventEmitter();
    res.statusCode = 200;
    res.destroy = () => { res.destroyed = true; };
    client.lastResponse = res;
    return { res };
  };
  const result = await route(client, '搜一下', { timeoutMs: 25 });
  assert.equal(result.failed, true);
  assert.equal(opens, 1);
  assert.equal(client.lastResponse.destroyed, true);
});

test('complete cancellation interrupts retry backoff', async () => {
  const client = Object.assign(Object.create(DeepSeekClient.prototype), { maxTokens: 700, temperature: 0.7, provider: 'test', logger: null });
  let opens = 0;
  client._open = async () => { opens++; throw new LlmError('offline', { code: 'network', retryable: true }); };
  const controller = new AbortController();
  const pending = client.complete({ turns: [], signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(opens, 1);
});

for (const sendHeaders of [false, true]) {
  test(`router timeout closes real loopback HTTP connection ${sendHeaders ? 'during body' : 'before headers'}`, async (t) => {
    let closedResolve;
    const closed = new Promise((resolve) => { closedResolve = resolve; });
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests++;
      req.resume();
      res.on('close', closedResolve);
      if (sendHeaders) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"choices":['); // Intentionally incomplete local fixture, never a real LLM.
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    const client = Object.assign(Object.create(DeepSeekClient.prototype), {
      maxTokens: 700, temperature: 0.7, provider: 'test', logger: null,
      baseUrl: `http://127.0.0.1:${server.address().port}`, mock: false, needsKey: false,
      apiKey: '', timeoutMs: 1000, runtime: {},
    });
    assert.equal((await route(client, '查一下价格', { timeoutMs: 80 })).failed, true);
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('underlying connection was not closed')), 500);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(requests, 1, 'no retries may survive route cancellation');
  });
}

// ---- 热搜 ----

test('redirect cycles are bounded and preserve required Weibo headers', async (t) => {
  const calls = fakeHttps(t, () => ({ status: 302, headers: { location: '/ajax/side/hotSearch' } }));
  assert.equal(await web.weiboHotText(10, 2000), '');
  assert.equal(calls.length, 6);
  for (const call of calls) assert.equal(call.options.headers.Referer, 'https://weibo.com/');
});

test('redirects share one wall-clock budget', async (t) => {
  const calls = fakeHttps(t, () => ({ status: 302, headers: { location: '/again' } }));
  assert.equal(await web.weiboHotText(10, 5), '');
  assert.ok(calls.length <= 6);
});

test('热榜返回缺失结构不能伪装成没有热点，失败后可重查且成功缓存', async t => {
  let n = 0;
  const calls = fakeHttps(t, () => ++n === 1 ? { body: '{"unexpected":[]}' }
    : { body: '{"data":{"trending":{"list":[{"keyword":"测试热点"}]}}}' });
  const first = await web.hotlistResult('bilibili', { timeoutMs: 1000 });
  assert.equal(first.reason, 'parse_error');
  const good = await web.hotlistResult('bilibili', { timeoutMs: 1000 });
  const cached = await web.hotlistResult('bilibili', { timeoutMs: 1000 });
  assert.equal(good.status, 'ok');
  assert.equal(good.items[0].url, 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('测试热点'));
  assert.deepEqual(cached.items, good.items);
  assert.equal(calls.length, 2);
});

// ---- 查询清洗（纯函数，仍在 websearch 里导出） ----

test('named models survive cleaning and are never replaced by generic lineup queries', () => {
  assert.match(web.cleanQuery('iPhone 16 Pro 最新型号多少钱'), /iPhone 16 Pro/);
  assert.match(web.cleanQuery('苹果 MacBook Pro M4 最新型号'), /MacBook Pro M4/);
  assert.match(web.cleanQuery('DeepSeek V3.2 最新价格'), /V3\.2/);
  assert.doesNotMatch(web.expandBrand('苹果 iPad 最新机型'), /iPhone/);
});

// ---- 天气 ----

test('weather geocoding and forecast use one total deadline', async (t) => {
  const calls = fakeHttps(t, (call) => call.url.includes('geocoding-api')
    ? { delay: 60, body: JSON.stringify({ results: [{ name: '北京', latitude: 39.9, longitude: 116.4 }] }) }
    : { drip: true });
  const started = Date.now();
  assert.equal(await web.weatherText('北京', { timeoutMs: 300 }), '');
  assert.equal(calls.length, 2);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `共享预算失效：耗时 ${elapsed}ms（两步各等一个超时会是 600ms+）`);
});

test('天气超时不再回退自建搜索，底层天气连接确实关闭', async t => {
  const { search } = require('../src/services/search');
  const calls = fakeHttps(t, call => call.url.includes('geocoding-api')
    ? { body: JSON.stringify({ results: [{ name: '测试城', latitude: 30, longitude: 120 }] }) }
    : call.url.includes('api.open-meteo') ? { drip: true }
      : { body: '' });
  const value = await search({ text: '测试城明天天气', config: { timeoutMs: 700 },
    llm: { complete: async () => '{"need":true,"kind":"weather","query":"测试城 明天 天气","city":"测试城","timeRange":"tomorrow"}' } });
  assert.equal(value.status, 'skipped');
  assert.equal(value.reason, 'native_search');
  assert.equal(calls.find(x => new URL(x.url).hostname === 'api.open-meteo.com').destroyed, true);
  assert.ok(!calls.some(x => x.url.includes('bing.com')), '不再回退自建抓取');
  assert.ok(value.attempts.some(x => x.provider === 'open-meteo' && x.code === 'deadline_exceeded'));
});

// ---- transport ----

test('传输调用者取消会销毁请求，零预算不会偷偷重置为八秒', async t => {
  const { getText } = require('../src/adapters/search/transport');
  const controller = new AbortController();
  const calls = fakeHttps(t, () => ({ never: true }));
  await assert.rejects(getText('https://example.test/', { timeoutMs: 0 }), { code: 'deadline_exceeded' });
  assert.equal(calls.length, 0);
  const pending = getText('https://example.test/', { signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(calls[0].destroyed, true);
});

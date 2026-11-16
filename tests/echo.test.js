'use strict';

/**
 * 复读检测：她不能把别人刚说的话原样发回去。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { isEcho, topicTokens, reasksTopic } = require('../src/core/echo');

function makeBot({ replies }) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-echo-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const calls = [];
  const llm = {
    isMock: false,
    model: 'qwen-plus',
    reload() {},
    async complete({ system }) {
      // 「检索路由器」会先问一次要不要联网；这里不是联网场景，直接答不查，
      // 别把路由调用当成一次回复，占掉回复队列。
      if (/检索路由器/.test(system)) return '{"need":false}';
      calls.push(system);
      const next = replies.shift();
      return next === undefined ? '我也不知道' : next;
    },
  };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0, rng: () => 0.9 });
  return { bot, calls, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); } };
}

const g = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g-echo', chatType: 'group',
  senderId: 'wxid_e1', senderName: '路人', text, chatTitle: '深海鱼塘', atMe: true, ...extra,
});

test('模型原样复读对方的话 → 会重写', async () => {
  const { bot, calls, cleanup } = makeBot({ replies: ['我打完了', '那你先歇会儿吧'] });
  const r = await bot.handle(g('@鲸鲸 我打完了'));
  assert.equal(r.action, 'reply');
  assert.notEqual(r.reply, '我打完了');
  assert.match(r.reply, /歇/);
  assert.equal(calls.length, 2, '应该重写一次');
  assert.match(calls[1], /重写要求/, '重写时要带明确要求');
  cleanup();
});

test('只加一个问号也算复读', async () => {
  const { bot, cleanup } = makeBot({ replies: ['好蠢？', '你才蠢，我是故意的'] });
  const r = await bot.handle(g('@鲸鲸 好蠢'));
  assert.doesNotMatch(r.reply, /^好蠢/);
  cleanup();
});

test('重写还是复读 → 换成不重复的兜底话', async () => {
  const { bot, cleanup } = makeBot({ replies: ['好蠢', '好蠢啊'] });
  const r = await bot.handle(g('@鲸鲸 好蠢'));
  assert.ok(!['好蠢', '好蠢啊'].includes(r.reply), '不该把对方的话发回去：' + r.reply);
  cleanup();
});

test('不会重复自己上一句', async () => {
  const { bot, cleanup } = makeBot({ replies: ['嘴硬', '行吧，那就当我嘴硬', '嘴硬', '那你说个不嘴硬的'] });
  const first = await bot.handle(g('@鲸鲸 你是不是嘴硬'));
  assert.equal(first.action, 'reply');
  // 第二次她本来会再回一次「嘴硬」，应被判定成自我复读并重写
  const second = await bot.handle(g('@鲸鲸 再说一遍', { msgId: 'm2' }));
  assert.notEqual(second.reply, '嘴硬');
  cleanup();
});

test('正常回答不会被改动，也不会白跑一次重写', async () => {
  const { bot, calls, cleanup } = makeBot({ replies: ['那就先休息，别硬撑'] });
  const r = await bot.handle(g('@鲸鲸 我今天好累'));
  assert.equal(r.reply, '那就先休息，别硬撑');
  assert.equal(calls.length, 1);
  cleanup();
});

test('提示词里明确禁止复读', async () => {
  const { bot, cleanup } = makeBot({ replies: ['随便'] });
  const d = await bot.decide(g('@鲸鲸 在吗'));
  assert.match(d.system, /不要复读对方刚说的话/);
  cleanup();
});

test('私聊也不会复读', async () => {
  const { bot, cleanup } = makeBot({ replies: ['在吗', '在的，说吧'] });
  const r = await bot.handle({
    platform: 'wechat', chatId: 'wxid_p1', chatType: 'private',
    senderId: 'wxid_p1', senderName: '老王', text: '在吗',
  });
  assert.notEqual(r.reply, '在吗');
  cleanup();
});

/* ------------------------------ 话题级去重（P1-2） ------------------------------ */

test('topicTokens：只留内容字，虚词碎片不进主题', () => {
  const tokens = topicTokens('你昨天说的语音补了吗');
  assert.ok(tokens.includes('语音'), '「语音」是内容主题，应被抽出');
  assert.ok(!tokens.includes('了吗'), '「了吗」是虚词碎片，不该当主题');
  assert.deepEqual(topicTokens('的了吗'), [], '纯虚词句抽不出任何主题');
});

test('reasksTopic：换说法再问刚聊过的话题 → 判重', () => {
  assert.equal(reasksTopic('语音的事你想好了吗', ['你昨天说的语音补了吗'], ['嗯']), true);
});

test('reasksTopic：对方这轮先提起 → 不算她主动重提', () => {
  assert.equal(reasksTopic('语音补了吗', ['你昨天说的语音补了吗'], ['语音我补了']), false);
});

test('reasksTopic：陈述式接续不是追问，不拦', () => {
  assert.equal(reasksTopic('语音补了就好，翻篇啦', ['你昨天说的语音补了吗'], ['嗯']), false);
});

test('reasksTopic：她没提过的话题不拦', () => {
  assert.equal(reasksTopic('你吃了吗', [], ['嗯']), false);
});

test('换说法重复追问 → 会重写成不重复的话', async () => {
  const { bot, calls, cleanup } = makeBot({ replies: ['语音的事你补了吗', '语音补了吗', '嗯行吧，翻篇'] });
  // 第一次她自己引入「语音」话题（用户没提，own 里从此有了「语音」）
  await bot.handle(g('@鲸鲸 在吗'));
  // 用户只回「嗯」没接「语音」，她却换说法又问「语音补了吗」→ 判重并重写
  const r = await bot.handle(g('@鲸鲸 嗯'));
  assert.notEqual(r.reply, '语音补了吗');
  assert.match(r.reply, /翻篇/);
  assert.ok(calls.some((c) => /重写要求/.test(c)), '要触发一次带重写要求的重写');
  cleanup();
});

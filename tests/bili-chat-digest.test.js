'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chatDigest = require('../src/services/bili/chatDigest');

function storeOf(rowsByKey) {
  const sessions = new Map(Object.keys(rowsByKey).map((k) => [k, { title: '' }]));
  return { sessions, messages: (key) => rowsByKey[key] || [] };
}

const today = new Date(2026, 10, 9, 12, 0, 0);
const start = new Date(2026, 10, 9, 0, 0, 0).getTime();
const yesterday = start - 3600000;

test('collectDay：只取今天、按会话分组、私聊/群聊标注正确', () => {
  const runtime = {
    store: storeOf({
      'wechat:u:wxid_a': [
        { role: 'user', name: '小明', text: '今天好累', ts: start + 1000 },
        { role: 'assistant', text: '那就早点睡', ts: start + 2000 },
        { role: 'user', name: '小明', text: '昨天的事', ts: yesterday },
      ],
      'wechat:g:room': [
        { role: 'user', name: '群友', text: '晚上开黑吗', ts: start + 3000 },
      ],
    }),
  };
  const out = chatDigest.collectDay(runtime, today);
  assert.equal(out.chats, 2);
  assert.match(out.text, /【私聊】/);
  assert.match(out.text, /【群聊】/);
  assert.match(out.text, /小明：今天好累/);
  assert.match(out.text, /我：那就早点睡/);
  assert.doesNotMatch(out.text, /昨天的事/, '跨天的消息不进当天素材');
});

test('collectDay：总量有上限、超长会截断', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push({ role: 'user', name: 'A', text: '这是一句比较长的聊天内容用来测试截断' + i, ts: start + i });
  const runtime = { store: storeOf({ 'wechat:u:wxid_a': rows }) };
  const out = chatDigest.collectDay(runtime, today, { maxChars: 300, perChat: 20 });
  assert.ok(out.text.length <= 301);
  assert.ok(out.messages <= 20);
});

test('collectDay：没有 store / 今天没聊天时返回空', () => {
  assert.deepEqual(chatDigest.collectDay({}, today), { text: '', chats: 0, messages: 0 });
  const runtime = { store: storeOf({ 'wechat:u:wxid_a': [{ role: 'user', name: 'A', text: '旧消息', ts: yesterday }] }) };
  assert.equal(chatDigest.collectDay(runtime, today).text, '');
});

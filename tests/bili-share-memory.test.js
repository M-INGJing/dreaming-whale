'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shareMemory = require('../src/services/bili/shareMemory');
const outbox = require('../src/services/bili/outbox');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('chatKey：私聊/群聊分别映射到记忆会话 key', () => {
  assert.equal(shareMemory.chatKey({ chatType: 'private', chatId: 'wxid_a' }), 'wechat:u:wxid_a');
  assert.equal(shareMemory.chatKey({ chatType: 'group', chatId: '123@chatroom' }), 'wechat:g:123@chatroom');
  assert.equal(shareMemory.chatKey({ chatId: 'x@chatroom' }), 'wechat:g:x@chatroom');
  assert.equal(shareMemory.chatKey({}), '');
});

test('record：分享成功后补一条 assistant 消息 + 一条动作账本（最近做过的事）', () => {
  const appended = [];
  const events = [];
  const sessions = [];
  const runtime = {
    config: { persona: { name: '鲸鲸' } },
    logger: { info() {}, warn() {} },
    store: {
      ensureSession: (key, meta) => sessions.push({ key, meta }),
      appendMessage: (key, msg) => appended.push({ key, msg }),
      events: () => events,
      appendEvent: (key, ev) => { events.push({ key, ...ev }); },
    },
  };
  const ok = shareMemory.record(runtime, {
    id: 'job-1', bvid: 'BV1xx411c7mD', title: '猫猫日常',
    text: '看了个视频 https://www.bilibili.com/video/BV1xx411c7mD/',
    chatType: 'private', chatId: 'wxid_a',
  });
  assert.equal(ok, true);
  assert.deepEqual(sessions, [{ key: 'wechat:u:wxid_a', meta: { chatId: 'wechat:u:wxid_a', chatType: 'private' } }]);
  assert.equal(appended[0].key, 'wechat:u:wxid_a');
  assert.equal(appended[0].msg.role, 'assistant');
  assert.equal(appended[0].msg.name, '鲸鲸');
  assert.match(appended[0].msg.text, /BV1xx411c7mD/);
  assert.match(appended[0].msg.msgId, /^bili-share:/);
  assert.equal(appended[0].msg.source, 'bili-share');
  assert.equal(events.length, 1, '必须同时写动作账本，否则提示词只认账本会让她否认');
  assert.equal(events[0].type, 'share');
  assert.match(events[0].detail, /猫猫日常/);
  assert.equal(events[0].status, 'confirmed');
});

test('record：没有 store / 空文本时安静跳过', () => {
  assert.equal(shareMemory.record({}, { text: 'x', chatId: 'a' }), false);
  const runtime = { store: { ensureSession() {}, appendMessage() {} }, config: {} };
  assert.equal(shareMemory.record(runtime, { text: '', chatId: 'a' }), false);
});

test('backfill：把最近 sent 的分享补进记忆；已写过的不重复', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-share-backfill-'));
  const config = {
    root,
    paths: { dataDir: path.join(root, 'data') },
    persona: { master: { wxids: ['wxid_a'], names: ['shicm'] } },
    bili: { share: { enabled: true, minScore: 0, daily: 3, minGapMinutes: 0, chats: [] } },
  };
  const target = outbox.pickTargets(config, new Date(), outbox.readLedger(config))[0];
  outbox.enqueue(config, { bvid: 'BV1xx411c7mD', title: '猫猫', text: '分享 https://www.bilibili.com/video/BV1xx411c7mD/', target });
  const claimed = outbox.claim(config, outbox.nextPending(config).id);
  outbox.ack(config, claimed.id, 'sent');

  const seen = new Set();
  const appended = [];
  const events = [];
  const runtime = {
    config,
    logger: { info() {}, warn() {} },
    store: {
      ensureSession() {},
      appendMessage(key, msg) { appended.push(msg); seen.add(key + '|' + msg.msgId); },
      isDuplicate: (key, msgId) => seen.has(key + '|' + msgId),
      events: () => events,
      appendEvent(key, ev) { events.push({ key, ...ev }); },
    },
  };
  assert.equal(shareMemory.backfill(runtime), 1);
  assert.equal(shareMemory.backfill(runtime), 0, '重复补记应跳过');
  assert.equal(appended.length, 1);
  assert.equal(events.length, 1, '动作账本只该有一条');
  assert.equal(events[0].type, 'share');
  fs.rmSync(root, { recursive: true, force: true });
});

test('和 outbox 串起来：ack(sent) 之后写入记忆，重复 ack 不重复写', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-share-mem-'));
  const config = {
    root,
    paths: { dataDir: path.join(root, 'data') },
    persona: { master: { wxids: ['wxid_a'], names: ['shicm'] } },
    bili: { share: { enabled: true, minScore: 0, daily: 3, minGapMinutes: 0, chats: [] } },
  };
  const appended = [];
  const runtime = {
    config,
    store: { ensureSession() {}, appendMessage: (key, msg) => appended.push({ key, msg }) },
    logger: { info() {}, warn() {} },
  };
  const target = outbox.pickTargets(config, new Date(), outbox.readLedger(config))[0];
  const queued = outbox.enqueue(config, { bvid: 'BV1xx411c7mD', title: '猫猫', text: '分享 https://www.bilibili.com/video/BV1xx411c7mD/', target });
  assert.equal(queued.ok, true);
  const claimed = outbox.claim(config, outbox.nextPending(config).id);
  const acked = outbox.ack(config, claimed.id, 'sent');
  assert.equal(acked.ok, true);
  if (acked.item.status === 'sent' && !acked.duplicate) shareMemory.record(runtime, acked.item);
  assert.equal(appended.length, 1);

  const again = outbox.ack(config, claimed.id, 'sent');
  assert.equal(again.duplicate, true);
  if (again.ok && again.item.status === 'sent' && !again.duplicate) shareMemory.record(runtime, again.item);
  assert.equal(appended.length, 1, '重复 ack 不应重复写记忆');
  fs.rmSync(root, { recursive: true, force: true });
});

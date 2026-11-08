'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const outbox = require('../src/services/bili/outbox');
const share = require('../src/services/bili/share');
const { resolveMasterWxid } = require('../src/services/bili/scheduler');

function makeConfig(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-p2-'));
  return {
    root,
    config: {
      paths: { dataDir: path.join(root, 'data') },
      persona: { master: { wxids: ['wxid_owner'], names: ['主人'] } },
      features: { bili: true },
      bili: {
        share: { enabled: true, minScore: 10, daily: 3, minGapMinutes: 120, silentAfterDays: 3, chats: [], ...(overrides.share || {}) },
        ...(overrides.bili || {}),
      },
    },
  };
}

const now = new Date(2026, 10, 8, 21, 0, 0);
const job = (cfg, extra = {}) => ({ bvid: 'BV1xx411c7mD', title: '猫猫', text: '分享 https://www.bilibili.com/video/BV1xx411c7mD/', target: outbox.pickTarget(cfg, now, outbox.readLedger(cfg)), ...extra });

test('canShare：分数不够、分享关闭、静默期都不发', () => {
  const { config } = makeConfig();
  assert.equal(outbox.canShare(config, { score: 5, now }).reason, 'score_too_low');
  const off = makeConfig({ share: { enabled: false } }).config;
  assert.equal(outbox.canShare(off, { score: 99, now }).reason, 'share_disabled');
  assert.equal(outbox.canShare(config, { score: 99, now, silentDays: 5 }).reason, 'silent');
});

test('canShare：主人私聊优先，没有主人时用白名单群', () => {
  const { config } = makeConfig();
  const t = outbox.canShare(config, { score: 99, now });
  assert.equal(t.ok, true);
  assert.equal(t.target.chatType, 'private');
  assert.equal(t.target.chatId, 'wxid_owner');
  assert.equal(t.target.name, '主人');

  const noMaster = makeConfig({ share: { chats: [{ chatId: '123@chatroom', name: '群', daily: 1 }] } }).config;
  noMaster.persona.master.wxids = [];
  assert.deepEqual(outbox.canShare(noMaster, { score: 99, now }).target, { chatType: 'group', chatId: '123@chatroom', name: '群' });
});

test('canShare：没有主人也没有白名单 → no_target', () => {
  const { config } = makeConfig();
  config.persona.master.wxids = [];
  assert.equal(outbox.canShare(config, { score: 99, now }).reason, 'no_target');
});

test('enqueue：同一 BV 只入队一次；已分享过的不再入队', () => {
  const { config } = makeConfig();
  assert.equal(outbox.enqueue(config, job(config)).ok, true);
  assert.equal(outbox.enqueue(config, job(config)).reason, 'already_queued');

  const other = makeConfig();
  outbox.enqueue(other.config, job(other.config));
  const item = outbox.nextPending(other.config);
  outbox.claim(other.config, item.id);
  outbox.ack(other.config, item.id, 'sent', '', now);
  assert.equal(outbox.enqueue(other.config, job(other.config)).reason, 'already_shared');
  fs.rmSync(other.root, { recursive: true, force: true });
});

test('claim/ack：两段式；重复领取失败，重复回执幂等', () => {
  const { config } = makeConfig();
  outbox.enqueue(config, job(config));
  const pending = outbox.nextPending(config);
  assert.ok(pending);
  assert.equal(outbox.nextPending(config).id, pending.id, '领取前一直 pending');

  const claimed = outbox.claim(config, pending.id);
  assert.equal(claimed.status, 'sending');
  assert.equal(outbox.claim(config, pending.id), null, 'sending 不能再被领取');
  assert.equal(outbox.nextPending(config), null, 'sending 不在 pending 列表里');

  const first = outbox.ack(config, pending.id, 'sent', '', now);
  assert.equal(first.ok, true);
  const again = outbox.ack(config, pending.id, 'failed', '', now);
  assert.equal(again.duplicate, true);
  const ledger = outbox.readLedger(config);
  assert.equal(ledger.dayCount, 1);
  assert.equal(ledger.sent.length, 1);
});

test('配额：当天发满 daily 次后不再分享；失败不计入', () => {
  const { config } = makeConfig({ share: { daily: 1 } });
  outbox.enqueue(config, job(config));
  const a = outbox.claim(config, outbox.nextPending(config).id);
  outbox.ack(config, a.id, 'sent', '', now);
  assert.equal(outbox.canShare(config, { score: 99, now }).reason, 'daily_cap');

  const fresh = makeConfig({ share: { daily: 1 } }).config;
  outbox.enqueue(fresh, job(fresh));
  const b = outbox.claim(fresh, outbox.nextPending(fresh).id);
  outbox.ack(fresh, b.id, 'failed', '', now);
  assert.equal(outbox.canShare(fresh, { score: 99, now }).ok, true, '失败不占额度');
});

test('间隔：两次分享至少 minGapMinutes 分钟', () => {
  const { config } = makeConfig();
  outbox.enqueue(config, job(config));
  const a = outbox.claim(config, outbox.nextPending(config).id);
  outbox.ack(config, a.id, 'sent', '', now);
  assert.equal(outbox.canShare(config, { score: 99, now: new Date(now.getTime() + 10 * 60000) }).reason, 'gap');
  assert.equal(outbox.canShare(config, { score: 99, now: new Date(now.getTime() + 121 * 60000) }).ok, true);
});

test('群白名单：每群 daily 用完后跳过这一群', () => {
  const { config } = makeConfig({ share: { chats: [{ chatId: '123@chatroom', name: '群', daily: 1 }] } });
  config.persona.master.wxids = [];
  outbox.enqueue(config, job(config));
  const a = outbox.claim(config, outbox.nextPending(config).id);
  outbox.ack(config, a.id, 'sent', '', now);
  config.bili.share.daily = 10; // 全局还有额度，但这一群今天已经发过
  const later = new Date(now.getTime() + 121 * 60000);
  assert.equal(outbox.canShare(config, { score: 99, now: later }).reason, 'no_target');
});

test('sweepStale：sending 超过 10 分钟自动标失败，避免卡死', () => {
  const { config } = makeConfig();
  outbox.enqueue(config, job(config));
  const a = outbox.claim(config, outbox.nextPending(config).id);
  assert.equal(outbox.sweepStale(config, Date.now() + 11 * 60000), 1);
  assert.equal(outbox.ack(config, a.id, 'sent', '', now).duplicate, true);
  const items = JSON.parse(fs.readFileSync(path.join(config.paths.dataDir, 'bili', 'outbox.json'), 'utf8')).items;
  assert.equal(items[0].status, 'failed');
  assert.equal(items[0].error, 'timeout');
});

test('resolveMasterWxid：配置优先；没配置时从记忆私聊反查（只认 master.names）', () => {
  const { config } = makeConfig();
  assert.equal(resolveMasterWxid(null, config), 'wxid_owner');

  const empty = makeConfig();
  empty.config.persona.master.wxids = [];
  const runtime = {
    store: {
      sessions: new Map([
        ['wechat:u:wxid_stranger', {}],
        ['wechat:u:wxid_themaster', {}],
        ['wechat:g:example-group@chatroom', {}],
      ]),
      messages: (key) => (key === 'wechat:u:wxid_themaster'
        ? [{ role: 'user', name: '主人' }]
        : [{ role: 'user', name: '路人' }]),
    },
  };
  assert.equal(resolveMasterWxid(runtime, empty.config), 'wxid_themaster');
  runtime.store.messages = () => [{ role: 'user', name: '路人' }];
  assert.equal(resolveMasterWxid(runtime, empty.config), '', '名字对不上就宁可不发');
});

test('canShare：显式传入 masterWxid 时按主人私聊分享', () => {
  const { config } = makeConfig();
  config.persona.master.wxids = [];
  const t = outbox.canShare(config, { score: 99, now, masterWxid: 'wxid_resolved' });
  assert.equal(t.ok, true);
  assert.equal(t.target.chatId, 'wxid_resolved');
  assert.equal(t.target.chatType, 'private');
});

test('composeShare：没有模型走模板；群文案更短且带链接', async () => {
  const candidate = { bvid: 'BV1xx411c7mD', title: '猫猫日常', durationSec: 600, owner: { name: 'UP' } };
  const a = await share.composeShare({ llm: null, candidate, chatType: 'private' });
  assert.equal(a.usedModel, false);
  assert.match(a.text, /BV1xx411c7mD/);
  const b = await share.composeShare({ llm: null, candidate, chatType: 'group' });
  assert.ok(b.text.length <= 120);
});

test('composeShare：模型输出过长会被截断并补链接；失败回退模板', async () => {
  const candidate = { bvid: 'BV1xx411c7mD', title: 'T', durationSec: 60, owner: { name: 'U' } };
  const longModel = { isMock: false, complete: async () => '好看'.repeat(300) };
  const out = await share.composeShare({ llm: longModel, candidate, chatType: 'group' });
  assert.equal(out.usedModel, true);
  assert.ok(out.text.length <= 300);
  assert.match(out.text, /BV1xx411c7mD/);

  const bad = { isMock: false, complete: async () => { throw new Error('boom'); } };
  const fallback = await share.composeShare({ llm: bad, candidate, chatType: 'private' });
  assert.equal(fallback.usedModel, false);
  assert.match(fallback.text, /BV1xx411c7mD/);
});

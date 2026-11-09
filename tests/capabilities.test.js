'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const capabilities = require('../src/services/capabilities');
const biliStore = require('../src/infra/biliStore');

function tmpRuntime(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-'));
  const config = {
    root,
    paths: { dataDir: path.join(root, 'data') },
    features: { bili: true },
    bili: { diary: { enabled: true, chatMinGapMinutes: 0 } },
    capabilities: { enabled: true, maxPerDay: 5 },
    ...(overrides.config || {}),
  };
  return { root, config, runtime: { config, logger: { info() {}, warn() {} }, llm: null, ...(overrides.runtime || {}) } };
}

test('detect/strip：识别能力标记并去掉，不留在正文里', () => {
  assert.deepEqual(capabilities.detect('好呀，我去看看 [[cap:bili.watch]]'), ['bili.watch']);
  assert.deepEqual(capabilities.detect('[[cap:bili.watch]] [[cap:bili.diary.write]]'), ['bili.watch', 'bili.diary.write']);
  assert.deepEqual(capabilities.detect('[[cap:逛 B 站]]'), ['bili.watch'], '中文标签也能认');
  assert.deepEqual(capabilities.detect('[[cap:写今天的日记]]'), ['bili.diary.write']);
  assert.deepEqual(capabilities.detect('没有标记'), []);
  assert.equal(capabilities.strip('好呀，我去看看 [[cap:bili.watch]]'), '好呀，我去看看');
});

test('list/block：列出能力并带 UI 需要的状态；提示词只写能用的', () => {
  const { config } = tmpRuntime();
  const items = capabilities.list(config);
  assert.deepEqual(items.map((x) => x.id), ['bili.watch', 'bili.diary.write']);
  assert.equal(items[0].available, true);
  assert.equal(items[0].enabled, true);
  assert.equal(items[0].maxPerDay, 5);
  const block = capabilities.block(config);
  assert.match(block, /你会自己做的事/);
  assert.match(block, /\[\[cap:id\]\]/);
  assert.match(block, /id：bili\.watch/);
  assert.match(block, /说和做必须一致/);

  const off = tmpRuntime({ config: { features: { bili: false } } }).config;
  const offItems = capabilities.list(off);
  assert.equal(offItems.length, 2, 'UI 仍要显示，只是不可用');
  assert.equal(offItems[0].available, false);
  assert.deepEqual(capabilities.promptItems(off), []);
  assert.equal(capabilities.block(off), '');
});

test('block：日记关闭时提示词只保留逛 B 站', () => {
  const { config } = tmpRuntime({ config: { bili: { diary: { enabled: false } } } });
  assert.deepEqual(capabilities.promptItems(config).map((x) => x.id), ['bili.watch']);
});

test('能力可以单独关掉、单独设每日上限', async () => {
  const { config, runtime, root } = tmpRuntime({
    config: { capabilities: { enabled: true, maxPerDay: 5, items: { 'bili.watch': { enabled: false, maxPerDay: 1 } } } },
  });
  const items = capabilities.list(config);
  const watch = items.find((x) => x.id === 'bili.watch');
  assert.equal(watch.enabled, false);
  assert.equal(watch.maxPerDay, 1);
  assert.deepEqual(capabilities.promptItems(config).map((x) => x.id), ['bili.diary.write']);
  runtime.biliScheduler = { runRound: async () => ({ ok: true, watched: [], diary: { ownerChars: 0 } }) };
  const out = await capabilities.run(runtime, ['bili.watch'], { now: new Date(2026, 10, 9, 22, 0) });
  assert.equal(out[0].ok, false);
  assert.match(out[0].summary, /不可用/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('run：逛 B 站会执行调度器且 noShare=true，结果写进动作记录', async () => {
  const { config, runtime, root } = tmpRuntime();
  let captured = null;
  runtime.biliScheduler = {
    runRound: async (opts) => {
      captured = opts;
      return {
        ok: true,
        watched: ['BV1xx411c7mD', 'BV2xx411c7mD'],
        watchedInfo: [
          { bvid: 'BV1xx411c7mD', title: '猫猫日常', excerpt: '一只猫在窗台上打滚，配文很治愈。' },
          { bvid: 'BV2xx411c7mD', title: 'AI 实测', excerpt: '实测 DeepSeek 清理 C 盘，翻车了两次。' },
        ],
        diary: { ownerChars: 42 },
      };
    },
  };
  biliStore.mergeTitles(config, { BV1xx411c7mD: '猫猫日常', BV2xx411c7mD: 'AI 实测' });
  const out = await capabilities.run(runtime, ['bili.watch'], { now: new Date(2026, 10, 9, 22, 0) });
  assert.equal(out[0].ok, true);
  assert.equal(captured.noShare, true, '自己的能力调用不主动发分享');
  assert.match(out[0].summary, /看了 2 条/);
  assert.equal(out[0].detail.items[0].title, '猫猫日常');
  assert.match(out[0].detail.items[0].excerpt, /打滚/);
  const actions = capabilities.readActions(config);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'bili.watch');

  const recent = capabilities.recentBlock(config, new Date(2026, 10, 9, 22, 5));
  assert.match(recent, /你最近做过的/);
  assert.match(recent, /22:00 逛 B 站/);
  assert.match(recent, /猫猫日常/, '最近做过要带具体标题');
  assert.match(recent, /打滚/, '还要带一点内容摘要，否则她下一轮只能编');
  fs.rmSync(root, { recursive: true, force: true });
});

test('run：每天次数上限，超了直接拒绝', async () => {
  const { config, runtime, root } = tmpRuntime({ config: { capabilities: { enabled: true, maxPerDay: 1 } } });
  runtime.biliScheduler = { runRound: async () => ({ ok: true, watched: [], diary: { ownerChars: 0 } }) };
  const first = await capabilities.run(runtime, ['bili.watch'], { now: new Date(2026, 10, 9, 22, 0) });
  assert.equal(first[0].ok, true);
  const second = await capabilities.run(runtime, ['bili.watch'], { now: new Date(2026, 10, 9, 22, 1) });
  assert.equal(second[0].ok, false);
  assert.match(second[0].summary, /做太多次/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scheduler(noShare)：不往 outbox 写分享', async () => {
  const { createBiliScheduler } = require('../src/services/bili/scheduler');
  const now = new Date(2026, 10, 9, 22, 0);
  const { config, runtime, root } = tmpRuntime({
    config: {
      persona: { master: { wxids: ['wxid_a'], names: ['shicm'] } },
      bili: {
        diary: { enabled: true, chatMinGapMinutes: 0 },
        night: { windows: [{ start: '00:00', end: '23:59', wakes: 1 }], skipChance: 0, maxVideos: 5, maxWakesPerDay: 1, maxMinutes: 45 },
        risk: { readHourly: 120, readDaily: 400 },
        share: { enabled: true, minScore: 0, daily: 3, minGapMinutes: 0, chats: [] },
      },
    },
  });
  const sched = createBiliScheduler({
    config,
    runtime,
    now: () => now,
    fetchFeed: async () => ({ source: 'rcmd', items: [{ bvid: 'BV1xx411c7mD', title: '猫猫', durationSec: 60, pubdate: 0, stat: { view: 100 } }] }),
    readMaterials: async () => ({ digest: '【B站视频】猫猫', info: null, replies: [] }),
    writeDiary: async () => ({ ownerChars: 1, selfChars: 1, usedModel: false, rewritten: true }),
  });
  const out = await sched.runRound({ now, noShare: true });
  assert.equal(out.ok, true);
  assert.equal(out.share, null);
  const outboxFile = path.join(root, 'data', 'bili', 'outbox.json');
  assert.equal(fs.existsSync(outboxFile), false, '不应该入队分享');
  fs.rmSync(root, { recursive: true, force: true });
});

test('run：写日记能力用当天聊天素材更新当天那一篇', async () => {
  const now = new Date(2026, 10, 9, 22, 0);
  const { config, runtime, root } = tmpRuntime();
  runtime.store = {
    sessions: new Map([['wechat:u:wxid_a', {}]]),
    messages: () => [{ role: 'user', name: '小明', text: '今天加班到十点', ts: now.getTime() }],
  };
  const out = await capabilities.run(runtime, ['bili.diary.write'], { now });
  assert.equal(out[0].ok, true);
  const owner = fs.readFileSync(biliStore.paths(config).diaryOwner, 'utf8');
  assert.match(owner, /## 2026-11-09/);
  assert.match(owner, /聊了会儿/);
  fs.rmSync(root, { recursive: true, force: true });
});

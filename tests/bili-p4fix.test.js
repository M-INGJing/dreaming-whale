'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const clock = require('../src/core/bili/clock');
const biliStore = require('../src/infra/biliStore');
const resolve = require('../src/services/bili/resolve');
const biliWatch = require('../src/services/biliWatch');
const { createBiliScheduler } = require('../src/services/bili/scheduler');

const at = (h, m = 0) => new Date(2026, 10, 8, h, m, 0);

function tmpConfig(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-fix-'));
  return {
    root,
    config: {
      paths: { dataDir: path.join(root, 'data') },
      features: { bili: true },
      bili: { diary: { enabled: true, maxCharsPerDay: 0 }, ...(overrides.bili || {}) },
      ...(overrides.config || {}),
    },
  };
}

test('clock：窗口内按「日期+窗口」的固定抖动推迟，不是一进窗口就开跑', () => {
  const windows = [{ start: '20:00', end: '24:00', wakes: 1 }];
  const offset = clock.seedOf('2026-11-08|' + 20 * 60) % 61;
  const before = new Date(2026, 10, 8, 20, Math.max(0, offset - 1));
  const after = new Date(2026, 10, 8, 20, Math.min(59, offset));
  const opts = { windows, skipChance: 0, maxWakesPerDay: 1, jitterMinutes: 60 };
  if (offset > 0) assert.equal(clock.shouldWake(opts, {}, before, () => 0.99).reason, 'jitter');
  assert.equal(clock.shouldWake(opts, {}, after, () => 0.99).wake, true);
});

test('diary 上限：当天写满后不再追加，剩余太少就整条跳过', () => {
  const { config } = tmpConfig({ bili: { diary: { enabled: true, maxCharsPerDay: 200 } } });
  const file = biliStore.appendDiary(config, 'owner', at(10), '甲'.repeat(150));
  assert.ok(file);
  const second = biliStore.appendDiary(config, 'owner', at(11), '乙'.repeat(150));
  assert.equal(second, '', '只剩 50 字，不够 60 就不写');
  const md = fs.readFileSync(biliStore.paths(config).diaryOwner, 'utf8');
  assert.ok(md.length < 400, '不能无限追加');
  fs.rmSync(path.dirname(config.paths.dataDir), { recursive: true, force: true });
});

test('resolve：跟随 302 拿到最终视频地址；失败/超跳数返回空', async () => {
  const head = async (url) => {
    if (url === 'https://b23.tv/abc') return { status: 302, location: 'https://www.bilibili.com/video/BV1xx411c7mD?share=1' };
    return { status: 200, location: '' };
  };
  const out = await resolve.resolveUrl('https://b23.tv/abc', { head });
  assert.equal(out, 'https://www.bilibili.com/video/BV1xx411c7mD?share=1');

  const loop = async () => ({ status: 302, location: 'https://b23.tv/loop' });
  assert.equal(await resolve.resolveUrl('https://b23.tv/loop', { head: loop }), 'https://b23.tv/loop', '最多跳 3 次后停住');
  assert.equal(await resolve.resolveUrl('not a url', { head }), '');
});

test('biliWatch：b23 短链先解析再读，读不到返回空结构', async () => {
  const watchMaterials = async () => ({
    info: { bvid: 'BV1xx411c7mD', title: 'T', desc: '', durationSec: 60, owner: { name: 'U' }, stat: { view: 1 } },
    subtitle: { text: '' },
    replies: [],
  });
  const out = await biliWatch.readMaterials({}, 'https://b23.tv/abc', {
    client: {},
    watchMaterials,
    resolveUrl: async () => 'https://www.bilibili.com/video/BV1xx411c7mD',
  });
  assert.equal(out.info.bvid, 'BV1xx411c7mD');
  assert.match(out.digest, /【B站视频】/);

  const bad = await biliWatch.readMaterials({}, 'https://b23.tv/abc', {
    client: {}, watchMaterials, resolveUrl: async () => '',
  });
  assert.deepEqual(bad, { digest: '', info: null, replies: [] });
});

test('scheduler：主人沉默超过 silentAfterDays 就不分享', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-silent-'));
  const config = {
    paths: { dataDir: path.join(root, 'data') },
    persona: { master: { wxids: ['wxid_owner'], names: ['主人'] } },
    features: { bili: true },
    bili: {
      preferences: { like: [] },
      night: { windows: [{ start: '00:00', end: '23:59', wakes: 1 }], skipChance: 0, maxVideos: 5, maxWakesPerDay: 1, maxMinutes: 45 },
      risk: { readHourly: 120, readDaily: 400 },
      share: { enabled: true, minScore: 0, daily: 3, minGapMinutes: 0, silentAfterDays: 3, chats: [] },
      diary: { enabled: true },
    },
  };
  const sched = createBiliScheduler({
    config,
    now: () => at(12),
    masterSilenceDays: () => 5,
    fetchFeed: async () => ({ source: 'rcmd', items: [{ bvid: 'BV1xx411c7mD', title: 'T', durationSec: 60, pubdate: 0, stat: { view: 1 } }] }),
    readVideo: async () => '【B站视频】T',
    readMaterials: async () => ({ digest: '【B站视频】T', info: null, replies: [] }),
    writeDiary: async () => ({ ownerChars: 1, selfChars: 1, usedModel: false }),
  });
  const out = await sched.runRound({ dry: false, now: at(12) });
  assert.equal(out.ok, true);
  assert.equal(out.share, null, '沉默 5 天 > 3 天，不分享');
  const events = fs.readFileSync(path.join(root, 'data', 'bili', 'events.jsonl'), 'utf8');
  assert.match(events, /"kind":"share_skip".*"reason":"silent"/);
  fs.rmSync(root, { recursive: true, force: true });
});

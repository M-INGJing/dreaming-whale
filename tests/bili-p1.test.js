'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const clock = require('../src/core/bili/clock');
const score = require('../src/core/bili/score');
const quota = require('../src/core/bili/quota');
const diaryFormat = require('../src/core/bili/diaryFormat');
const feed = require('../src/services/bili/feed');
const diary = require('../src/services/bili/diary');
const { createBiliScheduler } = require('../src/services/bili/scheduler');

const at = (h, m = 0, day = 8) => new Date(2026, 10, day, h, m, 0);

test('clock.shouldWake：窗口内醒、窗口外不醒、当天醒够不醒', () => {
  const opts = { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0, maxWakesPerDay: 1 };
  assert.equal(clock.shouldWake(opts, { date: '2026-11-08', wakes: 0 }, at(21)).wake, true);
  assert.equal(clock.shouldWake(opts, { date: '2026-11-08', wakes: 0 }, at(10)).reason, 'outside_window');
  assert.equal(clock.shouldWake(opts, { date: '2026-11-08', wakes: 1 }, at(22)).reason, 'already_awake');
});

test('clock.shouldWake：跨午夜窗口（22:00–02:00）两边都算窗口内', () => {
  const opts = { windows: [{ start: '22:00', end: '02:00', wakes: 1 }], skipChance: 0, maxWakesPerDay: 1 };
  assert.equal(clock.shouldWake(opts, {}, at(23)).wake, true);
  assert.equal(clock.shouldWake(opts, {}, at(1)).wake, true);
  assert.equal(clock.shouldWake(opts, {}, at(12)).wake, false);
});

test('clock.shouldWake：skipChance=1 一定开摆，且状态标记 skipped', () => {
  const opts = { windows: [{ start: '00:00', end: '23:59', wakes: 1 }], skipChance: 1, maxWakesPerDay: 1 };
  const out = clock.shouldWake(opts, { date: '2026-11-08', wakes: 0 }, at(12), () => 0);
  assert.equal(out.wake, false);
  assert.equal(out.reason, 'skip_roll');
  assert.equal(out.skipped, true);
});

test('clock.shouldWake：新的一天重置 wakes / skipped', () => {
  const opts = { windows: [{ start: '00:00', end: '23:59', wakes: 1 }], skipChance: 0, maxWakesPerDay: 1 };
  assert.equal(clock.shouldWake(opts, { date: '2026-11-07', wakes: 1, skipped: true }, at(9)).wake, true);
});

test('clock.nextWindowIn：给出距下一个窗口开始的分钟数', () => {
  const windows = [{ start: '20:00', end: '24:00', wakes: 1 }];
  assert.equal(clock.nextWindowIn(windows, at(19, 30)), 30);
  assert.equal(clock.nextWindowIn(windows, at(21)), 23 * 60);
});

test('score：喜欢加权、踩雷降权、看过直接淘汰、超时长降权', () => {
  const prefs = { like: ['猫咪'], dislike: ['带货'] };
  const base = { bvid: 'BV1xx411c7mD', title: '猫咪日常', desc: '', durationSec: 600, pubdate: 0, stat: { view: 0 } };
  const like = score.scoreCandidate(base, prefs, { now: at(12).getTime() });
  const dislike = score.scoreCandidate({ ...base, bvid: 'BV2xx411c7mD', title: '带货直播' }, prefs, { now: at(12).getTime() });
  assert.ok(like.score > dislike.score);
  const seen = score.scoreCandidate(base, prefs, { now: at(12).getTime(), seen: new Set(['BV1xx411c7mD']) });
  assert.equal(seen.score, score.W.seen);
  const long = score.scoreCandidate({ ...base, bvid: 'BV3xx411c7mD', durationSec: 3 * 3600 }, prefs, { now: at(12).getTime(), maxMinutes: 45 });
  assert.ok(long.reasons.includes('too_long'));
});

test('score.rankCandidates：按分数排序并截断', () => {
  const prefs = { like: ['猫'], dislike: [] };
  const items = [
    { bvid: 'BV1xx411c7mD', title: '别的', durationSec: 60, pubdate: 0, stat: { view: 0 } },
    { bvid: 'BV2xx411c7mD', title: '猫猫', durationSec: 60, pubdate: 0, stat: { view: 1000000 } },
  ];
  const top = score.rankCandidates(items, prefs, { now: at(12).getTime(), limit: 1 });
  assert.equal(top.length, 1);
  assert.equal(top[0].candidate.bvid, 'BV2xx411c7mD');
});

test('quota：跨小时/跨天清零，读写上限与写冷却', () => {
  const risk = { readHourly: 2, readDaily: 10, writeHourly: 1, writeDaily: 2, writeGapSec: 120 };
  let s = quota.roll(quota.emptyState(), at(10, 10));
  s = quota.noteRead(s, 2, at(10, 10));
  assert.equal(quota.canRead(s, risk, at(10, 20)).reason, 'read_hourly');
  assert.equal(quota.canRead(s, risk, at(11, 5)).ok, true, '跨小时应恢复额度');

  let w = quota.roll(quota.emptyState(), at(10, 0));
  w = quota.noteWrite(w, at(10, 0));
  const gapRisk = { writeHourly: 5, writeDaily: 5, writeGapSec: 120 };
  assert.equal(quota.canWrite(w, gapRisk, at(10, 1)).reason, 'write_gap');
  assert.equal(quota.canWrite(w, gapRisk, at(10, 5)).ok, true);
  assert.equal(quota.canWrite(w, risk, at(10, 5)).reason, 'write_hourly');
  assert.equal(quota.canWrite(w, risk, at(11, 0)).ok, true, '跨小时恢复写额度（当天还没到 2 次）');
});

test('diaryFormat：按天分节、当天摘要只取那一节、计数正确', () => {
  const d1 = new Date(2026, 10, 7);
  const d2 = new Date(2026, 10, 8);
  const md = diaryFormat.section(d1, '昨天看了猫') + '\n' + diaryFormat.section(d2, '今天看了狗');
  assert.equal(diaryFormat.countDays(md), 2);
  assert.equal(diaryFormat.digestOf(md, d2), '今天看了狗');
  assert.equal(diaryFormat.digestOf(md, new Date(2026, 10, 9)), '');
});

test('feed.normalizeItem：字段归一化，非法 bvid 丢弃', () => {
  const item = feed.normalizeItem({ bvid: 'BV1xx411c7mD', title: 'T', duration: 90, pubdate: 123, owner: { name: 'U' }, stat: { view: 5, like: 1 } });
  assert.equal(item.bvid, 'BV1xx411c7mD');
  assert.equal(item.durationSec, 90);
  assert.equal(feed.normalizeItem({ bvid: 'bad' }), null);
});

test('diary.writeRound：没有模型时用模板，两本都写', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-diary-'));
  const config = { paths: { dataDir: path.join(root, 'data') } };
  const out = await diary.writeRound({ config, llm: null, date: new Date(2026, 10, 8), watched: [{ candidate: { bvid: 'BV1xx411c7mD', title: '猫猫' }, digest: '' }] });
  assert.equal(out.usedModel, false);
  assert.ok(out.ownerChars > 0 && out.selfChars > 0);
  const owner = fs.readFileSync(path.join(root, 'data', 'bili', 'diary', 'owner.md'), 'utf8');
  assert.match(owner, /## 2026-11-08/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('diary.parseModelOutput：能容忍包在代码块/多余文字里的 JSON', () => {
  const out = diary.parseModelOutput('好的\n```json\n{"owner":"今天看了猫","self":"更喜欢猫"}\n```');
  assert.deepEqual(out, { owner: '今天看了猫', self: '更喜欢猫' });
  assert.equal(diary.parseModelOutput('没有 JSON'), null);
});

function schedulerHarness(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-sched-'));
  const config = {
    paths: { dataDir: path.join(root, 'data') },
    features: { bili: true },
    bili: {
      preferences: { like: ['猫'], dislike: ['带货'] },
      night: { windows: [{ start: '00:00', end: '23:59', wakes: 1 }], skipChance: 0, maxVideos: 5, maxWakesPerDay: 1, maxMinutes: 45 },
      risk: { readHourly: 120, readDaily: 400 },
      diary: { enabled: true },
      ...(overrides.bili || {}),
    },
  };
  const calls = { feed: 0, video: [], diary: 0 };
  const sched = createBiliScheduler({
    config,
    logger: null,
    now: () => at(12),
    rng: () => 0.99,
    fetchFeed: async () => { calls.feed += 1; return { source: 'rcmd', items: overrides.items || [
      { bvid: 'BV1xx411c7mD', title: '猫猫日常', durationSec: 600, pubdate: 0, stat: { view: 100000 } },
    ], reason: '' }; },
    readVideo: async (cfg, bvid) => { calls.video.push(bvid); return '【B站视频】猫猫日常'; },
    writeDiary: async () => { calls.diary += 1; return { ownerChars: 10, selfChars: 5, usedModel: false }; },
  });
  return { sched, calls, root, config };
}

test('scheduler.runRound(dry)：只打分，不读视频、不写日记、不写盘', async () => {
  const { sched, calls, root } = schedulerHarness();
  const out = await sched.runRound({ dry: true, now: at(12) });
  assert.equal(out.ok, true);
  assert.equal(out.dry, true);
  assert.equal(out.picked.length, 1);
  assert.equal(calls.video.length, 0);
  assert.equal(calls.diary, 0);
  assert.equal(fs.existsSync(path.join(root, 'data', 'bili', 'diary')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scheduler.runRound：真实跑一轮，读视频 + 写日记 + 记 wake 状态与配额', async () => {
  const { sched, calls, root } = schedulerHarness();
  const out = await sched.runRound({ dry: false, now: at(12) });
  assert.equal(out.ok, true);
  assert.deepEqual(calls.video, ['BV1xx411c7mD']);
  assert.equal(calls.diary, 1);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'data', 'bili', 'state.json'), 'utf8'));
  assert.equal(state.wakes, 1);
  assert.equal(state.date, '2026-11-08');
  const q = JSON.parse(fs.readFileSync(path.join(root, 'data', 'bili', 'quota.json'), 'utf8'));
  assert.ok(q.readDay > 0);
  const events = fs.readFileSync(path.join(root, 'data', 'bili', 'events.jsonl'), 'utf8').trim().split('\n');
  assert.ok(events.some((line) => JSON.parse(line).kind === 'wake'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('scheduler.tick：开关关着时什么都不做', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-off-'));
  const calls = { feed: 0 };
  const off = createBiliScheduler({
    config: { paths: { dataDir: path.join(root, 'data') }, features: { bili: false }, bili: {} },
    fetchFeed: async () => { calls.feed += 1; return { items: [], reason: '' }; },
  });
  const out = await off.tick(at(12));
  assert.equal(out.woke, false);
  assert.equal(out.reason, 'disabled');
  assert.equal(calls.feed, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scheduler.tick：窗口内醒一次，第二次不再醒', async () => {
  const { sched, root } = schedulerHarness();
  const first = await sched.tick(at(12));
  assert.equal(first.woke, true);
  const second = await sched.tick(at(12));
  assert.equal(second.woke, false);
  assert.equal(second.reason, 'already_awake');
  fs.rmSync(root, { recursive: true, force: true });
});

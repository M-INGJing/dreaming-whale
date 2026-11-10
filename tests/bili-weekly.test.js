'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const biliStore = require('../src/infra/biliStore');
const weekly = require('../src/services/bili/weekly');
const chat = require('../src/services/bili/chat');

function tmpConfig(biliOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-weekly-'));
  return {
    root,
    config: {
      paths: { dataDir: path.join(root, 'data') },
      features: { bili: true },
      bili: { diary: { enabled: true }, weekly: { enabled: true, weekday: 0, hour: 22 }, ...biliOverrides },
    },
  };
}

const sunday = new Date(2026, 10, 8, 22, 30, 0); // 2026-11-08 是周日
const saturday = new Date(2026, 10, 7, 22, 30, 0);

function dayOf(offset, hour = 21) {
  const d = new Date(sunday);
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - offset);
  return d;
}

test('weekStartOf：返回最近的周日 0 点', () => {
  const start = weekly.weekStartOf(sunday);
  assert.equal(start.getDay(), 0);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getDate(), 8);
});

test('collectWeekEntries：汇总最近 7 天的两本日记，更早的不算', () => {
  const { config, root } = tmpConfig();
  biliStore.writeDiarySection(config, 'owner', dayOf(1), '昨天看了猫。');
  biliStore.writeDiarySection(config, 'self', dayOf(1), '更喜欢猫。');
  biliStore.writeDiarySection(config, 'owner', dayOf(2), '前天聊到加班。');
  biliStore.writeDiarySection(config, 'owner', dayOf(9), '九天前的旧日记，不该出现。');
  const week = weekly.collectWeekEntries(config, sunday);
  assert.ok(week.days >= 2);
  assert.match(week.text, /昨天看了猫/);
  assert.match(week.text, /前天聊到加班/);
  assert.doesNotMatch(week.text, /九天前/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('maybeUpdate：只在周日 22 点后跑一次；没有日记/没有模型跳过', async () => {
  const { config, root, } = tmpConfig();
  const runtime = { config, logger: null, llm: { isMock: false, complete: async () => '{"summary":"这周有点累但还行。","likes":["猫"],"dislikes":["吵架"],"state":"有点累"}' } };
  assert.equal((await weekly.maybeUpdate(runtime, { now: saturday })).skipped, 'not_weekday');
  const early = new Date(sunday); early.setHours(10, 0, 0, 0);
  assert.equal((await weekly.maybeUpdate(runtime, { now: early })).skipped, 'too_early');
  assert.equal((await weekly.maybeUpdate(runtime, { now: sunday })).skipped, 'no_diary');

  biliStore.writeDiarySection(config, 'owner', dayOf(1), '这周看了猫，也聊了加班。');
  const first = await weekly.maybeUpdate(runtime, { now: sunday });
  assert.equal(first.ok, true);
  assert.match(first.entry.summary, /这周/);
  const again = await weekly.maybeUpdate(runtime, { now: sunday });
  assert.equal(again.skipped, 'already_done');

  const noModel = tmpConfig();
  biliStore.writeDiarySection(noModel.config, 'owner', dayOf(1), '写了点东西。');
  assert.equal((await weekly.maybeUpdate({ config: noModel.config, llm: null }, { now: sunday })).skipped, 'no_model');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(noModel.root, { recursive: true, force: true });
});

test('blockFor：有新鲜小结就注入，超过 14 天不注入', () => {
  const { config, root } = tmpConfig();
  biliStore.writeJson(weekly.weeklyPath(config), {
    weekStart: '2026-11-08', generatedAt: Date.now(), summary: '这周状态还行。', likes: ['猫'], dislikes: ['吵架'], state: '',
  });
  const block = weekly.blockFor(config, sunday);
  assert.match(block, /我最近的状态/);
  assert.match(block, /这周状态还行/);
  assert.match(block, /最近更喜欢：猫/);

  biliStore.writeJson(weekly.weeklyPath(config), { weekStart: '2026-10-01', generatedAt: Date.now() - 20 * 86400000, summary: '很旧了' });
  assert.equal(weekly.blockFor(config, sunday), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('chat.blocks：周小结也会进聊天注入', () => {
  const { config, root } = tmpConfig();
  biliStore.writeJson(weekly.weeklyPath(config), {
    weekStart: '2026-11-08', generatedAt: sunday.getTime(), summary: '这周看了不少猫。', likes: ['猫'], dislikes: [], state: '',
  });
  const block = chat.blocks(config, '在吗', sunday);
  assert.match(block, /这周看了不少猫/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('maybeUpdate(force)：手动补跑不受周日/时间限制', async () => {
  const { config, root } = tmpConfig();
  biliStore.writeDiarySection(config, 'owner', dayOf(1), '这周看了猫。');
  const runtime = { config, llm: { isMock: false, complete: async () => '{"summary":"手动补跑。","likes":[],"dislikes":[],"state":""}' } };
  const out = await weekly.maybeUpdate(runtime, { now: saturday, force: true });
  assert.equal(out.ok, true);
  assert.equal(weekly.readWeekly(config).summary, '手动补跑。');
  fs.rmSync(root, { recursive: true, force: true });
});

test('maybeUpdate：有人设时，把语气基调注入写小结的提示词', async () => {
  const { config, root } = tmpConfig();
  config.persona = { personality: '温柔但有点小倔' };
  biliStore.writeDiarySection(config, 'owner', dayOf(1), '这周看了猫。');
  let seenSystem = '';
  const runtime = { config, llm: { isMock: false, complete: async (opts) => { seenSystem = opts.system; return '{"summary":"这周挺好。","likes":[],"dislikes":[],"state":""}'; } } };
  const out = await weekly.maybeUpdate(runtime, { now: saturday, force: true });
  assert.equal(out.ok, true);
  assert.match(seenSystem, /温柔但有点小倔/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scheduler.tick：窗口没开也会在周日 22 点后更新周小结', async () => {
  const { createBiliScheduler } = require('../src/services/bili/scheduler');
  const { config, root } = tmpConfig({
    night: { windows: [{ start: '00:00', end: '00:01', wakes: 1 }], skipChance: 0, maxVideos: 5, maxWakesPerDay: 1, maxMinutes: 45 },
    risk: { readHourly: 120, readDaily: 400 },
    share: { enabled: false, daily: 0, minGapMinutes: 0, chats: [] },
  });
  biliStore.writeDiarySection(config, 'owner', dayOf(1), '这周看了猫。');
  const runtime = {
    config,
    logger: null,
    llm: { isMock: false, complete: async () => '{"summary":"这周挺好。","likes":[],"dislikes":[],"state":""}' },
  };
  const sched = createBiliScheduler({ config, runtime, now: () => sunday });
  const out = await sched.tick(sunday);
  assert.equal(out.woke, false);
  assert.equal(out.weekly.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

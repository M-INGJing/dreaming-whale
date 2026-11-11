'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const diaryFormat = require('../src/core/bili/diaryFormat');
const diary = require('../src/services/bili/diary');
const biliStore = require('../src/infra/biliStore');

function tmpConfig(diaryOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-rewrite-'));
  return {
    root,
    config: {
      paths: { dataDir: path.join(root, 'data') },
      bili: { diary: { enabled: true, maxCharsPerDay: 3000, maxRewritesPerDay: 8, ...diaryOverrides } },
    },
  };
}

const day = new Date(2026, 10, 8, 20, 30, 0);

function candidate(bvid, title) {
  return { bvid, title, owner: { name: 'UP' }, durationSec: 600 };
}

test('replaceSection：只替换目标那天，其它天与顺序不变', () => {
  const md = [
    '## 2026-11-07', '', '昨天的事。', '',
    '## 2026-11-08', '', '旧的一天。', '',
    '## 2026-11-09', '', '明天的事。', '',
  ].join('\n');
  const out = diaryFormat.replaceSection(md, day, '重写后的今天。');
  assert.equal(diaryFormat.digestOf(out, day), '重写后的今天。');
  assert.equal(diaryFormat.digestOf(out, new Date(2026, 10, 7)), '昨天的事。');
  assert.equal(diaryFormat.digestOf(out, new Date(2026, 10, 9)), '明天的事。');
  assert.equal(diaryFormat.countDays(out), 3);
});

test('replaceSection：不存在的一天会追加成新的一节', () => {
  const out = diaryFormat.replaceSection('## 2026-11-07\n\n昨天。\n', day, '今天。');
  assert.equal(diaryFormat.countDays(out), 2);
  assert.equal(diaryFormat.digestOf(out, day), '今天。');
});

test('writeRound：第一次写当天，只有一节', async () => {
  const { config, root } = tmpConfig();
  const out = await diary.writeRound({ config, llm: null, date: day, watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }] });
  assert.equal(out.rewritten, true);
  assert.ok(out.ownerChars > 0);
  const owner = fs.readFileSync(biliStore.paths(config).diaryOwner, 'utf8');
  assert.equal(diaryFormat.countDays(owner), 1);
  assert.match(owner, /猫猫/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeRound：有人设时，把语气基调注入写日记的提示词', async () => {
  const { config, root } = tmpConfig();
  config.persona = { personality: '温柔但有点小倔', stylePreset: '正常' };
  let seenSystem = '';
  const llm = { isMock: false, complete: async (opts) => { seenSystem = opts.system; return '{"owner":"今天看了猫。","self":"喜欢猫。"}'; } };
  const out = await diary.writeRound({ config, llm, date: day, watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }] });
  assert.equal(out.usedModel, true);
  assert.match(seenSystem, /温柔但有点小倔/);
  assert.match(seenSystem, /语气：正常/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeRound：同一天看了新视频 → 重写当天那一节（不是追加），两件事都在同一篇里', async () => {
  const { config, root } = tmpConfig();
  const first = await diary.writeRound({ config, llm: null, date: day, watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }] });
  const second = await diary.writeRound({ config, llm: null, date: day, watched: [{ candidate: candidate('BV2xx411c7mD', 'AI 实测'), digest: '' }] });
  assert.equal(second.rewritten, true);
  assert.ok(second.ownerChars > first.ownerChars, '重写后应包含当天全部内容');
  const owner = fs.readFileSync(biliStore.paths(config).diaryOwner, 'utf8');
  assert.equal(diaryFormat.countDays(owner), 1, '仍然只有一节');
  assert.match(owner, /猫猫/);
  assert.match(owner, /AI 实测/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeRound：没有新视频就不写（不白烧 token）', async () => {
  const { config, root } = tmpConfig();
  await diary.writeRound({ config, llm: null, date: day, watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }] });
  const again = await diary.writeRound({ config, llm: null, date: day, watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }] });
  assert.equal(again.rewritten, false);
  assert.equal(again.skipped, 'no_new_video');
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeRound：超过 maxRewritesPerDay 就不再重写', async () => {
  const { config, root } = tmpConfig({ maxRewritesPerDay: 1 });
  await diary.writeRound({ config, llm: null, date: day, watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }] });
  const out = await diary.writeRound({ config, llm: null, date: day, watched: [{ candidate: candidate('BV2xx411c7mD', 'AI'), digest: '' }] });
  assert.equal(out.rewritten, false);
  assert.equal(out.skipped, 'rewrite_cap');
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeRound：日记会带上当天聊天素材（且明确要求不要复述记录）', async () => {
  const { config, root } = tmpConfig();
  const seen = [];
  const llm = {
    isMock: false,
    complete: async ({ system, turns }) => {
      seen.push({ system, content: turns[0].content });
      return '{"owner":"今天看了猫，也和小明聊到加班，感觉大家都挺累的。","self":"我更喜欢有人味的内容。"}';
    },
  };
  const out = await diary.writeRound({
    config, llm, date: day,
    watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }],
    chatDigest: '【私聊】小明：今天加班到十点 / 我：辛苦了',
  });
  assert.equal(out.usedModel, true);
  assert.match(seen[0].content, /今天聊到的事/);
  assert.match(seen[0].content, /小明/);
  assert.match(seen[0].system, /聊天素材只当背景/);
  const owner = fs.readFileSync(biliStore.paths(config).diaryOwner, 'utf8');
  assert.match(owner, /小明/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeRound：没有模型时模板也会提一句聊天', async () => {
  const { config, root } = tmpConfig();
  const out = await diary.writeRound({
    config, llm: null, date: day,
    watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }],
    chatDigest: '【私聊】小明：今天加班',
  });
  assert.equal(out.rewritten, true);
  const owner = fs.readFileSync(biliStore.paths(config).diaryOwner, 'utf8');
  assert.match(owner, /聊了会儿/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeRound(chat)：没有新视频也能因为聊天重写当天', async () => {
  const { config, root } = tmpConfig({ chatMinGapMinutes: 0 });
  await diary.writeRound({ config, llm: null, date: day, watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }] });
  const seen = [];
  const llm = {
    isMock: false,
    complete: async ({ turns }) => { seen.push(turns[0].content); return '{"owner":"今天看了猫，也和小明聊到加班，感觉大家都挺累的。","self":"聊天比视频更有意思。"}'; },
  };
  const out = await diary.writeRound({
    config, llm, date: day, watched: [], chatDigest: '【私聊】小明：今天加班到十点', source: 'chat',
  });
  assert.equal(out.rewritten, true);
  assert.equal(out.source, 'chat');
  assert.match(seen[0], /没有新视频/);
  assert.match(seen[0], /小明/);
  const owner = fs.readFileSync(biliStore.paths(config).diaryOwner, 'utf8');
  assert.match(owner, /小明/);
  assert.equal(diaryFormat.countDays(owner), 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeRound(chat)：距上次更新太近时跳过（chatMinGapMinutes）', async () => {
  const { config, root } = tmpConfig({ chatMinGapMinutes: 90 });
  await diary.writeRound({ config, llm: null, date: day, watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }] });
  const out = await diary.writeRound({
    config, llm: null, date: day, watched: [], chatDigest: '【私聊】小明：今天加班', source: 'chat',
  });
  assert.equal(out.rewritten, false);
  assert.equal(out.skipped, 'chat_cooldown');
  // 手动执行（能力页「现在执行一次」）不受冷却限制
  const manual = await diary.writeRound({
    config, llm: null, date: day, watched: [], chatDigest: '【私聊】小明：今天加班', source: 'chat', manual: true,
  });
  assert.equal(manual.rewritten, true);
  assert.equal(manual.source, 'chat');
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeRound(chat)：手动执行可以突破每日重写上限', async () => {
  const { config, root } = tmpConfig({ maxRewritesPerDay: 1, chatMinGapMinutes: 0 });
  await diary.writeRound({ config, llm: null, date: day, watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }] });
  const blocked = await diary.writeRound({
    config, llm: null, date: day, watched: [], chatDigest: '【私聊】小明：今天加班', source: 'chat',
  });
  assert.equal(blocked.skipped, 'rewrite_cap');
  const manual = await diary.writeRound({
    config, llm: null, date: day, watched: [], chatDigest: '【私聊】小明：今天加班', source: 'chat', manual: true,
  });
  assert.equal(manual.rewritten, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scheduler：跑一轮时把当天聊天素材一起交给日记', async () => {
  const { createBiliScheduler } = require('../src/services/bili/scheduler');
  const { root } = tmpConfig();
  const now = new Date(2026, 10, 9, 21, 0, 0);
  const store = {
    sessions: new Map([['wechat:u:wxid_a', {}]]),
    messages: () => [{ role: 'user', name: '小明', text: '今天加班到十点', ts: now.getTime() }],
  };
  const config = {
    root,
    paths: { dataDir: path.join(root, 'data') },
    features: { bili: true },
    persona: { master: { wxids: [], names: ['主人'] } },
    bili: {
      night: { windows: [{ start: '00:00', end: '23:59', wakes: 1 }], skipChance: 0, maxVideos: 5, maxWakesPerDay: 1, maxMinutes: 45 },
      risk: { readHourly: 120, readDaily: 400 },
      share: { enabled: false, daily: 0, minGapMinutes: 0, chats: [] },
      diary: { enabled: true, maxCharsPerDay: 3000, maxRewritesPerDay: 8 },
    },
  };
  let captured = null;
  const sched = createBiliScheduler({
    config,
    runtime: { config, store },
    now: () => now,
    fetchFeed: async () => ({ source: 'rcmd', items: [{ bvid: 'BV1xx411c7mD', title: '猫猫', durationSec: 60, pubdate: 0, stat: { view: 1 } }] }),
    readMaterials: async () => ({ digest: '【B站视频】猫猫', info: null, replies: [] }),
    writeDiary: async (opts) => { captured = opts; return { ownerChars: 1, selfChars: 1, usedModel: false, rewritten: true }; },
  });
  const out = await sched.runRound({ dry: false, now });
  assert.equal(out.ok, true);
  assert.ok(captured, '应该调用写日记');
  assert.match(captured.chatDigest, /小明/);
  assert.match(captured.chatDigest, /今天加班到十点/);
});

test('writeRound：模型能看到「今天已经写过的内容」并重写', async () => {
  const { config, root } = tmpConfig();
  await diary.writeRound({ config, llm: null, date: day, watched: [{ candidate: candidate('BV1xx411c7mD', '猫猫'), digest: '' }] });
  const seen = [];
  const llm = {
    isMock: false,
    complete: async ({ system, turns }) => {
      seen.push({ system, content: turns[0].content });
      return '{"owner":"今天先看了猫猫，后来又看了 AI，猫猫更治愈。","self":"更喜欢猫，AI 得讲得接地气。"}';
    },
  };
  const out = await diary.writeRound({ config, llm, date: day, watched: [{ candidate: candidate('BV2xx411c7mD', 'AI 实测'), digest: '【B站视频】AI 实测' }] });
  assert.equal(out.usedModel, true);
  assert.match(seen[0].content, /今天已经写过的内容/);
  assert.match(seen[0].content, /猫猫/, '草稿里要有之前写的');
  assert.match(seen[0].system, /一整天的日记/);
  const owner = fs.readFileSync(biliStore.paths(config).diaryOwner, 'utf8');
  assert.match(owner, /更治愈/);
  assert.equal(diaryFormat.countDays(owner), 1);
  fs.rmSync(root, { recursive: true, force: true });
});

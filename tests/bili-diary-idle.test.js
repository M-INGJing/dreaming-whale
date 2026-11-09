'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiaryIdle } = require('../src/services/bili/diaryIdle');

function runtimeOf(diaryOverrides = {}) {
  return {
    config: {
      features: { bili: true },
      bili: { diary: { enabled: true, chatChance: 0.2, chatIdleSeconds: 60, chatMinGapMinutes: 0, ...diaryOverrides } },
    },
    llm: { isMock: false },
  };
}

const t0 = new Date(2026, 10, 9, 22, 0, 0);
const at = (sec) => new Date(t0.getTime() + sec * 1000);

test('noteActivity：按概率掷中才排队；没掷中不排队', () => {
  const runtime = runtimeOf({ chatChance: 0.2 });
  const idle = createDiaryIdle({ runtime, rng: () => 0.9, now: () => t0 });
  assert.equal(idle.noteActivity(t0), false);
  assert.equal(idle.pending(), '');

  const idle2 = createDiaryIdle({ runtime, rng: () => 0.1, now: () => t0 });
  assert.equal(idle2.noteActivity(t0), true);
  assert.equal(idle2.pending(), '2026-11-09');
  assert.equal(idle2.noteActivity(t0), true, '已经排队时不重复掷');
});

test('tick：还在聊天就不写；闲够 chatIdleSeconds 才写，且 source=chat', async () => {
  const runtime = runtimeOf({ chatChance: 1, chatIdleSeconds: 60 });
  const calls = [];
  const idle = createDiaryIdle({
    runtime,
    rng: () => 0,
    now: () => t0,
    digest: { collectDay: () => ({ text: '【私聊】小明：今天加班到十点' }) },
    writeDiary: async (opts) => { calls.push(opts); return { rewritten: true, ownerChars: 10, selfChars: 5 }; },
  });
  idle.noteActivity(t0);
  const busy = await idle.tick(at(30));
  assert.equal(busy.skipped, 'chat_active');
  assert.equal(calls.length, 0);

  const out = await idle.tick(at(61));
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, 'chat');
  assert.equal(calls[0].watched.length, 0);
  assert.match(calls[0].chatDigest, /小明/);
  assert.equal(idle.pending(), '', '写完清空待办');

  const again = await idle.tick(at(300));
  assert.equal(again.skipped, 'idle');
});

test('tick：没有聊天素材就放弃这次', async () => {
  const runtime = runtimeOf({ chatChance: 1, chatIdleSeconds: 0 });
  const idle = createDiaryIdle({
    runtime, rng: () => 0, now: () => t0,
    digest: { collectDay: () => ({ text: '' }) },
    writeDiary: async () => ({ rewritten: true }),
  });
  idle.noteActivity(t0);
  const out = await idle.tick(at(1));
  assert.equal(out.skipped, 'no_chat');
  assert.equal(idle.pending(), '');
});

test('开关关掉后不再排队，已排队的 tick 也会放弃', async () => {
  const runtime = runtimeOf({ chatChance: 1 });
  const idle = createDiaryIdle({ runtime, rng: () => 0, now: () => t0, digest: { collectDay: () => ({ text: 'x' }) }, writeDiary: async () => ({ rewritten: true }) });
  idle.noteActivity(t0);
  runtime.config.features.bili = false;
  assert.equal(idle.noteActivity(t0), false);
  const out = await idle.tick(at(120));
  assert.equal(out.skipped, 'disabled');
});

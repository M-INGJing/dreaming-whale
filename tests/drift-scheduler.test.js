'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDriftScheduler, DEFAULT_RUN_MS } = require('../src/services/driftScheduler');

function make(opts = {}) {
  const calls = [];
  const analyze = opts.analyze || ((cfg, o) => {
    calls.push({ cfg, o });
    return { days: [{ date: '2026-11-10', count: 3 }], hint: '' };
  });
  let now = 1000000;
  const scheduler = createDriftScheduler({
    config: opts.config || { paths: { dataDir: '/tmp/drift' } },
    now: opts.now || (() => now),
    analyze,
    days: opts.days,
    runMs: opts.runMs,
    checkMs: opts.checkMs,
  });
  return { scheduler, calls, setNow: (n) => { now = n; } };
}

test('到点（首次）就跑一次，并传 days 与 now', () => {
  const { scheduler, calls } = make({ days: 14 });
  const out = scheduler.tick();
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].o.days, 14);
  assert.equal(calls[0].o.now, 1000000);
  assert.equal(scheduler.lastRunAt(), 1000000);
});

test('间隔没到就不重复跑', () => {
  const { scheduler, calls, setNow } = make({ runMs: 86400000 });
  scheduler.tick();
  setNow(1000000 + 3600000); // 才过 1 小时
  const out = scheduler.tick();
  assert.equal(out.reason, 'not_due');
  assert.equal(calls.length, 1, '没到一天不重跑');
  setNow(1000000 + 86400000); // 满一天
  assert.equal(scheduler.tick().ok, true);
  assert.equal(calls.length, 2);
});

test('关掉 features.drift 整轮跳过', () => {
  const { scheduler, calls } = make({ config: { paths: { dataDir: '/tmp/drift' }, features: { drift: false } } });
  const out = scheduler.tick();
  assert.equal(out.reason, 'disabled');
  assert.equal(calls.length, 0);
});

test('analyze 抛错不往外冒，返回 error 且可继续', () => {
  let n = 0;
  const analyze = () => { n += 1; if (n === 1) throw new Error('boom'); return { days: [], hint: '' }; };
  const { scheduler } = make({ analyze });
  assert.equal(scheduler.tick().reason, 'error');
  assert.equal(scheduler.tick().ok, true, '出错后下一轮仍可跑');
});

test('默认间隔是每天一次', () => {
  const { scheduler } = make();
  assert.equal(typeof scheduler.start, 'function');
  assert.equal(typeof scheduler.stop, 'function');
  assert.ok(DEFAULT_RUN_MS === 24 * 60 * 60 * 1000);
});

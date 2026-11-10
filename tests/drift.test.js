'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const drift = require('../src/services/drift');

test('metrics：空回复返回 null，非空算出五项指标', () => {
  assert.equal(drift.metrics([]), null);
  assert.equal(drift.metrics([{ text: '' }]), null);
  const m = drift.metrics([
    { text: '在，咋啦' },
    { text: '那先歇会儿呗 😂' },
    { text: '行吧行吧' },
  ]);
  assert.equal(m.count, 3);
  assert.equal(typeof m.p50, 'number');
  assert.ok(m.emojiRate > 0, '有一条带 emoji');
  assert.equal(typeof m.questionRate, 'number');
  assert.equal(m.aiRate, 0);
});

test('metrics：AI 味词命中会被算进 aiRate', () => {
  const m = drift.metrics([{ text: '首先，这个问题很有意思' }, { text: '哦' }]);
  assert.equal(m.aiRate, 0.5);
});

test('hint：健康返回空串，超区间给提示', () => {
  assert.equal(drift.hint(null), '');
  assert.equal(drift.hint({ count: 10, p50: 15, emojiRate: 0.2, questionRate: 0.2, aiRate: 0, maxSim: 0.2 }), '');
  // 说话变长
  assert.match(drift.hint({ count: 10, p50: 50, emojiRate: 0.2, questionRate: 0.2, aiRate: 0, maxSim: 0.2 }), /说话变长/);
  // AI 味
  assert.match(drift.hint({ count: 10, p50: 15, emojiRate: 0.2, questionRate: 0.2, aiRate: 0.05, maxSim: 0.2 }), /AI 味/);
  // 复读
  assert.match(drift.hint({ count: 10, p50: 15, emojiRate: 0.2, questionRate: 0.2, aiRate: 0, maxSim: 0.8 }), /复读/);
  // 样本太少不判长度/emoji
  assert.equal(drift.hint({ count: 2, p50: 60, emojiRate: 0, questionRate: 0.5, aiRate: 0, maxSim: 0.1 }), '');
});

test('readRecent：只取 assistant、按天分组、跨天不混', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-'));
  const config = { paths: { dataDir: path.join(root, 'data') } };
  const chatDir = path.join(config.paths.dataDir, 'memory', 'chats', 'abc');
  fs.mkdirSync(chatDir, { recursive: true });
  const t0 = new Date(2026, 10, 9, 12, 0, 0).getTime();
  const t1 = new Date(2026, 10, 8, 12, 0, 0).getTime(); // 昨天
  const tOld = t1 - 10 * 86400000; // 十天前
  fs.writeFileSync(path.join(chatDir, 'messages.jsonl'), [
    JSON.stringify({ role: 'assistant', text: '今天的话', ts: t0, seq: 1 }),
    JSON.stringify({ role: 'user', text: '用户的话不该算', ts: t0, seq: 2 }),
    JSON.stringify({ role: 'assistant', text: '昨天的话', ts: t1, seq: 3 }),
    JSON.stringify({ role: 'assistant', text: '太旧了', ts: tOld, seq: 4 }),
  ].join('\n') + '\n');

  const byDay = drift.readRecent(config, { days: 7, now: t0 });
  const keys = [...byDay.keys()];
  assert.ok(keys.includes('2026-11-09'), '今天有数据');
  assert.ok(keys.includes('2026-11-08'), '昨天有数据');
  assert.ok(!keys.some((k) => k === '2026-10-30'), '十天前的不进 7 天窗口');
  assert.equal(byDay.get('2026-11-09').length, 1, '用户的话不计入');
  fs.rmSync(root, { recursive: true, force: true });
});

test('analyze + status：写报告、超区间返回提示', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift2-'));
  const config = { paths: { dataDir: path.join(root, 'data') } };
  const chatDir = path.join(config.paths.dataDir, 'memory', 'chats', 'abc');
  fs.mkdirSync(chatDir, { recursive: true });
  const t0 = new Date(2026, 10, 9, 12, 0, 0).getTime();
  // 一条超长 + 一条 AI 味，制造提示
  fs.writeFileSync(path.join(chatDir, 'messages.jsonl'), [
    JSON.stringify({ role: 'assistant', text: '首先，这是一句特别特别特别特别特别特别特别特别特别特别特别特别特别长的话', ts: t0, seq: 1 }),
    JSON.stringify({ role: 'assistant', text: '首先，其次呢', ts: t0 + 1000, seq: 2 }),
  ].join('\n') + '\n');

  const report = drift.analyze(config, { days: 7, now: t0 });
  assert.ok(report.days.length >= 1);
  assert.ok(report.hint.length > 0, '超长 + AI 味应该给提示');
  assert.equal(drift.status(config), report.hint);
  fs.rmSync(root, { recursive: true, force: true });
});

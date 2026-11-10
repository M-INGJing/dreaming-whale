'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const selfCard = require('../src/memory/selfCard');

function tmpConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'self-card-'));
  return { config: { paths: { dataDir: path.join(root, 'data') } }, root };
}

test('load：文件不存在时返回空卡，不抛', () => {
  const { config, root } = tmpConfig();
  const card = selfCard.load(config);
  assert.deepEqual(card, selfCard.empty());
  fs.rmSync(root, { recursive: true, force: true });
});

test('applyWeekly：likes/dislikes/state/summary 都写进卡，且落盘可再读', () => {
  const { config, root } = tmpConfig();
  const ok = selfCard.applyWeekly(config, {
    likes: ['猫', '慢歌'], dislikes: ['吵架'], state: '这周有点累', summary: '这周看了不少猫，也聊了加班。', weekStart: '2026-11-08', now: 1700000000000,
  });
  assert.equal(ok, true);
  const card = selfCard.load(config);
  assert.deepEqual(card.preferences.map((p) => p.text).sort(), ['猫', '慢歌', '吵架'].sort());
  assert.ok(card.preferences.every((p) => p.confidence === 0.7));
  assert.ok(card.preferences.some((p) => p.kind === 'like' && p.text === '猫'));
  assert.ok(card.preferences.some((p) => p.kind === 'dislike' && p.text === '吵架'));
  assert.equal(card.state, '这周有点累');
  assert.equal(card.events.length, 1);
  assert.match(card.events[0].summary, /这周看了不少猫/);
  assert.equal(card.updatedAt, 1700000000000);
  fs.rmSync(root, { recursive: true, force: true });
});

test('applyWeekly：同一 weekStart 重复写，summary 覆盖不追加，preferences 去重', () => {
  const { config, root } = tmpConfig();
  selfCard.applyWeekly(config, { likes: ['猫'], summary: '第一次写。', weekStart: '2026-11-08', now: 1000 });
  selfCard.applyWeekly(config, { likes: ['猫', '狗'], summary: '第二次写。', weekStart: '2026-11-08', now: 2000 });
  const card = selfCard.load(config);
  assert.equal(card.events.length, 1, '同一周小结只保留一条事件');
  assert.match(card.events[0].summary, /第二次写/);
  assert.deepEqual(card.preferences.map((p) => p.text).sort(), ['猫', '狗'].sort(), '猫 只保留一条');
  fs.rmSync(root, { recursive: true, force: true });
});

test('upsert：超过上限按 updatedAt 最旧先丢', () => {
  const list = [];
  for (let i = 0; i < selfCard.MAX_PREFS + 5; i += 1) {
    selfCard.upsert(list, { text: '偏好' + i, confidence: 0.5, updatedAt: i });
  }
  assert.equal(list.length, selfCard.MAX_PREFS);
  assert.equal(list[0].text, '偏好5', '最旧的 0~4 被挤掉');
  assert.equal(list[list.length - 1].text, '偏好' + (selfCard.MAX_PREFS + 4));
});

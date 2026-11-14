'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lottery = require('../src/core/lottery');

test('rollDice：注入固定 rng，范围 1-6，边界正确', () => {
  assert.equal(lottery.rollDice(() => 0), 1, 'rng=0 → 1');
  assert.equal(lottery.rollDice(() => 0.999999), 6, 'rng≈1 → 6');
  assert.equal(lottery.rollDice(() => 0.5), 4, 'rng=0.5 → 4');
});

test('drawLots：返回完整签文（等级 + 签 + 解），且来自内置签库', () => {
  const lot = lottery.drawLots(() => 0);
  assert.ok(lot.level && lot.text && lot.note);
  assert.ok(lottery.LOTS.includes(lot), '抽出的必须是内置签库里的原条目');
  assert.ok(['上上', '上吉', '中吉', '中平', '中下', '下'].includes(lot.level));
});

test('drawTarot：22 张大阿卡纳，正/逆位牌意都在', () => {
  assert.equal(lottery.TAROT.length, 22);
  for (const c of lottery.TAROT) {
    assert.ok(c.name && c.upright && c.reversed, c.name + ' 牌意不全');
  }
  const t = lottery.drawTarot(() => 0.5);
  // rng 被调用两次：第一次 0.5*22=11 → 第 12 张「正义」；第二次 0.5<0.5=false → 正位
  assert.equal(t.name, '正义');
  assert.equal(t.isReversed, false);
  assert.equal(t.upright, '公平的结果，因果分明');
});

test('drawTarot：rng 第一个值决定抽哪张，第二个决定正逆位', () => {
  const t = lottery.drawTarot(() => 0.1); // 0.1 在多次调用中始终 < 0.5，但第一个 0.1*22=2.2 → 女祭司
  assert.equal(t.name, '女祭司');
  assert.equal(t.isReversed, true);
});

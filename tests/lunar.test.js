'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lunar = require('../src/core/lunar');

// 用几个公认的春节日期锚点校准算法（这些是固定、不会变的事实）。
test('solarToLunar：春节锚点换算正确', () => {
  for (const [y, m, d, expectYear, expectMonth, expectDay, zodiac] of [
    [2000, 2, 5, 2000, 1, 1, '龙'],   // 2000 春节
    [2024, 2, 10, 2024, 1, 1, '龙'],  // 2024 春节（甲辰龙年）
    [2026, 2, 17, 2026, 1, 1, '马'],  // 2026 春节（丙午马年）
  ]) {
    const lu = lunar.solarToLunar(y, m, d);
    assert.equal(lu.year, expectYear, `${y}-${m}-${d} 农历年`);
    assert.equal(lu.month, expectMonth, `${y}-${m}-${d} 农历月`);
    assert.equal(lu.day, expectDay, `${y}-${m}-${d} 农历日`);
    assert.equal(lu.zodiac, zodiac, `${y}-${m}-${d} 生肖`);
    assert.equal(lu.text, '正月初一');
    assert.equal(lu.isLeap, false);
  }
});

test('zodiacOf：按农历年换属相，春节前算上一年', () => {
  assert.equal(lunar.zodiacOf(2026, 2, 17), '马'); // 春节当天已经是马年
  assert.equal(lunar.zodiacOf(2026, 2, 16), '蛇'); // 春节前一天还是蛇年（乙巳）
  assert.equal(lunar.zodiacOf(2024, 2, 10), '龙');
});

test('春节后一天是正月初二', () => {
  const lu = lunar.solarToLunar(2026, 2, 18);
  assert.equal(lu.text, '正月初二');
  assert.equal(lu.month, 1);
  assert.equal(lu.day, 2);
});

test('nextSpringFestival / nextMidAutumn：能找到下一个节日', () => {
  const spring = lunar.nextSpringFestival(new Date(2026, 6, 1)); // 2026-07-01 之后
  assert.ok(spring instanceof Date && !Number.isNaN(spring.getTime()));
  assert.equal(spring.getFullYear(), 2027, '2026 年 7 月之后的下一个春节在 2027 年');
  const lu = lunar.solarToLunar(spring.getFullYear(), spring.getMonth() + 1, spring.getDate());
  assert.equal(lu.text, '正月初一');

  const mid = lunar.nextMidAutumn(new Date(2026, 1, 1)); // 2026-02-01 之后
  assert.ok(mid instanceof Date);
  const lm = lunar.solarToLunar(mid.getFullYear(), mid.getMonth() + 1, mid.getDate());
  assert.equal(lm.text, '八月十五');
});

test('solarTerm：2024 年冬至在 12 月 21 日，2024 年夏至在 6 月 21 日', () => {
  assert.equal(lunar.solarTerm(2024, 12, 21), '冬至');
  assert.equal(lunar.solarTerm(2024, 6, 21), '夏至');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { trimToBudget } = require('../src/core/summarize');

test('trimToBudget：短正文原样返回，不标记截断', () => {
  const out = trimToBudget('这是一段很短的正文。', { maxChars: 100 });
  assert.equal(out.text, '这是一段很短的正文。');
  assert.equal(out.truncated, false);
});

test('trimToBudget：长正文整句截断，不切半句', () => {
  const s = '第一句话讲猫。第二句话讲狗。第三句话讲鱼。第四句话讲鸟。';
  const out = trimToBudget(s, { maxChars: 8 });
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 8, '不超预算');
  assert.ok(/[。！？；]$/.test(out.text.trim()), '结尾停在句末标点，不切半句');
});

test('trimToBudget：句末标点太远时退回硬裁（不丢太多正文）', () => {
  const s = '这是一句特别特别长的话没有标点一直说下去'.repeat(10);
  const out = trimToBudget(s, { maxChars: 30 });
  assert.equal(out.truncated, true);
  assert.ok(Array.from(out.text).length <= 30);
});

test('trimToBudget：emoji 不切出半个字符', () => {
  const s = ('😀鲸鱼🐳'.repeat(50)) + '。结尾';
  const out = trimToBudget(s, { maxChars: 20 });
  assert.equal(Array.from(out.text).join(''), out.text, '代理对不被切开');
});

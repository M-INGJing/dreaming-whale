'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { score, readCases } = require('./persona-eval/run.js');

test('金标评测集：cases.jsonl 全部可解析且字段齐全', () => {
  const cases = readCases();
  assert.ok(cases.length >= 40, `场景数应 ≥40，实际 ${cases.length}`);
  for (const c of cases) {
    assert.ok(c.id && c.scene && c.input, `${c.id || '?'} 缺 id/scene/input`);
    assert.ok(c.chatType === 'group' || c.chatType === 'private', `${c.id} 的 chatType 非法`);
    assert.ok(c.expect, `${c.id} 缺 expect`);
    assert.ok(typeof c.expect.maxChars === 'number' || c.expect.maxChars === undefined, `${c.id} 的 maxChars 应为数字`);
  }
});

test('金标评测集：评分器抓 AI 味、Markdown、超长、复读', () => {
  // 干净回复：不报任何错
  assert.deepEqual(score('在，咋啦', { expect: { maxChars: 40 } }), []);
  // AI 味词
  assert.ok(score('首先，这个问题很有意思', { expect: { maxChars: 40 } }).some((f) => f.includes('AI 味')));
  // Markdown / 列表
  assert.ok(score('**你好**', { expect: { maxChars: 40 } }).some((f) => f.includes('Markdown')));
  assert.ok(score('1. 第一点', { expect: { maxChars: 40 } }).some((f) => f.includes('Markdown')));
  // 超长
  assert.ok(score('这是一句很长很长很长很长很长很长很长很长的话', { expect: { maxChars: 10 } }).some((f) => f.includes('超长')));
  // 命中禁用词
  assert.ok(score('别生气，冷静一下', { expect: { maxChars: 40, forbid: ['别生气'] } }).some((f) => f.includes('别生气')));
  // 复读上一条
  assert.ok(score('今天天气不错', { expect: { maxChars: 40 }, history: ['今天天气不错'] }).some((f) => f.includes('复读')));
});

test('金标评测集：requireOneOf 缺失时判失败', () => {
  assert.ok(score('哦', { expect: { maxChars: 40, requireOneOf: ['怼', '骂'] } }).some((f) => f.includes('缺少要求语气')));
  assert.deepEqual(score('你才垃圾', { expect: { maxChars: 40, requireOneOf: ['垃圾'] } }), []);
});

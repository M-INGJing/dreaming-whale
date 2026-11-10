'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fewShot = require('../src/persona/fewShot');

function tmpData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fewshot-'));
  return { root, dataDir: path.join(root, 'data') };
}

test('isCorrection：识别纠正语，不误伤正常对话', () => {
  assert.equal(fewShot.isCorrection('别说这个'), true);
  assert.equal(fewShot.isCorrection('重说一遍'), true);
  assert.equal(fewShot.isCorrection('换个说法'), true);
  assert.equal(fewShot.isCorrection('好好说'), true);
  assert.equal(fewShot.isCorrection('今天吃了吗'), false);
  assert.equal(fewShot.isCorrection('不对啊'), false, '「不对」太常见，不当纠正语');
});

test('goodUser / goodAssistant：质量门槛', () => {
  assert.equal(fewShot.goodUser('在吗'), true);
  assert.equal(fewShot.goodUser(''), false);
  assert.equal(fewShot.goodUser('😂😂'), false, '纯表情不算提问');
  assert.equal(fewShot.goodAssistant('在，咋啦'), true);
  assert.equal(fewShot.goodAssistant('哦'), false, '太短没示范意义');
  assert.equal(fewShot.goodAssistant('首先，这个问题很有意思'), false, 'AI 味');
  assert.equal(fewShot.goodAssistant('回复带 [[sticker:开心]]'), false, '能力/表情包标记');
  assert.equal(fewShot.goodAssistant('编号 20261110223344 已登记'), false, '10 位以上连续数字');
});

test('pickPairs：只抽没被纠正、质量合格的对', () => {
  const msgs = [
    { role: 'user', text: '在吗', ts: 1 },
    { role: 'assistant', text: '在，咋啦', ts: 2 },
    { role: 'user', text: '今天上班被老板骂了', ts: 3 },
    { role: 'assistant', text: '啊…骂你啥了', ts: 4 },
    { role: 'user', text: '别说这个', ts: 5 }, // 纠正上一条
    { role: 'user', text: '你累不累', ts: 6 },
    { role: 'assistant', text: '我还行，你照顾好自己', ts: 7 },
    { role: 'user', text: '随便说点', ts: 8 },
    { role: 'assistant', text: '首先，这个问题很有意思', ts: 9 }, // AI 味，排除
  ];
  const pairs = fewShot.pickPairs(msgs, { maxPairs: 10 });
  const users = pairs.map((p) => p.user);
  assert.ok(users.includes('在吗'));
  assert.ok(users.includes('你累不累'));
  assert.ok(!users.includes('今天上班被老板骂了'), '紧跟纠正语的那对要排除');
  assert.ok(!users.includes('随便说点'), 'AI 味的回复要排除');
});

test('collect + sample：从磁盘抽、抽不到回退 null、按 dataDir 缓存', () => {
  const { root, dataDir } = tmpData();
  const chatDir = path.join(dataDir, 'memory', 'chats', 'abc');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, 'messages.jsonl'), [
    JSON.stringify({ role: 'user', text: '在吗', ts: 1 }),
    JSON.stringify({ role: 'assistant', text: '在，咋啦', ts: 2 }),
    JSON.stringify({ role: 'user', text: '今天累不累', ts: 3 }),
    JSON.stringify({ role: 'assistant', text: '有点，你也早点歇', ts: 4 }),
  ].join('\n') + '\n');

  const config = { paths: { dataDir } };
  const lines = fewShot.sample(config, { maxPairs: 2 });
  assert.ok(Array.isArray(lines), '有合格对话应返回示例行');
  assert.equal(lines[0], '【说话示例（只学语气，别照抄）】');
  assert.match(lines.join('\n'), /对方：在吗/);
  assert.match(lines.join('\n'), /你：在，咋啦/);

  // 缓存命中：清掉文件后同 key 仍返回缓存，直到 reset
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.ok(fewShot.sample(config, { maxPairs: 2 }), '缓存命中，不因文件删除而变空');
  fewShot.reset();
  assert.equal(fewShot.sample(config, { maxPairs: 2 }), null, 'reset 后重读，抽不到回退 null');

  fs.rmSync(root, { recursive: true, force: true });
  fewShot.reset();
});

test('sample：没有 dataDir 或没有合格对话时返回 null', () => {
  fewShot.reset();
  assert.equal(fewShot.sample({ paths: {} }), null);
  const { root, dataDir } = tmpData();
  assert.equal(fewShot.sample({ paths: { dataDir } }, { maxPairs: 1 }), null, '空目录抽不到');
  fs.rmSync(root, { recursive: true, force: true });
  fewShot.reset();
});

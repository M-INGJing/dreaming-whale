'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const persona = require('../src/persona');
const { applyPersonaPatch } = require('../src/services/persona');

test('clipToLimit：没超就原样；超了在标点处截断', () => {
  assert.equal(persona.clipToLimit('在的在的', 10), '在的在的');
  assert.equal(persona.clipToLimit('今天天气不错，我们出去走走吧', 10), '今天天气不错');
  const clipped = persona.clipToLimit('嗯嗯我知道啦那今天先这样吧', 8);
  assert.ok(clipped.length <= 8);
  assert.ok('嗯嗯我知道啦那今天先这样吧'.startsWith(clipped));
  assert.equal(persona.clipToLimit('没有标点的一长串文字超过十个字了', 10).length, 10);
});

test('clipToLimit：limit 很小时也能安全截断', () => {
  assert.equal(persona.clipToLimit('你好呀今天怎么样', 4), '你好呀今');
  assert.equal(persona.clipToLimit('', 10), '');
});

test('applyPersonaPatch：私聊/群聊字数上限可以设到 10（以前被夹到 40/20）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-limit-'));
  const config = {
    root,
    paths: { dataDir: path.join(root, 'data') },
    persona: { name: '鲸鲸' },
    chat: { privateMaxChars: 100, groupMaxChars: 70 },
    links: { enabled: true },
    group: {},
  };
  const runtime = {
    config,
    logger: { info() {}, warn() {} },
    llm: { provider: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-chat', isMock: true, reload() {} },
  };
  const out = await applyPersonaPatch(runtime, { privateMaxChars: 10, groupMaxChars: 10 });
  assert.equal(out.ok, true);
  assert.equal(runtime.config.chat.privateMaxChars, 10);
  assert.equal(runtime.config.chat.groupMaxChars, 10);

  const low = await applyPersonaPatch(runtime, { privateMaxChars: 1, groupMaxChars: 1 });
  assert.equal(low.ok, true);
  assert.equal(runtime.config.chat.privateMaxChars, 4, '下限是 4 字');
  assert.equal(runtime.config.chat.groupMaxChars, 4);
  fs.rmSync(root, { recursive: true, force: true });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPersonaPatch } = require('../src/services/persona');

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

'use strict';

/**
 * 语音消息：配置要存在，桥接要真的把语音转成文字再交给服务端。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_CONFIG } = require('../src/infra/config');

const root = path.resolve(__dirname, '..');
const bridge = require('./helpers/bridge-source');

test('默认配置里有 voice，并且默认开启', () => {
  assert.ok(DEFAULT_CONFIG.voice, '缺少 voice 配置块');
  assert.equal(DEFAULT_CONFIG.voice.enabled, true);
  assert.match(DEFAULT_CONFIG.voice.model, /asr/i);
  assert.match(DEFAULT_CONFIG.voice.baseUrl, /^https:\/\//);
  assert.ok(Number(DEFAULT_CONFIG.voice.maxSeconds) >= 30);
});

test('桥接遇到语音不再直接丢掉，而是先转文字', () => {
  assert.doesNotMatch(bridge, /已移除语音功能/);
  assert.match(bridge, /def transcribe_voice/);
  const voiceSrc = fs.readFileSync(path.join(root, 'bridge', 'voice.py'), 'utf8');
  assert.match(voiceSrc, /def asr_transcribe/);
  assert.match(bridge, /download_voice/);
  assert.match(bridge, /pysilk\.decode/);
  assert.match(bridge, /对方发了一条语音，说的是/);
});

test('语音识别有长度和开关保护，失败不影响其它消息', () => {
  assert.match(bridge, /VOICE_MAX_SECONDS/);
  assert.match(bridge, /VOICE_ENABLED/);
  assert.match(bridge, /语音没识别出内容，先不说话/);
  assert.match(bridge, /语音识别失败/);
});

test('人设允许回应语音，不再说「不处理语音」', () => {
  // 语音能力是通道级事实，现在住在共享块 src/persona/index.js（不再塞进每个模板的 customPrompt）
  const personaSrc = fs.readFileSync(path.join(root, 'src', 'persona', 'index.js'), 'utf8');
  assert.doesNotMatch(personaSrc, /不处理语音/);
  assert.match(personaSrc, /别人发的语音会自动转成文字/);
});

test('自检脚本存在，能独立验证整条链路', () => {
  const p = path.join(root, 'scripts', 'voice-selftest.py');
  assert.ok(fs.existsSync(p), '缺少 scripts\\voice-selftest.py');
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /asr_transcribe/);
  assert.match(src, /download_voice/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/infra/config');

function configWith(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-sanitize-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(body, null, 2));
  return { root, cfg: loadConfig({ root }) };
}

test('sanitize：被写成 "[object Object]" 的窗口/群白名单会被丢掉，不会静默失效', () => {
  const { root, cfg } = configWith({
    bili: {
      night: { windows: ['[object Object]'] },
      share: { chats: ['[object Object]'] },
    },
  });
  assert.deepEqual(cfg.bili.night.windows, []);
  assert.deepEqual(cfg.bili.share.chats, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sanitize：字符串形式的 JSON 会被还原成对象（旧版本/手滑的配置能救回来）', () => {
  const { root, cfg } = configWith({
    bili: {
      night: { windows: ['{"start":"20:00","end":"24:00","wakes":1}'] },
      share: { chats: ['{"chatId":"example-group@chatroom","name":"某个群","daily":2}'] },
    },
  });
  assert.deepEqual(cfg.bili.night.windows, [{ start: '20:00', end: '24:00', wakes: 1 }]);
  assert.deepEqual(cfg.bili.share.chats, [{ chatId: 'example-group@chatroom', name: '某个群', daily: 2 }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sanitize：正常对象数组原样保留；缺字段的行被过滤', () => {
  const { root, cfg } = configWith({
    bili: {
      night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }, { start: '', end: '24:00' }] },
      share: { chats: [{ chatId: 'example-group@chatroom', name: '群', daily: 1 }, { name: '没有 id' }] },
    },
  });
  assert.equal(cfg.bili.night.windows.length, 1);
  assert.equal(cfg.bili.share.chats.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('默认值已翻倍：每日日记 3000 字 / 4 段、注入 400 token、每天醒 2 次', () => {
  const { root, cfg } = configWith({});
  assert.equal(cfg.bili.diary.maxCharsPerDay, 3000);
  assert.equal(cfg.bili.diary.maxEntriesPerDay, 4);
  assert.equal(cfg.bili.diary.digestTokens, 400);
  assert.equal(cfg.bili.night.maxWakesPerDay, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

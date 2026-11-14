'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const todo = require('../src/services/todoService');

function tmpConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-'));
  return { root, config: { paths: { dataDir: path.join(root, 'data') } } };
}

test('add / pending：加进待办、按会话隔离、只列未完成', () => {
  const { config, root } = tmpConfig();
  const a = todo.add(config, { chatId: 'u1', text: '交房租' });
  assert.equal(a.ok, true);
  assert.equal(a.item.done, false);
  todo.add(config, { chatId: 'u1', text: '买猫粮' });
  todo.add(config, { chatId: 'u2', text: '另一个会话的待办' });

  const pending = todo.pending(config, 'u1');
  assert.deepEqual(pending.map((x) => x.text), ['交房租', '买猫粮']);
  assert.equal(todo.pending(config, 'u2').length, 1, '会话隔离');
  fs.rmSync(root, { recursive: true, force: true });
});

test('complete：按序号勾掉第 N 条，已完成的不再列', () => {
  const { config, root } = tmpConfig();
  todo.add(config, { chatId: 'u1', text: 'A' });
  todo.add(config, { chatId: 'u1', text: 'B' });
  todo.add(config, { chatId: 'u1', text: 'C' });

  const done = todo.complete(config, 'u1', 2); // 勾掉 B
  assert.equal(done.ok, true);
  assert.equal(done.text, 'B');
  assert.deepEqual(todo.pending(config, 'u1').map((x) => x.text), ['A', 'C']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('remove：删掉第 N 条', () => {
  const { config, root } = tmpConfig();
  todo.add(config, { chatId: 'u1', text: 'A' });
  todo.add(config, { chatId: 'u1', text: 'B' });
  const removed = todo.remove(config, 'u1', 1);
  assert.equal(removed.ok, true);
  assert.equal(removed.text, 'A');
  assert.deepEqual(todo.pending(config, 'u1').map((x) => x.text), ['B']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('越界序号 / 空内容：安全返回失败，不崩', () => {
  const { config, root } = tmpConfig();
  todo.add(config, { chatId: 'u1', text: '只有一条' });
  assert.equal(todo.complete(config, 'u1', 9).ok, false);
  assert.equal(todo.remove(config, 'u1', 0).ok, false);
  assert.equal(todo.add(config, { chatId: 'u1', text: '   ' }).ok, false, '空内容不入列');
  fs.rmSync(root, { recursive: true, force: true });
});

test('持久化：写盘后能再读回', () => {
  const { config, root } = tmpConfig();
  todo.add(config, { chatId: 'u1', text: '周末剪头发' });
  assert.equal(todo.pending(config, 'u1')[0].text, '周末剪头发', '落盘后重新读回');
  assert.ok(fs.existsSync(path.join(config.paths.dataDir, 'todo.json')));
  fs.rmSync(root, { recursive: true, force: true });
});

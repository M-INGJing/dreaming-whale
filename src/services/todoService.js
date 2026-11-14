'use strict';

/**
 * 待办清单：无固定时间的备忘（「帮我记着周三交房租」里的「记着」）。
 * 和提醒分开：提醒 = 到点触发的一次性事件；待办 = 一个可持续勾掉的清单。
 * 只做存储和增删改查，不碰聊天回复，方便单测。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_ITEMS = 200;
const MAX_TEXT = 200;

function todoFile(config) {
  const dir = (config && config.paths && config.paths.dataDir) || path.join(process.cwd(), 'data');
  return path.join(dir, 'todo.json');
}

function readTodos(config) {
  try {
    const raw = JSON.parse(fs.readFileSync(todoFile(config), 'utf8'));
    return Array.isArray(raw && raw.items) ? raw.items : [];
  } catch {
    return [];
  }
}

function writeTodos(config, items) {
  const file = todoFile(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ items: items.slice(-MAX_ITEMS) }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function add(config, { chatId, chatType = 'private', text }) {
  const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!body) return { ok: false, reason: 'empty' };
  const items = readTodos(config);
  items.push({
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    chatId: String(chatId || ''),
    chatType,
    text: body,
    done: false,
    createdAt: Date.now(),
    finishedAt: 0,
  });
  writeTodos(config, items);
  return { ok: true, item: items[items.length - 1] };
}

/** 某会话里还没完成的待办（带序号）。 */
function pending(config, chatId) {
  return readTodos(config)
    .filter((it) => it && it.chatId === String(chatId || '') && !it.done)
    .slice(-50);
}

/** 完成第 index 条（从 1 起，按当前未完成列表的顺序）。 */
function complete(config, chatId, index) {
  const list = pending(config, chatId);
  const target = list[index - 1];
  if (!target) return { ok: false, reason: 'not_found' };
  const items = readTodos(config);
  const hit = items.find((it) => it.id === target.id);
  if (hit) { hit.done = true; hit.finishedAt = Date.now(); }
  writeTodos(config, items);
  return { ok: true, text: target.text };
}

/** 删掉第 index 条（从 1 起）。 */
function remove(config, chatId, index) {
  const list = pending(config, chatId);
  const target = list[index - 1];
  if (!target) return { ok: false, reason: 'not_found' };
  const items = readTodos(config).filter((it) => it.id !== target.id);
  writeTodos(config, items);
  return { ok: true, text: target.text };
}

module.exports = { todoFile, readTodos, writeTodos, add, pending, complete, remove, MAX_ITEMS, MAX_TEXT };

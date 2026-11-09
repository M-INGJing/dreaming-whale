'use strict';

/**
 * 鲸鲸的「能力清单」：让她知道自己会逛 B 站、写日记，并且能在聊天里自己决定要不要做。
 *
 * 协议（和表情包的 [[sticker:分类]] 同一套路，模型只需写一行标记）：
 *   回复末尾写 `[[cap:bili.watch]]` → 内核收到后异步执行，回复照常先发出去。
 *
 * 扩展新能力：往 REGISTRY 里加一条 {id,label,desc,enabled,run} 即可；
 * 提示词里的能力和标记会自动跟着变，不需要改聊天管线。
 */

const fs = require('node:fs');
const path = require('node:path');
const features = require('../infra/features');

const MARK_RE = /\[\[cap:([a-z0-9_.-]+)\]\]/gi;
const DEFAULT_MAX_PER_DAY = 5;
const MAX_ACTIONS = 200;

function capsConfig(config) {
  return (config && config.capabilities) || {};
}

function actionsFile(config) {
  const dir = (config && config.paths && config.paths.dataDir) || path.join(process.cwd(), 'data');
  return path.join(dir, 'caps', 'actions.json');
}

function readActions(config) {
  try {
    const raw = JSON.parse(fs.readFileSync(actionsFile(config), 'utf8'));
    return Array.isArray(raw && raw.items) ? raw.items : [];
  } catch {
    return [];
  }
}

function writeActions(config, items) {
  const file = actionsFile(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ items: items.slice(-MAX_ACTIONS) }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function todayStart(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function countToday(config, now = new Date()) {
  const start = todayStart(now);
  return readActions(config).filter((row) => row && Number(row.at) >= start).length;
}

function countTodayFor(config, id, now = new Date()) {
  const start = todayStart(now);
  return readActions(config).filter((row) => row && row.id === id && Number(row.at) >= start).length;
}

function lastActionFor(config, id) {
  const items = readActions(config);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i] && items[i].id === id) return items[i];
  }
  return null;
}

/** 单个能力的配置：{ enabled?:bool, maxPerDay?:number } */
function itemConfig(config, id) {
  const items = capsConfig(config).items;
  return items && typeof items === 'object' && items[id] && typeof items[id] === 'object' ? items[id] : {};
}

function itemEnabled(config, entry) {
  if (capsConfig(config).enabled === false) return false;
  if (itemConfig(config, entry.id).enabled === false) return false;
  try { return entry.enabled(config) !== false; } catch { return false; }
}

function itemMaxPerDay(config, id) {
  const value = itemConfig(config, id).maxPerDay;
  if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
    return Math.max(0, Number(value));
  }
  const global = capsConfig(config).maxPerDay;
  return Math.max(0, Number.isFinite(Number(global)) && global !== undefined ? Number(global) : DEFAULT_MAX_PER_DAY);
}

function recentToday(config, now = new Date(), limit = 3) {
  const start = todayStart(now);
  return readActions(config)
    .filter((row) => row && Number(row.at) >= start)
    .slice(-Math.max(1, limit));
}

function record(config, entry, now = new Date()) {
  const items = readActions(config);
  items.push({
    at: now.getTime(),
    id: String(entry.id || ''),
    label: String(entry.label || entry.id || ''),
    ok: Boolean(entry.ok),
    summary: String(entry.summary || '').slice(0, 160),
  });
  writeActions(config, items);
}

/* ------------------------------ 能力实现 ------------------------------ */

const REGISTRY = [
  {
    id: 'bili.watch',
    label: '逛 B 站',
    desc: '拉推荐流、自己挑视频看，记下视频资料并更新今天的日记（不会主动发分享）',
    enabled: (config) => features.isOn(config, 'bili'),
    async run(runtime, { now }) {
      const scheduler = runtime.biliScheduler;
      if (!scheduler) return { ok: false, summary: 'B 站调度器没启动' };
      const out = await scheduler.runRound({ dry: false, now, noShare: true });
      if (!out || !out.ok) return { ok: false, summary: '这轮没看成（' + ((out && out.reason) || '未知') + '）' };
      const n = Array.isArray(out.watched) ? out.watched.length : 0;
      const chars = out.diary && out.diary.ownerChars ? out.diary.ownerChars : 0;
      return { ok: true, summary: '看了 ' + n + ' 条视频，日记写了 ' + chars + ' 字' };
    },
  },
  {
    id: 'bili.diary.write',
    label: '写今天的日记',
    desc: '把今天看过的、聊过的整理成当天那篇日记（只更新当天，不新开日期）',
    enabled: (config) => features.isOn(config, 'bili') && ((config.bili && config.bili.diary) || {}).enabled !== false,
    async run(runtime, { now }) {
      const chatDigest = require('./bili/chatDigest');
      const diary = require('./bili/diary');
      const digest = chatDigest.collectDay(runtime, now).text;
      const out = await diary.writeRound({
        config: runtime.config,
        llm: runtime.llm,
        logger: runtime.logger,
        date: now,
        watched: [],
        chatDigest: digest,
        source: 'chat',
      });
      if (!out || !out.rewritten) {
        return { ok: false, summary: '这次没写（' + ((out && out.skipped) || '没有新内容') + '）' };
      }
      return { ok: true, summary: '日记更新了 ' + (out.ownerChars || 0) + ' 字' };
    },
  },
];

function entryById(id) {
  return REGISTRY.find((entry) => entry.id === id) || null;
}

/**
 * 能力列表：UI 需要看全部（包括「B 站功能没开」的灰项），提示词只用 enabled 的。
 * @returns {{id,label,desc,available:boolean,enabled:boolean,maxPerDay:number,today:number,last:object|null}[]}
 */
function list(config, now = new Date()) {
  return REGISTRY.map((entry) => {
    let available = false;
    try { available = entry.enabled(config) !== false; } catch { available = false; }
    const enabled = available && capsConfig(config).enabled !== false && itemConfig(config, entry.id).enabled !== false;
    return {
      id: entry.id,
      label: entry.label,
      desc: entry.desc,
      available,
      enabled,
      maxPerDay: itemMaxPerDay(config, entry.id),
      today: countTodayFor(config, entry.id, now),
      last: lastActionFor(config, entry.id),
    };
  });
}

/** 提示词里只列真正能用的能力。 */
function promptItems(config) {
  if (capsConfig(config).enabled === false) return [];
  return REGISTRY.filter((entry) => itemEnabled(config, entry)).map((entry) => ({ id: entry.id, label: entry.label, desc: entry.desc }));
}

function detect(text) {
  const ids = [];
  const value = String(text || '');
  let m;
  MARK_RE.lastIndex = 0;
  while ((m = MARK_RE.exec(value))) {
    const id = m[1].toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function strip(text) {
  return String(text || '')
    .replace(MARK_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 提示词里的「你会自己做的事」；没有可用能力时返回空串。 */
function block(config) {
  const items = promptItems(config);
  if (!items.length) return '';
  const lines = ['【你会自己做的事（不是每轮都做）】'];
  for (const item of items) lines.push('- ' + item.label + '：' + item.desc);
  lines.push('只有对方明确让你做、或你确实想做时才做。要做，就在回复最后单独写一行 [[cap:能力名]]（一次最多一个），系统会执行；不想做、拿不准，就不要写。');
  lines.push('做完之后可以自然提起，不用播报这个标记。');
  return lines.join('\n');
}

/** 今天已经做过的，给她一点「记忆」，避免重复做或不知道做没做。 */
function recentBlock(config, now = new Date()) {
  const rows = recentToday(config, now, 3);
  if (!rows.length) return '';
  const lines = ['【你最近做过的】'];
  for (const row of rows) {
    const time = new Date(Number(row.at) || Date.now());
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    lines.push('- ' + hh + ':' + mm + ' ' + (row.label || row.id) + '：' + (row.ok ? row.summary : '没成功（' + row.summary + '）'));
  }
  return lines.join('\n');
}

/**
 * 执行能力（异步、低优先）。返回每个能力的执行结果。
 * 每天最多 maxPerDay 次，防止模型反复触发。
 */
async function run(runtime, ids, ctx = {}) {
  if (capsConfig(runtime.config).enabled === false) return [];
  const allowed = promptItems(runtime.config).map((x) => x.id);
  const now = ctx.now instanceof Date ? ctx.now : new Date(ctx.now || Date.now());
  const results = [];
  for (const id of ids) {
    if (!allowed.includes(id)) { results.push({ id, ok: false, summary: '这个能力现在不可用' }); continue; }
    const maxPerDay = itemMaxPerDay(runtime.config, id);
    if (maxPerDay && countTodayFor(runtime.config, id, now) >= maxPerDay) {
      results.push({ id, ok: false, summary: '今天做太多次了，先歇会儿' });
      continue;
    }
    const entry = entryById(id);
    if (!entry) continue;
    let result;
    try {
      result = await entry.run(runtime, { now });
    } catch (err) {
      result = { ok: false, summary: (err && err.code) || '执行失败' };
    }
    const final = result || { ok: false, summary: '没有结果' };
    record(runtime.config, { id, label: entry.label, ok: final.ok, summary: final.summary }, now);
    runtime.logger?.info?.('[cap] ' + id + ' ' + (final.ok ? '完成' : '失败') + '：' + final.summary);
    results.push({ id, label: entry.label, ...final });
  }
  return results;
}

module.exports = {
  REGISTRY, MARK_RE, capsConfig, actionsFile, readActions, countToday, countTodayFor,
  lastActionFor, itemConfig, itemEnabled, itemMaxPerDay, list, promptItems,
  detect, strip, block, recentBlock, run, record,
};

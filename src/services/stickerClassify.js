'use strict';

/**
 * 表情包分类 worker：画面描述（/api/vision 同一个模型）+ 语境 + 图库现状 → 分类。
 *
 * 拿不准就留在「待定」，不硬猜；新分类只在 allowNewCategories 打开时创建。
 * 队列落盘（data/stickers/collect-queue.json），重启后继续处理。
 */

const fs = require('node:fs');
const path = require('node:path');
const features = require('../infra/features');
const stickers = require('../adapters/stickers');
const indexer = require('../infra/stickerIndex');
const collect = require('./stickerCollect');
const vision = require('../adapters/vision');

const MAX_ATTEMPTS = 3;
const SYSTEM = [
  '你在给一个聊天机器人整理自己的表情包图库。只输出 JSON，不要解释。',
  '格式：{"category":"分类标签","confidence":0到1,"tags":["…"],"description":"画面描述"}',
  'category 必须从给定分类里选；实在拿不准就填「待定」。description 描述画面主体/表情/动作/文字，≤80 字，不编造。',
].join('\n');

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function classifyConfig(config) {
  return (config && config.sticker && config.sticker.collect) || {};
}

function categoriesOf(config) {
  return stickers.promptCategories(config, config.root).map((c) => ({ key: c.key, label: c.label }));
}

function examplesOf(index, categories) {
  const out = {};
  for (const cat of categories) {
    out[cat.label] = Object.values(index.items)
      .filter((row) => row && row.category === cat.label && row.description)
      .slice(0, 3)
      .map((row) => String(row.description).slice(0, 60));
  }
  return out;
}

function parseModel(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (!obj || typeof obj !== 'object') return null;
    const category = String(obj.category || '').trim().slice(0, 20);
    const confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0));
    const tags = Array.isArray(obj.tags) ? obj.tags.map((t) => String(t).slice(0, 12)).filter(Boolean).slice(0, 4) : [];
    const description = String(obj.description || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return { category, confidence, tags, description };
  } catch {
    return null;
  }
}

/** 把 job 对应的文件移进目标分类目录；返回更新后的 item。 */
function moveToCategory(config, root, item, key, label, meta = {}) {
  const dir = stickers.stickerDir(config, root);
  const targetDir = stickers.categoryDir(dir, key, { create: true });
  if (!targetDir) return null;
  const src = path.join(dir, item.file);
  const name = path.basename(item.file);
  const dst = path.join(targetDir, name);
  try {
    if (src !== dst) fs.renameSync(src, dst);
  } catch {
    return null;
  }
  item.file = path.relative(dir, dst).split(path.sep).join('/');
  item.category = label;
  item.confidence = Number(meta.confidence) || 0;
  item.tags = Array.isArray(meta.tags) ? meta.tags : item.tags;
  if (meta.description) item.description = meta.description;
  return item;
}

/**
 * 处理一条队列任务。返回 'done' | 'pending' | 'skip'。
 */
async function classifyOne(runtime, job, deps = {}) {
  const config = runtime.config;
  const root = config.root || process.cwd();
  const cfg = classifyConfig(config);
  const now = deps.now || Date.now();
  const index = indexer.ensure(config, root);
  const item = index.items[job.sha];
  if (!item) return 'skip';
  if (item.category !== collect.PENDING_DIR) return 'skip';
  const dir = stickers.stickerDir(config, root);
  const file = path.join(dir, item.file);
  let buffer;
  try { buffer = fs.readFileSync(file); } catch { return 'skip'; }
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] || 'image/png';
  const describe = deps.describe || ((opts) => vision.describe(config, opts));
  const llm = deps.llm || runtime.llm;
  const categories = categoriesOf(config);

  let description = '';
  try {
    description = String(await describe({
      imageBase64: buffer.toString('base64'),
      mime,
      prompt: '这是聊天里收到的表情包。简短描述主体、表情、动作和画面上的文字，看不清就说看不清，不要编造。',
    }) || '').slice(0, 300);
  } catch (err) {
    runtime.logger?.warn?.('[sticker] 收藏分类看图失败：' + ((err && err.code) || 'vision'));
  }
  if (description) item.description = description.slice(0, 80);

  if (!llm || llm.isMock) {
    indexer.save(config, root, index);
    return 'pending';
  }

  const material = [
    '可选分类：' + categories.map((c) => c.label).join(' / '),
    Object.entries(examplesOf(index, categories)).filter(([, list]) => list.length)
      .map(([label, list]) => label + ' 现有例子：' + list.join('；')).join('\n'),
    '画面描述：' + (description || '（看不清）'),
    job.recent && job.recent.length ? '当时的聊天：' + job.recent.join(' / ') : '当时没有可用聊天上下文',
  ].filter(Boolean).join('\n');

  let parsed = null;
  try {
    const raw = await llm.complete({ system: SYSTEM, turns: [{ role: 'user', content: material }] });
    parsed = parseModel(raw);
  } catch (err) {
    runtime.logger?.warn?.('[sticker] 收藏分类失败：' + ((err && err.code) || 'llm'));
  }
  if (!parsed) {
    indexer.save(config, root, index);
    return 'pending';
  }

  const minConfidence = Math.max(0, Math.min(1, Number(cfg.minConfidence) || 0.6));
  let key = parsed.category && parsed.category !== '待定' ? stickers.resolveCategory(config, parsed.category) : '';
  let label = '';
  if (key) {
    label = categories.find((c) => c.key === key)?.label || parsed.category;
  } else if (parsed.category && parsed.category !== '待定' && cfg.allowNewCategories !== false) {
    const clean = stickers.cleanCategoryLabel(parsed.category);
    if (clean) {
      const existing = stickers.readExtraCategories(config, root);
      if (!existing.some((c) => c.label === clean)) {
        stickers.writeExtraCategories(config, root, [...existing, { label: clean, chance: 0.25 }]);
      }
      key = stickers.extraKey(clean);
      label = clean;
    }
  }
  if (!key || parsed.confidence < minConfidence) {
    indexer.save(config, root, index);
    return 'pending';
  }
  const moved = moveToCategory(config, root, item, key, label, parsed);
  if (!moved) {
    indexer.save(config, root, index);
    return 'pending';
  }
  index.pending = (index.pending || []).filter((sha) => sha !== job.sha);
  indexer.save(config, root, index);
  runtime.logger?.info?.('[sticker] 收藏归类：' + (job.sha || '').slice(0, 8) + ' → ' + label + '（' + Math.round(parsed.confidence * 100) + '%）');
  return 'done';
}

let running = false;

/** 处理队列里的任务；返回统计。 */
async function processQueue(runtime, deps = {}) {
  if (running) return { skipped: true, done: 0, pending: 0, dropped: 0 };
  running = true;
  const config = runtime.config;
  const root = config.root || process.cwd();
  const stats = { done: 0, pending: 0, dropped: 0, skipped: false };
  try {
    const jobs = collect.readQueue(config, root);
    if (!jobs.length) return stats;
    const keep = [];
    for (const job of jobs) {
      let result = 'skip';
      try {
        result = await classifyOne(runtime, job, deps);
      } catch (err) {
        runtime.logger?.warn?.('[sticker] 收藏队列异常：' + ((err && err.code) || 'unknown'));
      }
      if (result === 'done') stats.done += 1;
      else if (result === 'pending') {
        stats.pending += 1;
        job.attempts = (Number(job.attempts) || 0) + 1;
        if (job.attempts < MAX_ATTEMPTS) keep.push(job);
        else stats.dropped += 1;
      }
    }
    collect.writeQueue(config, root, keep);
    if (stats.done || stats.pending) {
      runtime.logger?.info?.('[sticker] 收藏队列：归类 ' + stats.done + '，留待定 ' + stats.pending);
    }
    return stats;
  } finally {
    running = false;
  }
}

let timer = null;

function start(runtime) {
  if (timer) return;
  timer = setInterval(() => {
    if (!features.isOn(runtime.config, 'stickers')) return;
    if (classifyConfig(runtime.config).enabled === false) return;
    processQueue(runtime).catch(() => { /* 后台任务不许把进程带崩 */ });
  }, 5000);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { SYSTEM, MAX_ATTEMPTS, classifyConfig, categoriesOf, examplesOf, parseModel, classifyOne, processQueue, start, stop, moveToCategory };

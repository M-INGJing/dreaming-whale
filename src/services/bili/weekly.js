'use strict';

/**
 * 每周小结：每周日（默认 22 点后）把这一周的日记读一遍，更新「我最近的口味/状态」。
 *
 * 为什么要有这一步：写给自己的日记（self.md）以前只写不读，等于没有反哺。
 * 每周把两本日记压成一小段（摘要 + 喜欢的 + 不想看的），之后聊天时作为「底色」
 * 注入 1 段（≤220 字），让「她因你而变」真正闭环。
 *
 * 只在每周日跑一次；没有模型/没有日记就跳过，不打扰聊天。
 */

const fs = require('node:fs');
const path = require('node:path');
const biliStore = require('../../infra/biliStore');
const diaryFormat = require('../../core/bili/diaryFormat');
const features = require('../../infra/features');
const persona = require('../../persona');

const WEEKLY_FILE = 'weekly.json';
const TOTAL_CAP = 3000;

const SYSTEM = [
  '你在整理「这一周的日记」，给自己做一份最近的小结，只输出 JSON，不要解释。',
  '格式：{"summary":"...","likes":["..."],"dislikes":["..."],"state":"..."}',
  'summary：150~300 字，用第一人称写这一周整体状态、反复出现的情绪或想法；不要按天罗列。',
  'likes / dislikes：各 2~5 个短词或短语（≤8 字），写最近更想看/更不想看、更想聊/更不想聊的东西。',
  'state：一句话近况（≤30 字），例如「这周有点累，但被猫视频救了几次」。',
  '只依据给定的日记，不要编造没写过的经历；不要引用原句。',
].join('\n');

function weeklyPath(config) {
  return path.join(biliStore.paths(config).dir, 'diary', WEEKLY_FILE);
}

function weeklyConfig(config) {
  return (config && config.bili && config.bili.weekly) || {};
}

/** 本周起点（最近的周日 0 点，本地时区），用于「一周只更新一次」。 */
function weekStartOf(now = new Date()) {
  const d = now instanceof Date ? new Date(now) : new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // getDay(): 0 = 周日
  return d;
}

function dayKey(d) {
  return diaryFormat.today(d);
}

/** 取最近 7 天（今天是周日则含今天）两本日记的正文。 */
function collectWeekEntries(config, now = new Date()) {
  const diaries = biliStore.readDiaries(config);
  const days = [];
  let total = 0;
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    const o = diaryFormat.digestOf(diaries.owner, d, 600);
    const s = diaryFormat.digestOf(diaries.self, d, 400);
    if (!o && !s) continue;
    const block = '## ' + key + '\n' + (o ? '主人版：' + o : '') + (s ? '\n自记：' + s : '');
    if (total + block.length > TOTAL_CAP) break;
    total += block.length;
    days.push(block);
  }
  return { text: days.join('\n\n'), days: days.length };
}

function readWeekly(config) {
  const raw = biliStore.readJson(weeklyPath(config), {});
  return {
    weekStart: String(raw.weekStart || ''),
    generatedAt: Number(raw.generatedAt) || 0,
    summary: String(raw.summary || ''),
    likes: Array.isArray(raw.likes) ? raw.likes.map(String) : [],
    dislikes: Array.isArray(raw.dislikes) ? raw.dislikes.map(String) : [],
    state: String(raw.state || ''),
  };
}

function parseModel(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (!obj || typeof obj !== 'object') return null;
    const summary = diaryFormat.clean(obj.summary, 600);
    const likes = (Array.isArray(obj.likes) ? obj.likes : []).map((x) => String(x).trim().slice(0, 12)).filter(Boolean).slice(0, 5);
    const dislikes = (Array.isArray(obj.dislikes) ? obj.dislikes : []).map((x) => String(x).trim().slice(0, 12)).filter(Boolean).slice(0, 5);
    const state = String(obj.state || '').trim().slice(0, 40);
    if (!summary) return null;
    return { summary, likes, dislikes, state };
  } catch {
    return null;
  }
}

/**
 * 到点就更新（周日 + hour 之后 + 本周还没更新过）。
 * @returns {Promise<{ok:boolean, skipped?:string, entry?:object}>}
 */
async function maybeUpdate(runtime, opts = {}) {
  const config = runtime.config;
  const cfg = weeklyConfig(config);
  if (!features.isOn(config, 'bili')) return { ok: false, skipped: 'feature_off' };
  if (cfg.enabled === false) return { ok: false, skipped: 'disabled' };
  if (config.bili && config.bili.diary && config.bili.diary.enabled === false) return { ok: false, skipped: 'diary_off' };
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const weekday = Number.isFinite(cfg.weekday) ? cfg.weekday : 0;
  const hour = Number.isFinite(cfg.hour) ? cfg.hour : 22;
  if (!opts.force) {
    if (now.getDay() !== weekday) return { ok: false, skipped: 'not_weekday' };
    if (now.getHours() < hour) return { ok: false, skipped: 'too_early' };
  }
  const weekStart = dayKey(weekStartOf(now));
  const state = readWeekly(config);
  if (!opts.force && state.weekStart === weekStart) return { ok: false, skipped: 'already_done' };

  const week = collectWeekEntries(config, now);
  if (!week.text) return { ok: false, skipped: 'no_diary' };
  const llm = opts.llm || runtime.llm;
  if (!llm || llm.isMock) return { ok: false, skipped: 'no_model' };

  let parsed = null;
  try {
    // 用她的人设语气写小结，别写成通用 AI 的周报腔
    const voice = persona.voiceHint(config);
    const raw = await llm.complete({
      system: SYSTEM + (voice ? '\n' + voice : ''),
      turns: [{ role: 'user', content: '这一周的日记：\n' + week.text }],
    });
    parsed = parseModel(raw);
  } catch (err) {
    runtime.logger?.warn?.('[bili] 每周小结失败：' + ((err && err.code) || 'llm'));
  }
  if (!parsed) return { ok: false, skipped: 'bad_output' };

  const entry = {
    weekStart,
    generatedAt: Date.now(),
    summary: parsed.summary,
    likes: parsed.likes,
    dislikes: parsed.dislikes,
    state: parsed.state,
  };
  biliStore.writeJson(weeklyPath(config), entry);
  biliStore.appendEvent(config, { kind: 'weekly_summary', weekStart, days: week.days, chars: entry.summary.length });
  runtime.logger?.info?.('[bili] 每周小结已更新（' + week.days + ' 天日记）');
  return { ok: true, entry };
}

/** 聊天里注入的那一小段；没有/太旧（>14 天）就返回空。 */
function blockFor(config, now = new Date()) {
  const cfg = weeklyConfig(config);
  if (cfg.enabled === false) return '';
  const state = readWeekly(config);
  if (!state.summary) return '';
  const ageDays = state.generatedAt ? (now.getTime() - state.generatedAt) / 86400000 : 99;
  if (ageDays > 14) return '';
  const lines = [
    '【我最近的状态（来自上周日记的小结，只当底色）】',
    diaryFormat.clean(state.summary, 240),
  ];
  if (state.likes.length) lines.push('最近更喜欢：' + state.likes.slice(0, 4).join('、'));
  if (state.dislikes.length) lines.push('最近不太想碰：' + state.dislikes.slice(0, 4).join('、'));
  lines.push('说到相关话题时自然带出一点就好，别每句都提，也别念小结。');
  return lines.join('\n');
}

module.exports = {
  WEEKLY_FILE, SYSTEM, weeklyPath, weeklyConfig, weekStartOf, collectWeekEntries,
  readWeekly, parseModel, maybeUpdate, blockFor,
};

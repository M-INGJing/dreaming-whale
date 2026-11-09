'use strict';

/**
 * B 站养鱼的本机存储（data/bili/，已被 .gitignore 排除）。
 *
 * 原则：
 *  - 全部是普通文件，原子写（.tmp→rename），断电不产生半个 JSON；
 *  - 日记按天追加，同一天第二次醒只续写当天那一节；
 *  - 事件流只记结构信息（kind/bvid/计数），不写视频正文与 cookie。
 */

const fs = require('node:fs');
const path = require('node:path');
const diaryFormat = require('../core/bili/diaryFormat');

const REL = 'data/bili';

function rootOf(config) {
  if (config && config.paths && config.paths.dataDir) return path.resolve(config.paths.dataDir, '..');
  return process.cwd();
}

function paths(config) {
  const root = rootOf(config);
  const dir = path.join(root, REL);
  return {
    root,
    dir,
    state: path.join(dir, 'state.json'),
    quota: path.join(dir, 'quota.json'),
    events: path.join(dir, 'events.jsonl'),
    diaryOwner: path.join(dir, 'diary', 'owner.md'),
    diarySelf: path.join(dir, 'diary', 'self.md'),
    style: path.join(dir, 'style.json'),
    titles: path.join(dir, 'titles.json'),
    feedDir: path.join(dir, 'feed'),
  };
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(file);
  const tmp = file + '.tmp';
  const payload = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, file);
  return data;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function appendEvent(config, event) {
  const p = paths(config);
  ensureDir(p.events);
  const row = { at: new Date().toISOString(), ...(event && typeof event === 'object' ? event : { kind: 'event' }) };
  try {
    fs.appendFileSync(p.events, JSON.stringify(row) + '\n', 'utf8');
    return row;
  } catch {
    return null;
  }
}

function appendFeedLog(config, date, rows) {
  const p = paths(config);
  fs.mkdirSync(p.feedDir, { recursive: true });
  const file = path.join(p.feedDir, diaryFormat.today(date) + '.jsonl');
  try {
    fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return file;
  } catch {
    return '';
  }
}

/**
 * 写一天的一节：当天已有内容就续写，否则新开一节。
 * @param {'owner'|'self'} kind
 */
function appendDiary(config, kind, date, body) {
  const p = paths(config);
  const file = kind === 'self' ? p.diarySelf : p.diaryOwner;
  ensureDir(file);
  let text = String(body == null ? '' : body).trim();
  if (!text) return '';
  const existing = readText(file);
  const key = diaryFormat.today(date);
  const existingToday = diaryFormat.digestOf(existing, date, 100000);
  // 当天段数上限：一天醒好几次（含手动跑）时，日记不至于变成流水账
  const maxEntries = Math.max(0, Number(config && config.bili && config.bili.diary && config.bili.diary.maxEntriesPerDay) || 0);
  if (maxEntries && existingToday) {
    const paragraphs = existingToday.split(/\n{2,}/).filter(Boolean).length;
    if (paragraphs >= maxEntries) return '';
  }
  // 当天字数上限：防止一天醒好几次把日记写成流水账（也防止 token 失控）
  const cap = Math.max(0, Number(config && config.bili && config.bili.diary && config.bili.diary.maxCharsPerDay) || 0);
  if (cap && existingToday.length + text.length > cap) {
    const remain = cap - existingToday.length;
    if (remain < 60) return ''; // 当天写满了，这次就不写
    text = text.slice(0, remain);
  }
  let next;
  if (existingToday) {
    // 同一天再醒：续写在文件末尾（当天那节一定在最后，因为只按时间顺序追加）
    next = existing.endsWith('\n') ? existing : existing + '\n';
    next += '\n' + text + '\n';
  } else {
    next = existing ? existing.replace(/\s*$/, '\n\n') : '';
    next += diaryFormat.section(date, text);
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 同一天重写成一篇完整日记（替换当天那一节，不追加）。 */
function writeDiarySection(config, kind, date, body) {
  const p = paths(config);
  const file = kind === 'self' ? p.diarySelf : p.diaryOwner;
  ensureDir(file);
  const text = String(body == null ? '' : body).trim();
  if (!text) return '';
  const existing = readText(file);
  const next = diaryFormat.replaceSection(existing, date, text);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 状态页用：只回计数与最近标题，不回日记正文。 */
function diarySummary(config, date) {
  const p = paths(config);
  const owner = readText(p.diaryOwner);
  const self = readText(p.diarySelf);
  return {
    ownerDays: diaryFormat.countDays(owner),
    selfDays: diaryFormat.countDays(self),
    todayOwnerChars: diaryFormat.digestOf(owner, date, 100000).length,
    todaySelfChars: diaryFormat.digestOf(self, date, 100000).length,
  };
}

function readDiaries(config) {
  const p = paths(config);
  return { owner: readText(p.diaryOwner), self: readText(p.diarySelf) };
}

/** 视频标题缓存：bvid → 标题。老日志里只有 BV 号，靠它补标题。 */
function readTitles(config) {
  const data = readJson(paths(config).titles, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function mergeTitles(config, map) {
  const current = readTitles(config);
  let changed = 0;
  for (const [bvid, title] of Object.entries(map || {})) {
    const key = String(bvid || '').trim();
    const text = String(title || '').trim().slice(0, 200);
    if (!key || !text) continue;
    if (current[key] !== text) { current[key] = text; changed += 1; }
  }
  if (changed) writeJson(paths(config).titles, current);
  return changed;
}

module.exports = {
  REL, paths, rootOf, readJson, writeJson, readText, appendEvent, appendFeedLog,
  appendDiary, writeDiarySection, diarySummary, readDiaries, readTitles, mergeTitles,
};

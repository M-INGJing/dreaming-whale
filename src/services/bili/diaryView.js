'use strict';

/**
 * 给启动器看的「日记 + 看过的视频」视图（只读聚合，不写任何文件）。
 *
 * 数据来源：
 *  - data/bili/diary/{owner,self}.md：按 `## YYYY-MM-DD` 分节；
 *  - data/bili/feed/YYYY-MM-DD.jsonl：当天候选与分数（含标题）；
 *  - data/bili/events.jsonl：wake 事件里的 watched 列表、share_sent 事件。
 *
 * 只回展示需要的字段；不读 config、不发请求。
 */

const fs = require('node:fs');
const path = require('node:path');
const biliStore = require('../../infra/biliStore');
const diaryFormat = require('../../core/bili/diaryFormat');

function readTextSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** 把 Markdown 按天拆成 { '2026-11-08': '正文' }。 */
function splitSections(markdown) {
  const out = {};
  const lines = String(markdown || '').split('\n');
  let date = '';
  let buf = [];
  for (const line of lines) {
    const m = diaryFormat.DAY_HEADING.exec(line.trim());
    if (m) {
      if (date) out[date] = buf.join('\n').trim();
      date = m[1];
      buf = [];
      continue;
    }
    if (date) buf.push(line);
  }
  if (date) out[date] = buf.join('\n').trim();
  return out;
}

function dayOfIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return diaryFormat.today(d);
}

/** 读某天的 feed 日志：bvid → {title, score, watched}。 */
function feedMap(config, date) {
  const p = biliStore.paths(config);
  const file = path.join(p.feedDir, date + '.jsonl');
  const map = new Map();
  for (const line of readTextSafe(file).split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || !row.bvid) continue;
      const prev = map.get(row.bvid) || {};
      map.set(row.bvid, {
        title: row.title || prev.title || '',
        score: Number.isFinite(row.score) ? row.score : prev.score || 0,
        watched: Boolean(row.watched) || Boolean(prev.watched),
      });
    } catch { /* 单行坏了跳过 */ }
  }
  return map;
}

/** 读事件流，按天收集 watched / shares。 */
function eventsByDay(config) {
  const p = biliStore.paths(config);
  const out = new Map();
  for (const line of readTextSafe(p.events).split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const date = dayOfIso(row && row.at);
    if (!date) continue;
    if (!out.has(date)) out.set(date, { watched: [], shares: 0 });
    const bucket = out.get(date);
    if (row.kind === 'wake' && Array.isArray(row.watched)) {
      for (const bvid of row.watched) if (bvid && !bucket.watched.includes(bvid)) bucket.watched.push(String(bvid));
    }
    if (row.kind === 'share_sent') bucket.shares += 1;
  }
  return out;
}

/**
 * @param {object} config
 * @param {{ days?: number }} opts
 * @returns {{ days: Array<{date,owner,self,watched:Array<{bvid,title,score}>,shares:number}> }}
 */
function listDays(config, opts = {}) {
  const p = biliStore.paths(config);
  const owner = splitSections(biliStore.readText(p.diaryOwner));
  const self = splitSections(biliStore.readText(p.diarySelf));
  const events = eventsByDay(config);
  const titles = biliStore.readTitles(config);
  const dates = new Set([...Object.keys(owner), ...Object.keys(self), ...events.keys()]);
  const limit = Math.max(1, Math.min(200, Number(opts.days) || 60));
  const sorted = [...dates].sort().reverse().slice(0, limit);
  return {
    days: sorted.map((date) => {
      const ev = events.get(date) || { watched: [], shares: 0 };
      const feeds = feedMap(config, date);
      const watched = ev.watched.map((bvid) => {
        const row = feeds.get(bvid) || {};
        return { bvid, title: row.title || titles[bvid] || '', score: row.score || 0 };
      });
      return {
        date,
        owner: owner[date] || '',
        self: self[date] || '',
        watched,
        shares: ev.shares,
      };
    }),
  };
}

module.exports = { listDays, splitSections, eventsByDay, feedMap, dayOfIso };

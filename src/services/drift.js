'use strict';

/**
 * 人格漂移监测：按天统计她的回复，超健康区间给一句提示。
 *
 * 纯函数 metrics / hint 可测；analyze 读 messages.jsonl 聚合最近 N 天的 assistant 回复，
 * 写 data/drift.json；status 读回提示。数据已经在 messages.jsonl 里，不用新采集。
 */

const fs = require('node:fs');
const path = require('node:path');

const AI_WORDS = ['首先', '其次', '总的来说', '希望这能帮到你', '作为一个 AI', '语言模型', '还有什么可以帮'];
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const REPORT_FILE = 'drift.json';

/** 2 字 shingle 重合度（复读检测，和 tests/persona-eval 同一口径） */
function overlap(a, b) {
  const sh = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const sa = sh(a);
  const sb = sh(b);
  if (!sb.size) return 0;
  let hit = 0;
  for (const x of sa) if (sb.has(x)) hit += 1;
  return hit / sb.size;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** 一段回复（按天）的指标；空返回 null */
function metrics(replies) {
  const list = (replies || []).map((r) => String((r && r.text) || '')).filter(Boolean);
  if (!list.length) return null;
  const lengths = list.map((t) => Array.from(t).length).sort((a, b) => a - b);
  const p50 = lengths[Math.floor(lengths.length / 2)];
  const emojiRate = list.filter((t) => EMOJI_RE.test(t)).length / list.length;
  const questionRate = list.filter((t) => /[?？]$/.test(t.trim())).length / list.length;
  const aiRate = list.filter((t) => AI_WORDS.some((w) => t.includes(w))).length / list.length;
  let maxSim = 0;
  for (let i = 1; i < list.length; i += 1) maxSim = Math.max(maxSim, overlap(list[i - 1], list[i]));
  return {
    count: list.length,
    p50,
    emojiRate: round3(emojiRate),
    questionRate: round3(questionRate),
    aiRate: round3(aiRate),
    maxSim: round3(maxSim),
  };
}

/** 健康区间（超出就提示）。样本太少（count<5）时跳过长度/emoji 这类需要统计量的判断。 */
const HEALTH = {
  p50: { min: 8, max: 35 },
  emojiRate: { min: 0.05, max: 0.3 },
  questionRate: { min: 0.1, max: 0.4 },
  aiRate: { max: 0.02 },
  maxSim: { max: 0.5 },
};

/** 超区间就给一句提示；健康返回 '' */
function hint(m) {
  if (!m) return '';
  const parts = [];
  if (m.count >= 5) {
    if (m.p50 > HEALTH.p50.max) parts.push('说话变长了（中位 ' + m.p50 + ' 字）');
    else if (m.p50 < HEALTH.p50.min) parts.push('回复变短了');
    if (m.emojiRate < HEALTH.emojiRate.min) parts.push('表情变少了');
  }
  if (m.aiRate > HEALTH.aiRate.max) parts.push('开始冒 AI 味（' + Math.round(m.aiRate * 100) + '%）');
  if (m.maxSim > HEALTH.maxSim.max) parts.push('有点复读');
  return parts.join('；');
}

function dayStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 读最近 N 天的 assistant 回复，按天分组（直接读文件，不依赖运行中的 store） */
function readRecent(config, { days = 7, now = Date.now() } = {}) {
  const memoryDir = path.join(config.paths.dataDir, 'memory', 'chats');
  const start = dayStart(now) - (days - 1) * 86400000;
  const byDay = new Map();
  let dirs = [];
  try {
    dirs = fs.readdirSync(memoryDir);
  } catch {
    return byDay;
  }
  for (const dir of dirs) {
    const file = path.join(memoryDir, dir, 'messages.jsonl');
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let m;
      try {
        m = JSON.parse(s);
      } catch {
        continue;
      }
      if (!m || m.role !== 'assistant' || !m.text) continue;
      const ts = Number(m.ts) || 0;
      if (ts < start) continue;
      const day = dayKey(ts);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ ts, text: String(m.text) });
    }
  }
  return byDay;
}

/** 聚合最近 N 天，写 data/drift.json，返回报告 */
function analyze(config, { days = 7, now = Date.now() } = {}) {
  const byDay = readRecent(config, { days, now });
  const dayArr = [];
  for (const [date, replies] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const m = metrics(replies);
    if (m) dayArr.push({ date, ...m });
  }
  const last = dayArr[dayArr.length - 1] || null;
  const report = {
    updatedAt: now,
    days: dayArr.slice(-Math.max(1, days)),
    hint: hint(last),
  };
  try {
    const file = path.join(config.paths.dataDir, REPORT_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  } catch {
    /* 写不了不影响 */
  }
  return report;
}

/** 读回提示；没有报告 / 健康返回 '' */
function status(config) {
  try {
    const file = path.join(config.paths.dataDir, REPORT_FILE);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return String(raw.hint || '');
  } catch {
    return '';
  }
}

module.exports = { metrics, hint, readRecent, analyze, status, overlap, AI_WORDS, HEALTH, REPORT_FILE };

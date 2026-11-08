'use strict';

/**
 * B 站作息：什么时候该醒、今天醒过几次、要不要开摆。
 *
 * 纯函数，时间与随机都注入，测试不依赖真实时钟。
 * 支持跨午夜窗口（如 22:00–02:00）。「一天」按本机时区的自然日算。
 */

const MINUTES_DAY = 24 * 60;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 'HH:MM' / '8:05' / 480 → 当天的分钟数；非法返回 null。 */
function parseClock(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.floor(value);
    return n >= 0 && n < MINUTES_DAY ? n : null;
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  if (h === 24 && min !== 0) return null;
  return h * 60 + min;
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function dayKey(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function normalizeWindows(list) {
  const out = [];
  for (const w of Array.isArray(list) ? list : []) {
    const start = parseClock(w && w.start);
    const end = parseClock(w && w.end);
    if (start == null || end == null || start === end) continue;
    out.push({ start, end, wakes: Math.max(1, Math.min(10, Number(w.wakes) || 1)) });
  }
  return out;
}

/** 当前分钟是否落在某个窗口里；跨午夜窗口拆成两段判断。 */
function windowAt(windows, date) {
  const now = minutesOfDay(date);
  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i];
    const inWindow = w.start < w.end
      ? now >= w.start && now < w.end
      : now >= w.start || now < w.end;
    if (inWindow) return { index: i, ...w };
  }
  return null;
}

/**
 * @param {object} opts { windows, skipChance, maxWakesPerDay }
 * @param {object} state { date, wakes, skipped }
 * @param {Date} now
 * @param {() => number} rng
 * @returns {{wake:boolean, reason:string, window?:object, skipped?:boolean}}
 */
function shouldWake(opts, state, now, rng = Math.random) {
  const windows = normalizeWindows(opts && opts.windows);
  if (!windows.length) return { wake: false, reason: 'no_window' };
  const today = dayKey(now);
  const s = state && state.date === today ? state : { date: today, wakes: 0, skipped: false };
  if (s.skipped) return { wake: false, reason: 'skipped_today', skipped: true };
  const max = Math.max(1, Math.min(10, Number(opts && opts.maxWakesPerDay) || 1));
  if (s.wakes >= max) return { wake: false, reason: 'already_awake' };
  const win = windowAt(windows, now);
  if (!win) return { wake: false, reason: 'outside_window' };
  const chance = Math.max(0, Math.min(1, Number(opts && opts.skipChance) || 0));
  if (chance > 0 && rng() < chance) return { wake: false, reason: 'skip_roll', skipped: true, window: win };
  // 同一窗口里分配的 wakes 次数：按窗口序号均分，避免一个窗口把额度用光。
  const quotaInWindow = win.wakes;
  const usedInWindow = Math.min(quotaInWindow, Math.max(0, s.wakes - win.index * quotaInWindow));
  if (usedInWindow >= quotaInWindow && s.wakes > 0) {
    return { wake: false, reason: 'window_quota_used', window: win };
  }
  return { wake: true, reason: 'window_open', window: win };
}

/** 下一次窗口开始的分钟（用于状态展示；找不到就返回 null）。 */
function nextWindowIn(windows, date) {
  const list = normalizeWindows(windows);
  if (!list.length) return null;
  const now = minutesOfDay(date);
  let best = null;
  for (const w of list) {
    const delta = w.start >= now ? w.start - now : MINUTES_DAY - now + w.start;
    if (best == null || delta < best) best = delta;
  }
  return best;
}

module.exports = { parseClock, minutesOfDay, dayKey, normalizeWindows, windowAt, shouldWake, nextWindowIn, MINUTES_DAY };

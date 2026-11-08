'use strict';

/**
 * 读/写预算：按小时和按天滚动，纯函数。
 *
 * state 形状（存在 data/bili/quota.json）：
 *   { day:'YYYY-MM-DD', hour:'YYYY-MM-DDTHH', readDay, readHour, writeDay, writeHour, lastWriteAt }
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function keys(now) {
  const d = now instanceof Date ? now : new Date(now);
  const day = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  return { day, hour: day + 'T' + pad2(d.getHours()) };
}

function emptyState() {
  return { day: '', hour: '', readDay: 0, readHour: 0, writeDay: 0, writeHour: 0, lastWriteAt: 0 };
}

/** 跨天/跨小时自动清零；不改动传入对象。 */
function roll(state, now = new Date()) {
  const base = state && typeof state === 'object' ? state : emptyState();
  const { day, hour } = keys(now);
  const next = { ...emptyState(), ...base, day, hour };
  if (base.day !== day) { next.readDay = 0; next.writeDay = 0; }
  if (base.hour !== hour) { next.readHour = 0; next.writeHour = 0; }
  return next;
}

function limitsOf(risk = {}) {
  return {
    readHourly: Math.max(0, Number(risk.readHourly) || 0),
    readDaily: Math.max(0, Number(risk.readDaily) || 0),
    writeHourly: Math.max(0, Number(risk.writeHourly) || 0),
    writeDaily: Math.max(0, Number(risk.writeDaily) || 0),
    writeGapSec: Math.max(0, Number(risk.writeGapSec) || 0),
  };
}

function canRead(state, risk, now = new Date()) {
  const s = roll(state, now);
  const l = limitsOf(risk);
  if (l.readHourly && s.readHour >= l.readHourly) return { ok: false, reason: 'read_hourly', state: s };
  if (l.readDaily && s.readDay >= l.readDaily) return { ok: false, reason: 'read_daily', state: s };
  return { ok: true, reason: '', state: s };
}

function noteRead(state, n = 1, now = new Date()) {
  const s = roll(state, now);
  s.readHour += n;
  s.readDay += n;
  return s;
}

function canWrite(state, risk, now = new Date()) {
  const s = roll(state, now);
  const l = limitsOf(risk);
  if (l.writeHourly && s.writeHour >= l.writeHourly) return { ok: false, reason: 'write_hourly', state: s };
  if (l.writeDaily && s.writeDay >= l.writeDaily) return { ok: false, reason: 'write_daily', state: s };
  const gapMs = l.writeGapSec * 1000;
  if (gapMs && s.lastWriteAt && now.getTime() - s.lastWriteAt < gapMs) return { ok: false, reason: 'write_gap', state: s };
  return { ok: true, reason: '', state: s };
}

function noteWrite(state, now = new Date()) {
  const s = roll(state, now);
  s.writeHour += 1;
  s.writeDay += 1;
  s.lastWriteAt = now.getTime();
  return s;
}

module.exports = { keys, emptyState, roll, limitsOf, canRead, noteRead, canWrite, noteWrite };

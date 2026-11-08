'use strict';

/**
 * B 站作息调度：每分钟看一眼「现在该不该醒」，该醒就刷一轮、写日记。
 *
 * 依赖全部可注入（fetchFeed / readVideo / writeDiary / now / rng），测试不联网、不写盘。
 * 关掉 features.bili 时整轮直接跳过，不产生任何请求。
 */

const features = require('../../infra/features');
const clock = require('../../core/bili/clock');
const score = require('../../core/bili/score');
const quota = require('../../core/bili/quota');
const biliStore = require('../../infra/biliStore');
const feedService = require('./feed');
const diaryService = require('./diary');
const biliWatch = require('../biliWatch');

const TICK_MS = 60 * 1000;

function biliConfig(config) {
  return (config && config.bili) || {};
}

function nightOf(config) {
  const b = biliConfig(config);
  return (b.night) || {};
}

function createBiliScheduler(opts = {}) {
  const runtime = opts.runtime || null;
  const logger = opts.logger || (runtime && runtime.logger) || null;
  const nowFn = opts.now || (() => new Date());
  const rng = opts.rng || Math.random;
  const fetchFeed = opts.fetchFeed || feedService.fetchFeed;
  const readVideo = opts.readVideo || ((config, url, deps) => biliWatch.readVideo(config, url, deps));
  const writeDiary = opts.writeDiary || diaryService.writeRound;

  let timer = null;
  let running = false;

  function config() { return (runtime && runtime.config) || opts.config || {}; }
  function storeConfig() { return config(); }

  /** 读状态并顺手把「跨天」清理掉。 */
  function loadState(now) {
    const cfg = storeConfig();
    const raw = biliStore.readJson(biliStore.paths(cfg).state, {});
    const today = clock.dayKey(now);
    if (raw.date !== today) return { date: today, wakes: 0, skipped: false, lastWakeAt: 0 };
    return {
      date: raw.date, wakes: Number(raw.wakes) || 0, skipped: Boolean(raw.skipped),
      lastWakeAt: Number(raw.lastWakeAt) || 0,
    };
  }

  function saveState(state) {
    try { biliStore.writeJson(biliStore.paths(storeConfig()).state, state); } catch (err) {
      logger?.warn?.('[bili] 保存 state 失败：' + (err && err.code ? err.code : 'io'));
    }
  }

  function loadQuota(now) {
    const cfg = storeConfig();
    const raw = biliStore.readJson(biliStore.paths(cfg).quota, null);
    return quota.roll(raw || quota.emptyState(), now);
  }

  function saveQuota(state) {
    try { biliStore.writeJson(biliStore.paths(storeConfig()).quota, state); } catch { /* 配额写失败不致命 */ }
  }

  /** 今天该不该醒（纯判定；不执行）。 */
  function decision(now = nowFn()) {
    const cfg = config();
    if (!features.isOn(cfg, 'bili')) return { wake: false, reason: 'disabled' };
    const night = nightOf(cfg);
    const state = loadState(now);
    const out = clock.shouldWake({
      windows: night.windows,
      skipChance: night.skipChance,
      maxWakesPerDay: night.maxWakesPerDay,
    }, state, now, rng);
    return { ...out, state, night };
  }

  /** 手动/定时跑一轮。dry=true 只看会选什么，不读视频、不写日记、不记账。 */
  async function runRound({ dry = false, now = nowFn() } = {}) {
    if (running) return { ok: false, reason: 'busy' };
    const cfg = config();
    if (!features.isOn(cfg, 'bili')) return { ok: false, reason: 'disabled' };
    const bili = biliConfig(cfg);
    const night = nightOf(cfg);
    const risk = bili.risk || {};
    const prefs = bili.preferences || {};
    const q = loadQuota(now);
    const allow = quota.canRead(q, risk, now);
    if (!allow.ok) {
      saveQuota(allow.state);
      return { ok: false, reason: allow.reason };
    }
    running = true;
    try {
      const feed = await fetchFeed(cfg, { limit: 20, logger });
      if (!feed.items.length) {
        biliStore.appendEvent(cfg, { kind: 'feed_empty', reason: feed.reason || 'empty' });
        return { ok: false, reason: 'empty_feed', source: feed.source };
      }
      const maxVideos = Math.max(1, Math.min(20, Number(night.maxVideos) || 5));
      const ranked = score.rankCandidates(feed.items, prefs, {
        now: now.getTime(),
        limit: maxVideos,
        maxMinutes: Number(night.maxMinutes) || 45,
      });
      if (dry) {
        return {
          ok: true, dry: true, source: feed.source,
          picked: ranked.map((row) => ({
            bvid: row.candidate.bvid, title: row.candidate.title, score: Math.round(row.score), reasons: row.reasons,
          })),
        };
      }
      const deep = Math.min(2, ranked.length);
      const watched = [];
      for (let i = 0; i < deep; i += 1) {
        const candidate = ranked[i].candidate;
        let digest = '';
        try {
          digest = await readVideo(cfg, candidate.bvid, { logger });
        } catch (err) {
          logger?.warn?.('[bili] 读视频失败 code=' + (err && err.code ? err.code : 'unknown'));
        }
        watched.push({ candidate, digest });
      }
      const diary = await writeDiary({ config: cfg, llm: runtime && runtime.llm, logger, date: now, watched });
      const reads = 1 + deep * 3;
      let qa = quota.noteRead(allow.state, reads, now);
      saveQuota(qa);
      const state = loadState(now);
      const next = { ...state, wakes: state.wakes + 1, lastWakeAt: now.getTime() };
      saveState(next);
      biliStore.appendFeedLog(cfg, now, ranked.map((row) => ({
        bvid: row.candidate.bvid, score: Math.round(row.score), reasons: row.reasons,
      })));
      biliStore.appendEvent(cfg, {
        kind: 'wake', source: feed.source, picked: ranked.length, watched: watched.map((w) => w.candidate.bvid),
        ownerChars: diary.ownerChars, selfChars: diary.selfChars,
      });
      return {
        ok: true, dry: false, source: feed.source,
        picked: ranked.map((row) => row.candidate.bvid), watched: watched.map((w) => w.candidate.bvid),
        diary,
      };
    } finally {
      running = false;
    }
  }

  async function tick(now = nowFn()) {
    if (running) return { ok: false, reason: 'busy' };
    let d;
    try { d = decision(now); } catch (err) { return { ok: false, reason: 'decision_error' }; }
    if (!d.wake) {
      if (d.skipped && d.state && !d.state.skipped) {
        const next = { ...d.state, skipped: true };
        saveState(next);
        biliStore.appendEvent(storeConfig(), { kind: 'skip', reason: d.reason });
      }
      return { ok: true, woke: false, reason: d.reason };
    }
    const out = await runRound({ dry: false, now });
    return { ok: out.ok, woke: out.ok, reason: out.reason || '', result: out };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => { /* 定时任务不许把进程带崩 */ }); }, TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
    logger?.info?.('[bili] 作息已启动（每分钟检查一次，窗口与开关来自 config.bili）');
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, runRound, decision, loadState, loadQuota };
}

module.exports = { createBiliScheduler, TICK_MS };

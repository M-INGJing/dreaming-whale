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
const outbox = require('./outbox');
const shareService = require('./share');
const styleService = require('./style');
const chatDigestService = require('./chatDigest');
const weeklyService = require('./weekly');
const biliWatch = require('../biliWatch');

const TICK_MS = 60 * 1000;

function biliConfig(config) {
  return (config && config.bili) || {};
}

/**
 * 主人多久没说话了（天）。用于「主人沉默太久就不主动分享」：
 * 只读记忆里的私聊消息，不看群；读不到就按 0 天算（宁可不因为读不到而静默）。
 */
function masterSilenceDays(runtime, config, now = new Date()) {
  const names = ((config && config.persona && config.persona.master && config.persona.master.names) || [])
    .map((n) => String(n || '').trim()).filter(Boolean);
  if (!names.length || !runtime || !runtime.store) return 0;
  let last = 0;
  try {
    for (const key of runtime.store.sessions.keys()) {
      if (!String(key).startsWith('wechat:u:')) continue;
      const msgs = runtime.store.messages(key, 50) || [];
      for (const m of msgs) {
        if (!m || m.role !== 'user' || !names.includes(String(m.name || '').trim())) continue;
        const ts = Number(m.ts) || 0;
        if (ts > last) last = ts;
      }
    }
  } catch { return 0; }
  if (!last) return 0;
  return Math.max(0, (now.getTime() - last) / 86400000);
}

/**
 * 主人的 wxid：优先 config.persona.master.wxids；
 * 没填时从记忆里的私聊会话反查（找最近说过话、名字在 master.names 里的那个私聊）。
 * 反查只是「知道该发给谁」，不改配置；分享目标仍然只允许主人私聊或白名单群。
 */
function resolveMasterWxid(runtime, config) {
  const ids = (config && config.persona && config.persona.master && config.persona.master.wxids) || [];
  const configured = String(Array.isArray(ids) ? ids[0] || '' : '').trim();
  if (configured) return configured;
  const names = ((config && config.persona && config.persona.master && config.persona.master.names) || [])
    .map((n) => String(n || '').trim()).filter(Boolean);
  if (!names.length || !runtime || !runtime.store) return '';
  try {
    for (const key of runtime.store.sessions.keys()) {
      if (!String(key).startsWith('wechat:u:')) continue;
      const chatId = String(key).slice('wechat:u:'.length);
      const msgs = runtime.store.messages(key, 20) || [];
      if (msgs.some((m) => m && m.role === 'user' && names.includes(String(m.name || '').trim()))) return chatId;
    }
  } catch { /* 记忆读不到就当没配置 */ }
  return '';
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
  const silenceFn = opts.masterSilenceDays || ((config, now) => masterSilenceDays(runtime, config, now));
  const fetchFeed = opts.fetchFeed || feedService.fetchFeed;
  const readVideo = opts.readVideo || ((config, url, deps) => biliWatch.readVideo(config, url, deps));
  // 读一次拿「摘要 + 结构化热评」：摘要进日记，热评进「评论说话方式」学习。
  // 只注入 readVideo（老测试/老调用方）时，包一层：没有热评就不学风格。
  const readMaterials = opts.readMaterials
    || (opts.readVideo
      ? (async (config, url, deps) => ({ digest: await opts.readVideo(config, url, deps), replies: [] }))
      : ((config, url, deps) => biliWatch.readMaterials(config, url, deps)));
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
    const seen = Array.isArray(raw.seen) ? raw.seen.filter((x) => typeof x === 'string') : [];
    if (raw.date !== today) return { date: today, wakes: 0, skipped: false, lastWakeAt: 0, seen };
    return {
      date: raw.date, wakes: Number(raw.wakes) || 0, skipped: Boolean(raw.skipped),
      lastWakeAt: Number(raw.lastWakeAt) || 0, seen,
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
      jitterMinutes: night.jitterMinutes,
    }, state, now, rng);
    return { ...out, state, night };
  }

  /** 手动/定时跑一轮。dry=true 只看会选什么，不读视频、不写日记、不记账。 */
  async function runRound({ dry = false, now = nowFn(), noShare = false } = {}) {
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
      const stateBefore = loadState(now);
      const ranked = score.rankCandidates(feed.items, prefs, {
        now: now.getTime(),
        limit: maxVideos,
        maxMinutes: Number(night.maxMinutes) || 45,
        // 看过的（跨天记着，最多留 300 条）不再推荐，避免连着几轮都是同一条
        seen: new Set(stateBefore.seen || []),
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
      const repliesPool = [];
      for (let i = 0; i < deep; i += 1) {
        const candidate = ranked[i].candidate;
        let digest = '';
        try {
          const materials = await readMaterials(cfg, candidate.bvid, { logger });
          digest = (materials && materials.digest) || '';
          for (const row of (materials && materials.replies) || []) repliesPool.push(row);
        } catch (err) {
          logger?.warn?.('[bili] 读视频失败 code=' + (err && err.code ? err.code : 'unknown'));
        }
        watched.push({ candidate, digest });
      }
      // 评论区说话方式：只学「气口」，存短语、衰减与上限在 core/bili/style.js
      let styleLearn = null;
      try {
        const biliCfg = biliConfig(cfg);
        if (!biliCfg.style || biliCfg.style.enabled !== false) {
          styleLearn = await styleService.learn({
            config: cfg, llm: runtime && runtime.llm, replies: repliesPool.slice(0, 12), logger, now,
          });
        }
      } catch (err) {
        logger?.warn?.('[bili] 评论风格学习失败：' + ((err && err.code) || 'unknown'));
      }
      // 标题缓存：老日志里只有 BV 号，界面靠它把标题补出来
      try {
        biliStore.mergeTitles(cfg, Object.fromEntries(watched.map((w) => [w.candidate.bvid, w.candidate.title])));
      } catch (err) {
        logger?.warn?.('[bili] 标题缓存写入失败：' + ((err && err.code) || 'io'));
      }
      // 日记不只写视频：把今天聊过的事也带上（只当背景，不让模型复述记录）
      let chatText = '';
      try {
        chatText = chatDigestService.collectDay(runtime, now).text;
      } catch (err) {
        logger?.warn?.('[bili] 聊天素材收集失败：' + ((err && err.code) || 'unknown'));
      }
      const diary = await writeDiary({
        config: cfg, llm: runtime && runtime.llm, logger, date: now, watched, chatDigest: chatText,
      });
      if (diary && diary.skipped) {
        biliStore.appendEvent(cfg, { kind: 'diary_skipped', reason: diary.skipped });
      }
      // 分享：分数够 + 配额够 + 时间间隔够，才入队；桥接会在 30 秒内取走发送。
      // 能力调用（她自己决定逛 B 站）传 noShare=true：只看看、写日记，不往群里发。
      let share = null;
      if (noShare) {
        biliStore.appendEvent(cfg, { kind: 'share_skip', reason: 'no_share' });
      } else {
      try {
        outbox.sweepStale(cfg);
        const best = ranked[0];
        const verdict = outbox.canShare(cfg, {
          score: best ? best.score : 0,
          now,
          silentDays: silenceFn(cfg, now),
          masterWxid: resolveMasterWxid(runtime, cfg),
        });
        if (verdict.ok && best) {
          const items = [];
          // 每个目标一条文案（群更短），同一条视频可以既发主人也发指定群
          for (const target of verdict.targets) {
            const composed = await shareService.composeShare({
              llm: runtime && runtime.llm,
              candidate: best.candidate,
              digest: (watched[0] && watched[0].digest) || '',
              chatType: target.chatType,
              logger,
            });
            const queued = outbox.enqueue(cfg, {
              bvid: best.candidate.bvid,
              title: best.candidate.title,
              cover: bili.share.card === false ? '' : (best.candidate.cover || ''),
              text: composed.text,
              target,
            });
            if (queued.ok) items.push({ id: queued.item.id, chatType: queued.item.chatType, chatId: queued.item.chatId });
          }
          share = items.length ? { ok: true, items } : null;
        } else {
          biliStore.appendEvent(cfg, { kind: 'share_skip', reason: verdict.reason });
        }
      } catch (err) {
        logger?.warn?.('[bili] 分享入队失败：' + ((err && err.code) || 'unknown'));
      }
      }
      const reads = 1 + deep * 3;
      let qa = quota.noteRead(allow.state, reads, now);
      saveQuota(qa);
      const state = loadState(now);
      const seen = Array.from(new Set([...(state.seen || []), ...watched.map((w) => w.candidate.bvid)])).slice(-300);
      const next = { ...state, wakes: state.wakes + 1, lastWakeAt: now.getTime(), seen };
      saveState(next);
      biliStore.appendFeedLog(cfg, now, ranked.map((row) => ({
        bvid: row.candidate.bvid,
        title: row.candidate.title,
        score: Math.round(row.score),
        reasons: row.reasons,
        watched: watched.some((w) => w.candidate.bvid === row.candidate.bvid),
      })));
      biliStore.appendEvent(cfg, {
        kind: 'wake', source: feed.source, picked: ranked.length, watched: watched.map((w) => w.candidate.bvid),
        ownerChars: diary.ownerChars, selfChars: diary.selfChars,
        share: share && share.ok ? 'queued:' + share.items.length : 'none',
      });
      return {
        ok: true, dry: false, source: feed.source,
        picked: ranked.map((row) => row.candidate.bvid), watched: watched.map((w) => w.candidate.bvid),
        // 能力执行时要把「看了哪几条、大概讲了什么」带给下一轮提示词，
        // 否则她只有一句「看了 2 条」，被问内容就只能编。
        watchedInfo: watched.map((w) => ({
          bvid: w.candidate.bvid,
          title: String(w.candidate.title || '').slice(0, 80),
          excerpt: String(w.digest || '').replace(/^【B站视频】[^\n]*\n?/, '').slice(0, 200),
        })),
        diary, share: share && share.ok ? share.items : null,
      };
    } finally {
      running = false;
    }
  }

  async function tick(now = nowFn()) {
    if (running) return { ok: false, reason: 'busy' };
    let d;
    try { d = decision(now); } catch (err) { return { ok: false, reason: 'decision_error' }; }
    // 每周日更新「我最近的状态/口味」：它自己有时间闸（周日 + hour + 本周未更新），
    // 和醒不醒无关；失败只记日志，不影响这一轮。
    let weekly = null;
    try {
      weekly = await weeklyService.maybeUpdate(runtime, { now });
    } catch (err) {
      logger?.warn?.('[bili] 每周小结异常：' + ((err && err.code) || 'unknown'));
    }
    if (!d.wake) {
      if (d.skipped && d.state && !d.state.skipped) {
        const next = { ...d.state, skipped: true };
        saveState(next);
        biliStore.appendEvent(storeConfig(), { kind: 'skip', reason: d.reason });
      }
      return { ok: true, woke: false, reason: d.reason, weekly };
    }
    const out = await runRound({ dry: false, now });
    return { ok: out.ok, woke: out.ok, reason: out.reason || '', result: out, weekly };
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

module.exports = { createBiliScheduler, resolveMasterWxid, TICK_MS };

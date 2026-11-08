'use strict';

/**
 * B 站（只读）的 HTTP 接口：登录状态、扫码登录、登出。
 *
 * 只回状态与二维码图片；cookie 本身永远不出内核。
 * 路由本身受全局安全闸保护（/api/* 默认只许本机，见 http/security.js）。
 */

const features = require('../../infra/features');
const { createBiliLogin } = require('../../services/biliLogin');
const { createBiliScheduler } = require('../../services/bili/scheduler');
const biliStore = require('../../infra/biliStore');
const clock = require('../../core/bili/clock');
const outbox = require('../../services/bili/outbox');
const { json, readBody } = require('../util');

const INSTANCES = new WeakMap();

function forRuntime(runtime) {
  let inst = INSTANCES.get(runtime);
  if (!inst) {
    inst = createBiliLogin({ logger: runtime.logger });
    INSTANCES.set(runtime, inst);
  }
  return inst;
}

function schedulerFor(runtime) {
  if (runtime.biliScheduler) return runtime.biliScheduler;
  const inst = createBiliScheduler({ runtime, logger: runtime.logger });
  runtime.biliScheduler = inst;
  return inst;
}

module.exports = function register(router) {
  router.get('/api/bili/status', async (runtime, req, res) => {
    try {
      const out = await forRuntime(runtime).status(runtime.config);
      const now = new Date();
      const state = schedulerFor(runtime).loadState(now);
      const q = schedulerFor(runtime).loadQuota(now);
      const night = (runtime.config.bili && runtime.config.bili.night) || {};
      return json(res, 200, {
        ok: true,
        enabled: features.isOn(runtime.config, 'bili'),
        ...out,
        today: { date: state.date, wakes: state.wakes, skipped: state.skipped },
        quota: { readHour: q.readHour, readDay: q.readDay, writeDay: q.writeDay },
        windows: clock.normalizeWindows(night.windows),
        nextWakeMinutes: clock.nextWindowIn(night.windows, now),
        night: {
          skipChance: Number(night.skipChance) || 0,
          maxWakesPerDay: Number(night.maxWakesPerDay) || 1,
          jitterMinutes: Number(night.jitterMinutes) || 0,
          maxVideos: Number(night.maxVideos) || 5,
          maxMinutes: Number(night.maxMinutes) || 45,
        },
        risk: {
          readHourly: Number((runtime.config.bili && runtime.config.bili.risk && runtime.config.bili.risk.readHourly)) || 0,
          readDaily: Number((runtime.config.bili && runtime.config.bili.risk && runtime.config.bili.risk.readDaily)) || 0,
        },
        shareCfg: {
          enabled: !(runtime.config.bili && runtime.config.bili.share && runtime.config.bili.share.enabled === false),
          daily: Number(runtime.config.bili && runtime.config.bili.share && runtime.config.bili.share.daily) || 0,
          minGapMinutes: Number(runtime.config.bili && runtime.config.bili.share && runtime.config.bili.share.minGapMinutes) || 0,
          chats: (runtime.config.bili && runtime.config.bili.share && runtime.config.bili.share.chats) || [],
        },
        diary: biliStore.diarySummary(runtime.config, now),
        style: (() => {
          const data = biliStore.readJson(biliStore.paths(runtime.config).style, {});
          return { items: Array.isArray(data.items) ? data.items.length : 0, updatedAt: Number(data.updatedAt) || 0 };
        })(),
        share: (() => {
          const ledger = outbox.readLedger(runtime.config);
          const today = outbox.dayKey(now);
          return { dayCount: ledger.date === today ? ledger.dayCount : 0, lastAt: ledger.lastAt };
        })(),
      });
    } catch (err) {
      runtime.logger.warn('[bili] status 失败 code=' + (err && err.code ? err.code : 'unknown'));
      return json(res, 500, { ok: false, error: '读取 B 站状态失败' });
    }
  });

  // 手动跑一轮：{ dry: true } 只回候选与打分，不读视频、不写日记、不记账。
  router.post('/api/bili/run', async (runtime, req, res) => {
    try {
      const body = await readBody(req).catch(() => ({}));
      const out = await schedulerFor(runtime).runRound({ dry: Boolean(body && body.dry) });
      return json(res, 200, { ok: Boolean(out.ok), ...out });
    } catch (err) {
      runtime.logger.warn('[bili] 手动运行失败 code=' + (err && err.code ? err.code : 'unknown'));
      return json(res, 500, { ok: false, error: '运行失败（网络或配置异常）' });
    }
  });

  // 说话习惯：只给短语与计数，不给评论原文（本来也没存）
  router.get('/api/bili/style', (runtime, req, res) => {
    const data = biliStore.readJson(biliStore.paths(runtime.config).style, {});
    const items = (Array.isArray(data.items) ? data.items : []).slice(0, 50).map((row) => ({
      text: String(row.text || ''), mentions: Number(row.mentions) || 1, lastSeenAt: Number(row.lastSeenAt) || 0,
    }));
    return json(res, 200, { ok: true, items, updatedAt: Number(data.updatedAt) || 0 });
  });

  router.post('/api/bili/style/clear', (runtime, req, res) => {
    biliStore.writeJson(biliStore.paths(runtime.config).style, { updatedAt: Date.now(), items: [] });
    return json(res, 200, { ok: true });
  });
  router.get('/api/bili/diary', (runtime, req, res) => {
    const now = new Date();
    return json(res, 200, { ok: true, summary: biliStore.diarySummary(runtime.config, now) });
  });

  // ---- 桥接取分享（两段式：pending → claim → ack）----
  router.get('/api/bili/pending', (runtime, req, res) => {
    if (!features.isOn(runtime.config, 'bili')) return json(res, 200, { ok: true, item: null, reason: 'disabled' });
    try { outbox.sweepStale(runtime.config); } catch { /* 清理失败不影响取件 */ }
    return json(res, 200, { ok: true, item: outbox.nextPending(runtime.config) });
  });

  router.post('/api/bili/claim', async (runtime, req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String((body && body.id) || '').trim();
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
    const item = outbox.claim(runtime.config, id);
    return json(res, 200, { ok: Boolean(item), item, error: item ? '' : 'not_pending' });
  });

  router.post('/api/bili/ack', async (runtime, req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String((body && body.id) || '').trim();
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
    const status = body.status === 'sent' ? 'sent' : 'failed';
    const out = outbox.ack(runtime.config, id, status, String((body && body.error) || ''));
    return json(res, 200, { ok: Boolean(out.ok), item: out.item || null, error: out.reason || '' });
  });

  router.post('/api/bili/login/qr', async (runtime, req, res) => {
    try {
      const out = await forRuntime(runtime).start(runtime.config);
      const ua = String((req && req.headers && req.headers['user-agent']) || 'none').split('/')[0].slice(0, 24);
      runtime.logger.info('[bili] 二维码已生成（base64 ' + String(out.png || '').length + ' 字符，ua=' + ua + '）');
      return json(res, 200, { ok: true, ...out });
    } catch (err) {
      runtime.logger.warn('[bili] 生成二维码失败 code=' + (err && err.code ? err.code : 'unknown'));
      return json(res, 502, { ok: false, error: '生成二维码失败（网络或 B 站接口异常）', code: (err && err.code) || '' });
    }
  });

  router.post('/api/bili/login/poll', async (runtime, req, res) => {
    try {
      const out = await forRuntime(runtime).pollOnce(runtime.config);
      if (out.state === 'idle') return json(res, 409, { ok: false, state: 'idle', error: '还没有二维码，请先点「扫码登录」' });
      return json(res, 200, { ok: true, ...out });
    } catch (err) {
      runtime.logger.warn('[bili] 轮询失败 code=' + (err && err.code ? err.code : 'unknown'));
      return json(res, 502, { ok: false, state: 'error', error: '轮询登录状态失败（网络异常）' });
    }
  });

  router.post('/api/bili/logout', (runtime, req, res) => {
    forRuntime(runtime).logout(runtime.config);
    return json(res, 200, { ok: true, removed: true });
  });
};

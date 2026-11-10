'use strict';

/**
 * 人格漂移监测的定时调度：每天自动跑一次 drift.analyze，把「她有没有变味」用程序先发现。
 *
 * 依赖全部可注入（analyze / now / 间隔），测试不写盘、不碰真实计时器。
 * 关掉 features.drift 时整轮跳过（仍可手动 node scripts/drift.js）。
 * 分析本身是纯本地文件读取，不联网、不调模型。
 */

const features = require('../infra/features');
const drift = require('./drift');

const DEFAULT_CHECK_MS = 60 * 60 * 1000;   // 每小时看一眼是否到点
const DEFAULT_RUN_MS = 24 * 60 * 60 * 1000; // 每天真正分析一次

function clampMs(v, min, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.floor(n));
}

function createDriftScheduler(opts = {}) {
  const runtime = opts.runtime || null;
  const logger = opts.logger || (runtime && runtime.logger) || null;
  const nowFn = opts.now || (() => Date.now());
  const analyzeFn = opts.analyze || drift.analyze;
  const days = Math.max(1, Math.min(30, Number(opts.days) || 7));
  const checkMs = clampMs(opts.checkMs, 60000, DEFAULT_CHECK_MS);
  const runMs = clampMs(opts.runMs, 3600000, DEFAULT_RUN_MS);

  let timer = null;
  let running = false;
  let lastRun = 0;

  function config() {
    return (runtime && runtime.config) || opts.config || {};
  }

  function enabled() {
    return features.isOn(config(), 'drift');
  }

  /** 到点了就分析一次。同步返回；analyze 只读本地文件，不产生网络/模型开销。 */
  function tick(now = nowFn()) {
    if (running) return { ok: false, reason: 'busy' };
    if (!enabled()) return { ok: false, reason: 'disabled' };
    if (lastRun && now - lastRun < runMs) return { ok: false, reason: 'not_due' };
    const cfg = config();
    if (!cfg || !cfg.paths || !cfg.paths.dataDir) return { ok: false, reason: 'no_data_dir' };
    running = true;
    try {
      const report = analyzeFn(cfg, { days, now });
      lastRun = now;
      if (report && report.hint) logger?.warn?.('[drift] 人格漂移提示：' + report.hint);
      else logger?.info?.('[drift] 人格漂移检查完成（' + ((report && report.days && report.days.length) || 0) + ' 天有数据，健康）');
      return { ok: true, days: report ? report.days.length : 0, hint: report ? report.hint : '' };
    } catch (err) {
      logger?.warn?.('[drift] 检查失败：' + ((err && err.code) || 'unknown'));
      return { ok: false, reason: 'error' };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { try { tick(); } catch { /* 定时任务不许带崩进程 */ } }, checkMs);
    if (typeof timer.unref === 'function') timer.unref();
    // 启动后异步先跑一次（不堵 createRuntime），让 data/drift.json 立刻有值
    setImmediate(() => { try { tick(); } catch { /* 首跑失败不影响 */ } });
    logger?.info?.('[drift] 漂移监测已启动（每 ' + Math.round(runMs / 3600000) + ' 小时自动分析一次）');
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, lastRunAt: () => lastRun };
}

module.exports = { createDriftScheduler, DEFAULT_CHECK_MS, DEFAULT_RUN_MS };

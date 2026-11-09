'use strict';

/**
 * 聊天触发的日记更新：回复优先，闲时才写。
 *
 * 每聊完一轮，按 `bili.diary.chatChance`（默认 0.15）掷一次「等会儿更新日记」；
 * 掷中之后不立刻写，而是等到连续 `chatIdleSeconds`（默认 180 秒）没有新聊天才动笔。
 * 这样不会和回复抢模型，也不打扰正在进行的对话。
 */

const features = require('../../infra/features');
const diaryFormat = require('../../core/bili/diaryFormat');
const diary = require('./diary');
const chatDigest = require('./chatDigest');

function diaryConfig(config) {
  return (config && config.bili && config.bili.diary) || {};
}

function createDiaryIdle(opts = {}) {
  const runtime = opts.runtime;
  const logger = opts.logger || (runtime && runtime.logger) || null;
  const nowFn = opts.now || (() => new Date());
  const rng = opts.rng || Math.random;
  const writeDiary = opts.writeDiary || diary.writeRound;
  const digest = opts.digest || chatDigest;
  const intervalMs = Math.max(5000, Number(opts.intervalMs) || 30000);

  let pendingDate = '';
  let lastActivity = 0;
  let busy = false;
  let timer = null;

  function enabled() {
    return features.isOn(runtime.config, 'bili') && diaryConfig(runtime.config).enabled !== false;
  }

  /** 聊完一轮调用；返回这次是否掷中了「等会儿写」。 */
  function noteActivity(at = nowFn()) {
    const time = at instanceof Date ? at : new Date(at);
    lastActivity = time.getTime();
    if (!enabled()) return false;
    if (pendingDate) return true;
    const cfg = diaryConfig(runtime.config);
    const chance = Math.max(0, Math.min(1, Number(cfg.chatChance === undefined ? 0.15 : cfg.chatChance) || 0));
    if (chance <= 0 || rng() >= chance) return false;
    pendingDate = diaryFormat.today(time);
    logger?.info?.('[bili] 聊天后触发日记更新：等闲下来再写（' + pendingDate + '）');
    return true;
  }

  /** 定时检查：闲够了就写；写的是「今天」那一篇（不新开日期）。 */
  async function tick(at = nowFn()) {
    if (!pendingDate) return { ok: false, skipped: 'idle' };
    if (busy) return { ok: false, skipped: 'busy' };
    if (!enabled()) { pendingDate = ''; return { ok: false, skipped: 'disabled' }; }
    const time = at instanceof Date ? at : new Date(at);
    const cfg = diaryConfig(runtime.config);
    const idleSec = cfg.chatIdleSeconds === undefined
      ? 180
      : Math.max(0, Number(cfg.chatIdleSeconds) || 0);
    if (lastActivity && time.getTime() - lastActivity < idleSec * 1000) {
      return { ok: false, skipped: 'chat_active' };
    }
    busy = true;
    try {
      const digestText = digest.collectDay(runtime, time).text;
      if (!digestText) { pendingDate = ''; return { ok: false, skipped: 'no_chat' }; }
      const out = await writeDiary({
        config: runtime.config,
        llm: runtime.llm,
        logger,
        date: time,
        watched: [],
        chatDigest: digestText,
        source: 'chat',
      });
      pendingDate = '';
      return { ok: Boolean(out && out.rewritten), ...(out || {}) };
    } catch (err) {
      logger?.warn?.('[bili] 聊天日记更新失败：' + ((err && err.code) || 'unknown'));
      return { ok: false, skipped: 'error' };
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => { /* 后台任务不许带崩进程 */ }); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { noteActivity, tick, start, stop, pending: () => pendingDate, lastActivityAt: () => lastActivity };
}

module.exports = { createDiaryIdle, diaryConfig };

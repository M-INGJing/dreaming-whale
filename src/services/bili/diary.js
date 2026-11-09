'use strict';

/**
 * 写日记：它不是「每醒一次追加一段」，而是**每天重写成一篇完整的日记**。
 *
 * 之前每轮各写各的，读起来像几段拼凑：没有时间线、每段都重新开头、同一天的语气跳。
 * 现在每轮把「今天已经写过的内容」+「这一轮新看的视频」一起交给模型，
 * 让它把当天那一节整体重写；没看到新视频就什么都不做（不白烧 token）。
 *
 * 一本给主人（owner.md）：今天看了什么、结论、态度；
 * 一本给自己（self.md）：偏好校准与今天的状态。
 * 有模型时按人设写（一次调用，输出 JSON）；演示模式/失败时用模板。
 */

const path = require('node:path');
const biliStore = require('../../infra/biliStore');
const diaryFormat = require('../../core/bili/diaryFormat');

const SYSTEM = [
  '你在给自己写「今天」的日记，只输出 JSON，不要解释。',
  '格式：{"owner":"...","self":"..."}',
  '',
  '这是**一整天的日记**，不是几条碎片，也不只是「看了什么视频」。要求：',
  '1. owner（写给主人看）：250~600 字，像一天结束后的回望：今天看了什么、聊到过什么、哪句话/哪件事让你有想法或情绪；可以写时间感和心情变化。',
  '2. 聊天素材只当背景：可以自然带一两句「今天跟谁聊到…」「有人说…让我觉得…」，但不要逐条复述聊天记录、不要引用原话、不要编造没发生的事。',
  '3. 如果给了「今天已经写过的内容」，请把它当作草稿：保留仍然重要的细节，自然地接上新内容，不要重复开头、不要重复同一句评价。',
  '4. self（只给自己看）：80~200 字，写今天对自己偏好的新发现、或者今天不想看/不想聊的原因。',
  '5. 两段都用第一人称，语气和平时聊天一致；不要写「用户/主人说」这种第三人称转述；不要用列表/编号。',
].join('\n');

function statePath(config) {
  return path.join(biliStore.paths(config).dir, 'diary', 'state.json');
}

function loadState(config, date) {
  const key = diaryFormat.today(date);
  const raw = biliStore.readJson(statePath(config), {});
  if (!raw || raw.date !== key) return { date: key, written: [], titles: [], rewrites: 0, updatedAt: 0 };
  return {
    date: key,
    written: Array.isArray(raw.written) ? raw.written.filter((x) => typeof x === 'string') : [],
    titles: Array.isArray(raw.titles) ? raw.titles.filter((x) => typeof x === 'string') : [],
    rewrites: Number(raw.rewrites) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

function saveState(config, state) {
  biliStore.writeJson(statePath(config), state);
}

function clockOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function materialsText(watched) {
  const lines = [];
  for (const item of watched || []) {
    const c = item.candidate || {};
    lines.push('《' + (c.title || c.bvid) + '》UP：' + ((c.owner && c.owner.name) || '未知') + ' 时长 ' + Math.round((c.durationSec || 0) / 60) + ' 分钟');
    if (item.digest) lines.push(String(item.digest).slice(0, 900));
    lines.push('');
  }
  return lines.join('\n').trim();
}

function titleLine(titles) {
  const list = (titles || []).filter(Boolean);
  if (!list.length) return '';
  return '今天到目前为止看过的：' + list.map((t) => '《' + t + '》').join('、');
}

function templateOwner(watched, titles, previous, chatDigest = '') {
  const names = (watched || []).map((w) => '《' + ((w.candidate && w.candidate.title) || w.candidate?.bvid || '') + '》').filter(Boolean);
  const head = previous ? String(previous).replace(/\s+$/, '') + ' ' : '';
  const chatPart = chatDigest ? '今天也跟人聊了会儿，有些话挺有意思的。' : '';
  if (!names.length) return (head + chatPart) || '今天没看到什么想说的。';
  const body = '后来又看了 ' + names.join('、') + '，有的还行，有的就是标题党；先记一笔，改天再挑几条真的看完。';
  return (head + chatPart + body).slice(0, 1800);
}

function templateSelf(watched, previous) {
  const likes = (watched || []).map((w) => (w.candidate && w.candidate.title) || '').filter(Boolean).slice(0, 2);
  if (!likes.length) return previous || '今天没什么想看的，就这样。';
  const head = previous ? String(previous).replace(/\s+$/, '') + ' ' : '';
  return (head + '今天又点开 ' + likes.join('；') + '，下次可以多往这个方向找，太吵的题材少看点。').slice(0, 800);
}

function parseModelOutput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (!obj || typeof obj !== 'object') return null;
    const owner = diaryFormat.clean(obj.owner, 2000);
    const self = diaryFormat.clean(obj.self, 1000);
    return owner || self ? { owner, self } : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts { config, llm, logger, date, watched }
 * @returns {Promise<{ownerChars:number,selfChars:number,usedModel:boolean,rewritten:boolean,skipped?:string}>}
 */
async function writeRound(opts = {}) {
  const { config, llm, logger, date = new Date(), watched = [], chatDigest = '' } = opts;
  const source = opts.source === 'chat' ? 'chat' : 'watch';
  const cfg = (config && config.bili && config.bili.diary) || {};
  if (cfg.enabled === false) return { ownerChars: 0, selfChars: 0, usedModel: false, rewritten: false, source, skipped: 'disabled' };
  const state = loadState(config, date);
  const seen = new Set(state.written);
  const fresh = (watched || []).filter((w) => w && w.candidate && !seen.has(w.candidate.bvid));
  const hasChat = Boolean(String(chatDigest || '').trim());
  if (!fresh.length) {
    // 聊天触发的更新：没有新视频也可以把「今天聊到的」写进去，但要和上次更新隔开
    if (source !== 'chat' || !hasChat) {
      return { ownerChars: 0, selfChars: 0, usedModel: false, rewritten: false, source, skipped: 'no_new_video' };
    }
    const gap = Math.max(0, Number(cfg.chatMinGapMinutes) || 0);
    if (gap && state.updatedAt && Date.now() - state.updatedAt < gap * 60000) {
      return { ownerChars: 0, selfChars: 0, usedModel: false, rewritten: false, source, skipped: 'chat_cooldown' };
    }
  }
  const maxRewrites = Math.max(0, Number(cfg.maxRewritesPerDay) || 0);
  if (maxRewrites && state.rewrites >= maxRewrites) {
    return { ownerChars: 0, selfChars: 0, usedModel: false, rewritten: false, source, skipped: 'rewrite_cap' };
  }

  const diaries = biliStore.readDiaries(config);
  const previousOwner = diaryFormat.digestOf(diaries.owner, date, 100000);
  const previousSelf = diaryFormat.digestOf(diaries.self, date, 100000);
  const newTitles = fresh.map((w) => ((w.candidate && w.candidate.title) || (w.candidate && w.candidate.bvid) || '')).filter(Boolean);
  const titles = [...new Set([...state.titles, ...newTitles])].slice(-20);

  let owner = '';
  let self = '';
  let usedModel = false;
  if (llm && !llm.isMock) {
    const material = [
      '日期：' + state.date + '，现在 ' + clockOf(date),
      previousOwner ? '今天已经写过的内容（草稿，请重写成一篇完整的）：\n' + previousOwner.slice(0, 1500) : '今天还没写过。',
      fresh.length ? '这一轮新看的：\n' + materialsText(fresh) : '这一轮没有新视频：主要是聊天，请把聊天里的感想写进去。',
      titleLine(titles),
      chatDigest ? '今天聊到的事（素材：只当背景，不要逐条复述、不要引用原话）：\n' + chatDigest : '',
      previousSelf ? '今天给自己的日记已经写过：' + previousSelf.slice(0, 400) : '',
    ].filter(Boolean).join('\n\n');
    try {
      const raw = await llm.complete({ system: SYSTEM, turns: [{ role: 'user', content: material }] });
      const parsed = parseModelOutput(raw);
      if (parsed) { owner = parsed.owner; self = parsed.self; usedModel = true; }
    } catch (err) {
      logger?.warn?.('[bili] 日记模型失败，用模板：' + ((err && err.code) || 'unknown'));
    }
  }
  if (!owner) owner = templateOwner(fresh, titles, previousOwner, chatDigest);
  if (!self) self = templateSelf(fresh, previousSelf);

  // 当天总字数上限：重写后仍然遵守，防止一天越写越长
  const cap = Math.max(0, Number(cfg.maxCharsPerDay) || 0);
  if (cap && owner.length > cap) owner = owner.slice(0, cap);
  if (cap && self.length > cap) self = self.slice(0, cap);

  const ownerFile = biliStore.writeDiarySection(config, 'owner', date, owner);
  const selfFile = biliStore.writeDiarySection(config, 'self', date, self);
  const next = {
    date: state.date,
    written: [...state.written, ...fresh.map((w) => w.candidate.bvid)].slice(-100),
    titles,
    rewrites: state.rewrites + 1,
    updatedAt: Date.now(),
  };
  saveState(config, next);
  return {
    ownerChars: ownerFile ? owner.length : 0,
    selfChars: selfFile ? self.length : 0,
    usedModel,
    rewritten: true,
    source,
    newCount: fresh.length,
  };
}

module.exports = {
  writeRound, SYSTEM, materialsText, titleLine, templateOwner, templateSelf,
  parseModelOutput, loadState, clockOf,
};

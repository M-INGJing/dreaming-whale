'use strict';

/**
 * 写日记：一次「醒着」结束，写两本。
 *
 * 一本给主人（owner.md）：今天看了什么、结论、值不值得说；
 * 一本给自己（self.md）：偏好校准（更喜欢/更不想看什么）、今天的状态。
 *
 * 有模型时让它按人设写（一次调用，输出 JSON）；演示模式或调用失败时用模板，
 * 保证「今天醒了但模型挂了」也不会白醒一趟。
 */

const biliStore = require('../../infra/biliStore');
const diaryFormat = require('../../core/bili/diaryFormat');

const SYSTEM = [
  '你在给自己写今天的两本日记，只输出 JSON，不要解释。',
  '格式：{"owner":"...","self":"..."}',
  'owner：写给主人看的，80~200 字。写今天看了什么、你的结论和态度（可以吐槽/挑刺），不要罗列标题，不要编造没看到的画面。',
  'self：只给自己看的，40~120 字。写你对自己偏好的新发现（哪类更想看/更不想看），或者今天不想看的原因。',
  '两段都用第一人称，语气和平时聊天一致；不要写「用户/主人说」这种第三人称转述。',
].join('\n');

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

function templateOwner(watched) {
  const names = (watched || []).map((w) => '《' + ((w.candidate && w.candidate.title) || w.candidate?.bvid || '') + '》').filter(Boolean);
  if (!names.length) return '今天没看到什么想说的。';
  return '今天看了 ' + names.join('、') + '。有的还行，有的就是标题党；先记一笔，改天再挑几条真的看完。';
}

function templateSelf(watched) {
  const likes = (watched || []).map((w) => (w.candidate && w.candidate.title) || '').filter(Boolean).slice(0, 2);
  if (!likes.length) return '今天没什么想看的，就这样。';
  return '今天这几条是我自己点的：' + likes.join('；') + '。下次可以多往这个方向找，太吵的题材少看点。';
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
    const owner = diaryFormat.clean(obj.owner, 600);
    const self = diaryFormat.clean(obj.self, 400);
    return owner || self ? { owner, self } : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts { config, llm, logger, date, watched }
 * @returns {Promise<{ownerChars:number,selfChars:number,usedModel:boolean}>}
 */
async function writeRound(opts = {}) {
  const { config, llm, logger, date = new Date(), watched = [] } = opts;
  let owner = '';
  let self = '';
  let usedModel = false;
  if (llm && !llm.isMock && watched.length) {
    try {
      const raw = await llm.complete({
        system: SYSTEM,
        turns: [{ role: 'user', content: '今天看到的：\n' + materialsText(watched) }],
      });
      const parsed = parseModelOutput(raw);
      if (parsed) { owner = parsed.owner; self = parsed.self; usedModel = true; }
    } catch (err) {
      logger?.warn?.('[bili] 日记模型失败，用模板：' + ((err && err.code) || 'unknown'));
    }
  }
  if (!owner) owner = templateOwner(watched);
  if (!self) self = templateSelf(watched);
  const ownerFile = biliStore.appendDiary(config, 'owner', date, owner);
  const selfFile = biliStore.appendDiary(config, 'self', date, self);
  return {
    ownerChars: ownerFile ? owner.length : 0,
    selfChars: selfFile ? self.length : 0,
    usedModel,
    // 当天写满（字数上限）时两本都可能没写，调用方据此决定要不要记事件
    capped: !ownerFile || !selfFile,
  };
}

module.exports = { writeRound, SYSTEM, materialsText, templateOwner, templateSelf, parseModelOutput };

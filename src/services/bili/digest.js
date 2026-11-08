'use strict';

/**
 * P2.5：聊天里问「今天看了啥」时，把当天日记摘要注入最后一轮。
 *
 * 只在 features.bili 打开、且这句话确实是在问日记/视频时才注入；
 * 只注入「当天那一节」的摘要（默认 ≤300 字），不是全文，避免每轮都烧 token。
 */

const features = require('../../infra/features');
const biliStore = require('../../infra/biliStore');
const diaryFormat = require('../../core/bili/diaryFormat');

const ASK_RE = /(今天|今日|刚才|刚刚)?[^。！？!?\n]{0,8}(看了|看啥|看什么|刷了|刷啥|刷什么|日记|b\s*站|哔哩)|(看了|刷了)[^。！？!?\n]{0,6}(什么|啥)/i;
const NEGATIVE_RE = /(不要|别|不用|关闭|取消).{0,6}(日记|b\s*站|哔哩)/i;

/** 这句话是不是在问「她今天看了什么」。 */
function isDiaryQuestion(text) {
  const s = String(text || '');
  if (!s || s.length > 200) return false;
  if (NEGATIVE_RE.test(s)) return false;
  return ASK_RE.test(s);
}

/** 当天摘要（字数上限来自 bili.diary.digestTokens，按 1 token≈0.65 汉字折算）。 */
function todayDigest(config, now = new Date()) {
  const cfg = (config && config.bili) || {};
  const diaryCfg = cfg.diary || {};
  if (diaryCfg.enabled === false) return '';
  const tokens = Math.max(50, Math.min(2000, Number(diaryCfg.digestTokens) || 200));
  const maxChars = Math.max(80, Math.round(tokens / 0.65));
  const { owner } = biliStore.readDiaries(config);
  return diaryFormat.digestOf(owner, now, maxChars);
}

/** 拼成提示词那一块；不该注入时返回 ''。 */
function blockFor(config, text, now = new Date()) {
  if (!features.isOn(config, 'bili')) return '';
  if (!isDiaryQuestion(text)) return '';
  const digest = todayDigest(config, now);
  if (!digest) return '';
  return [
    '【她今天看过的 B 站（日记摘要）】',
    digest,
    '说到这些内容时像自己看过一样自然，别念摘要、别假装看过画面（只看了页面信息/字幕/热评）。',
  ].join('\n');
}

module.exports = { isDiaryQuestion, todayDigest, blockFor, ASK_RE };

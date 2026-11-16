'use strict';

/**
 * 文本处理纯函数：清洗、匹配、时间格式化、数值收敛。
 * 不依赖任何 IO，便于单测。
 */

/** 清洗可能触发模型内容审核的词，避免整段请求被 400 拒掉 */
const SENSITIVE_PATTERNS = [
  /操(你|他|她|你妈|你妈逼)?/g, /你妈/g, /妈的/g, /他妈/g, /傻逼/gi, /傻B/gi, /煞笔/g,
  /草泥马/g, /尼玛/g, /性交/g, /做爱/g, /色情/g, /黄片/g, /裸(照|聊)?/g, /约炮/g, /嫖/g,
];

function sanitizeForModel(text) {
  let s = String(text == null ? '' : text);
  for (const re of SENSITIVE_PATTERNS) s = s.replace(re, '***');
  return s;
}

/** 群名匹配：忽略大小写/空格，允许「鼠标」匹配「鼠标那个群」这种写法 */
function nameMatches(a, b) {
  const x = String(a || '').replace(/\s+/g, '').toLowerCase();
  const y = String(b || '').replace(/\s+/g, '').toLowerCase();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * 消息时间戳 [MM-DD HH:mm]：提示词里每条历史消息前面的那个标记。
 * 必须确定性：同一个 ts，不管当「当前消息」还是当「历史消息」，渲染结果一样。
 * 用本地时区手写补零，不走 toLocaleString（不同 ICU 版本格式会飘）。
 */
function formatStamp(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 只留文字，用来比较「是不是把对方的话重复了一遍」 */
function normalizeForCompare(s) {
  return String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

// 高频虚词 / 语气字：做主题词时会造出「的了 / 了吗 / 不是」这类语法碎片，必须剔除。
// 只保留「内容字」，才能把「语音 / 项目 / 酸菜」这种真主题从虚词噪音里分出来。
const CJK_STOP = new Set([
  '的', '了', '呢', '吗', '吧', '啊', '哦', '嗯', '呀', '嘛', '哈', '啦',
  '不', '没', '就', '都', '也', '很', '还', '又', '再', '才', '刚', '正', '最', '更', '太', '挺',
  '是', '有', '在', '到', '对', '从', '被', '把', '让', '给', '过', '和', '与', '或', '但', '而', '且',
  '所', '以', '因', '为', '如', '果', '然', '则',
  '这', '那', '我', '你', '他', '她', '它', '们', '什', '怎', '哪', '谁', '几', '多', '少', '个', '只', '些',
  '会', '能', '可', '该', '要', '想', '说', '去', '来', '上', '下', '里', '外', '中', '前', '后',
  '今', '明', '昨', '天', '点', '时', '分', '秒', '次', '回', '遍',
]);

/**
 * 抽一段文本的「主题词」：拉丁/数字词 + 中文内容 bigram。
 * 中文不引分词库，用「两个连续内容字」近似主题（「语音」「项目」「酸菜」都能落到 bigram 上），
 * 任一字符是虚词就跳过，避免把「的吗」「了呢」当成主题。
 */
function topicTokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9]{3,}/g) || []) out.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 1 < cjk.length; i += 1) {
    const a = cjk[i];
    const b = cjk[i + 1];
    if (!CJK_STOP.has(a) && !CJK_STOP.has(b)) out.add(a + b);
  }
  return [...out];
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

module.exports = {
  SENSITIVE_PATTERNS,
  sanitizeForModel,
  nameMatches,
  formatStamp,
  normalizeForCompare,
  topicTokens,
  CJK_STOP,
  clampInt,
};

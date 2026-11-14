'use strict';

/**
 * 长正文摘要的前置：按预算整句截断，不切半句，并标记「已截断」。
 * 用在链接正文注入提示词之前，避免几万字整段塞进去、或被硬裁成半句话。
 * 纯函数，方便单测。
 */

const SENTENCE_END = new Set(['。', '！', '？', '；', '\n', '!', '?', ';']);

/**
 * @param {string} text 原始正文
 * @param {{maxChars?:number}} [opts] 预算（按码点）
 * @returns {{text:string, truncated:boolean}}
 */
function trimToBudget(text, { maxChars = 1200 } = {}) {
  const chars = Array.from(String(text || ''));
  const budget = Math.max(0, Number(maxChars) || 1200);
  if (chars.length <= budget) return { text: String(text || ''), truncated: false };
  // 先硬裁到预算，再回退到最近的句末标点（回退不要太狠，否则丢了太多正文）
  const head = chars.slice(0, budget);
  let cut = budget;
  for (let i = budget - 1; i >= Math.floor(budget * 0.6); i -= 1) {
    if (SENTENCE_END.has(head[i])) { cut = i + 1; break; }
  }
  return { text: chars.slice(0, cut).join(''), truncated: true };
}

module.exports = { trimToBudget, SENTENCE_END };

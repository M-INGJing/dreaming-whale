'use strict';

const { normalizeForCompare, topicTokens } = require('./text');

/**
 * 判断回复是不是在复读对方刚说的话（原样重复 / 只加个问号 / 短句高度重合）。
 */
function isEcho(reply, heard) {
  const a = normalizeForCompare(reply);
  const b = normalizeForCompare(heard);
  if (!a || !b) return false;
  if (a === b) return b.length >= 2;
  // 以对方的话开头、只多几个字（「好蠢」→「好蠢啊」）
  if (b.length >= 2 && a.startsWith(b) && a.length - b.length <= 3) return true;
  // 把对方整句包进来，只多了几个字
  if (b.length >= 3 && a.includes(b) && a.length - b.length <= 3) return true;
  if (a.length >= 3 && b.includes(a) && b.length - a.length <= 2) return true;
  // 只把对方的形容词退回去（「你才蠢」）也算偷懒式复读
  if (/^你(才|也|更是)[\u4e00-\u9fff]{1,6}$/.test(a)) return true;
  if (a.length >= 4 && b.length >= 4 && a.length <= 14 && b.length <= 14) {
    let same = 0;
    for (const ch of a) if (b.includes(ch)) same += 1;
    if (same / Math.max(a.length, b.length) >= 0.8) return true;
  }
  return false;
}

/* ------------------------------ 话题级去重 ------------------------------ */

// 「追问」的特征：带问号 / 疑问语气词 / 疑问代词。陈述式的正常接续不拦，避免误伤
// 「项目文档我发你了」这类给信息的句子。
const ASK_RE = /[?？]|吗|呢|怎么|为什么|为啥|是不是|要不要|有没有|能不能|什么时候|啥时候/;

/**
 * 话题级重复：她最近自己提过的主题词，这次回复又以「追问」的姿态重新提起，
 * 而对方最近的输入里没有任何一个内容 bigram 和这次回复重合——即对方没接这个话茬，
 * 她却把「刚问过的事」换说法又翻出来问一遍。
 * 字面 echo 拦不住换说法，这里补一层语义信号（部分拦，纯语义重复仍由提示词兜底）。
 */
function reasksTopic(reply, ownRecent, heardRecent) {
  const replyText = String(reply || '');
  if (!ASK_RE.test(replyText)) return false;
  const rt = topicTokens(replyText);
  if (!rt.length) return false;
  const own = new Set();
  for (const s of ownRecent || []) for (const t of topicTokens(s)) own.add(t);
  if (!own.size) return false;
  if (!rt.some((t) => own.has(t))) return false;
  // 对方最近的输入里只要和这次回复有任一内容 bigram 重合，就算「对方在这条线上」，
  // 她是在接话而不是无端重提；否则就是她把刚问过、对方没接的话茬又翻出来问。
  const user = new Set();
  for (const s of heardRecent || []) for (const t of topicTokens(s)) user.add(t);
  return !rt.some((t) => user.has(t));
}

module.exports = { isEcho, topicTokens, reasksTopic };

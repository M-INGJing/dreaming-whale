'use strict';

/**
 * 聊天里注入的 B 站相关块（都放在最后一条 user 消息里，不塞 system）：
 *  1) 日记摘要：只在问「今天看了啥」时出现（P2.5）；
 *  2) 评论区说话习惯：打开 B 站开关时一直可注入，但最多 3 条、明确写「别堆砌」。
 *
 * 任何一块都不改人设、不改记忆；关掉 features.bili 时整块为空。
 */

const features = require('../../infra/features');
const digest = require('./digest');
const style = require('./style');
const weekly = require('./weekly');

function blocks(config, text, now = new Date()) {
  if (!features.isOn(config, 'bili')) return '';
  const parts = [];
  try {
    const d = digest.blockFor(config, text, now);
    if (d) parts.push(d);
  } catch { /* 日记读不出来不影响回复 */ }
  try {
    const w = weekly.blockFor(config, now);
    if (w) parts.push(w);
  } catch { /* 周小结读不出来不影响回复 */ }
  try {
    const s = style.blockFor(config, now);
    if (s) parts.push(s);
  } catch { /* 风格读不出来不影响回复 */ }
  return parts.join('\n\n');
}

module.exports = { blocks, digest, style, weekly };

'use strict';

/**
 * few-shot 从真实对话抽样：把「主人没纠正过的回复」当成说话示例，替代硬编码的那 4 组。
 *
 * 判「没纠正」的启发式：一条 assistant 回复，紧接着的下一条 user 消息不是纠正语
 * （「别说 / 重说 / 换个说法…」），就算主人（或其他人）没纠正它；回复后面没有下一条
 * 就保守算「没纠正」。只挑满足质量门槛的（长度适中、无 AI 味、无 [[cap]]/[[sticker]] 标记）。
 *
 * 结果按 dataDir 缓存：few-shot 是静态前缀的一部分，进程内必须稳定，否则前缀缓存失效；
 * 抽不到或不足就返回 null，由调用方回退硬编码 exampleLines()。
 */

const fs = require('node:fs');
const path = require('node:path');

const AI_WORDS = ['作为一个 AI', '语言模型', '希望这能帮到你', '还有什么可以帮', '总的来说', '首先，', '其次，'];
// 纠正语（针对「鲸鲸说话方式」的负面反馈），只看开头
const CORRECTION_RE = /^(别说|别这么|别用|别学|重说|重新说|换个说法|换个语气|正常点|别装|别复读|太假|像个人|说人话|好好说|你这(话|说的)|不要这(样|么)说)/;

/** 是否一条纠正语 */
function isCorrection(text) {
  return CORRECTION_RE.test(String(text || '').trim());
}

/** user 提问是否合格：非空、不是纯表情 */
function goodUser(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\s，。！？!?.,、]+$/u.test(t)) return false;
  return true;
}

/** assistant 回复是否合格：长度适中、无 AI 味、无能力/表情包标记、无 10 位以上连续数字 */
function goodAssistant(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const len = Array.from(t).length;
  if (len < 4 || len > 60) return false;
  if (t.includes('[[')) return false;
  if (/^\//.test(t)) return false;
  if (AI_WORDS.some((w) => t.includes(w))) return false;
  if (/\d{10,}/.test(t)) return false;
  return true;
}

/**
 * 从一条消息序列里抽「user → assistant」对（只保留没被纠正的）。纯函数，可测。
 * @param {Array<{role:string,text:string,ts?:number,seq?:number}>} messages
 * @param {{maxPairs?:number, rng?:()=>number}} opts
 * @returns {Array<{user:string, assistant:string}>}
 */
function pickPairs(messages, opts = {}) {
  const list = (messages || [])
    .filter((m) => m && m.role && typeof m.text === 'string')
    .sort((a, b) => ((Number(a.ts) || 0) - (Number(b.ts) || 0)) || ((Number(a.seq) || 0) - (Number(b.seq) || 0)));
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].role !== 'assistant') continue;
    const prev = list[i - 1];
    const next = list[i + 1];
    if (!prev || prev.role !== 'user') continue;
    if (next && next.role === 'user' && isCorrection(next.text)) continue;
    if (!goodUser(prev.text) || !goodAssistant(list[i].text)) continue;
    out.push({ user: String(prev.text).trim(), assistant: String(list[i].text).trim() });
  }
  const n = Math.max(0, Number(opts.maxPairs) || 4);
  if (out.length <= n) return out;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  // 保留最近的（更贴近当前状态），其余按 rng 抽满 n
  const tail = out.slice(-n);
  const head = out.slice(0, -n);
  while (tail.length < n && head.length) {
    const idx = Math.floor(rng() * head.length);
    tail.unshift(head.splice(idx, 1)[0]);
  }
  return tail;
}

/** 读所有会话的 messages.jsonl，抽候选对（每会话只看最近 perChat 条） */
function collect(config, opts = {}) {
  const dataDir = (config && config.paths && config.paths.dataDir) || '';
  if (!dataDir) return [];
  const dir = path.join(dataDir, 'memory', 'chats');
  let dirs;
  try {
    dirs = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const perChat = Math.max(50, Number(opts.perChat) || 200);
  const pairs = [];
  for (const d of dirs) {
    const file = path.join(dir, d, 'messages.jsonl');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const msgs = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let m;
      try {
        m = JSON.parse(s);
      } catch {
        continue;
      }
      if (m && m.role && typeof m.text === 'string') msgs.push(m);
    }
    for (const p of pickPairs(msgs.slice(-perChat), opts)) pairs.push(p);
  }
  return pairs;
}

let _cache = { key: '', lines: null };

/** 抽不到返回 null（调用方回退硬编码 exampleLines）。按 dataDir 缓存。 */
function sample(config, opts = {}) {
  const key = (config && config.paths && config.paths.dataDir) || '';
  if (_cache.key === key) return _cache.lines;
  const pairs = collect(config, opts);
  const maxPairs = Math.max(1, Number(opts.maxPairs) || 4);
  // 保留最近的（更贴近当前状态）；随机化留给 collect 内部的 pickPairs
  const chosen = pairs.slice(-maxPairs);
  let lines = null;
  if (chosen.length) {
    lines = ['【说话示例（只学语气，别照抄）】'];
    for (const p of chosen) {
      lines.push('对方：' + p.user, '你：' + p.assistant);
    }
  }
  _cache = { key, lines };
  return lines;
}

/** 测试用：清缓存 */
function reset() {
  _cache = { key: '', lines: null };
}

module.exports = { pickPairs, isCorrection, collect, sample, reset, goodUser, goodAssistant, AI_WORDS };

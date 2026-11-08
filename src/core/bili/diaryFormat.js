'use strict';

/**
 * 两本日记的渲染（纯函数）：一本给主人看，一本给自己（偏好校准）。
 *
 * 只负责「长什么样」；写文件、调模型都在 services/bili/diary.js。
 * 约定：一天一节，`## YYYY-MM-DD` 开头，便于按节统计与截取当天摘要。
 */

const DAY_HEADING = /^## (\d{4}-\d{2}-\d{2})\s*$/;

function today(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function clean(text, max = 1200) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 一节：标题 + 段落；空内容返回 ''（不写空节）。 */
function section(date, body) {
  const text = clean(body);
  if (!text) return '';
  return '## ' + today(date) + '\n\n' + text + '\n';
}

/** 当天摘要（≤ maxChars），给聊天里「你今天看了啥」用；不是全文。 */
function digestOf(markdown, date, maxChars = 200) {
  const text = String(markdown || '');
  const lines = text.split('\n');
  const key = today(date);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = DAY_HEADING.exec(lines[i].trim());
    if (m && m[1] === key) { start = i; break; }
  }
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (DAY_HEADING.test(lines[i].trim())) break;
    out.push(lines[i]);
  }
  const body = out.join('\n').trim();
  if (!body) return '';
  return body.length > maxChars ? body.slice(0, maxChars) + '…' : body;
}

/** 当天节数统计（用于状态页只回计数）。 */
function countDays(markdown) {
  return String(markdown || '').split('\n').filter((line) => DAY_HEADING.test(line.trim())).length;
}

module.exports = { today, section, digestOf, countDays, DAY_HEADING, clean };

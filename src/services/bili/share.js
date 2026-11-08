'use strict';

/**
 * 分享文案：给主人（或白名单群）发一条「看了什么 + 值不值得看」。
 *
 * 群里的文案要更短（默认 ≤60 字，别刷屏）；私聊可以到 200 字。
 * 有模型时让它写，失败就用模板——分享是锦上添花，不能因为模型挂了就丢。
 */

const linkOf = (bvid) => 'https://www.bilibili.com/video/' + bvid + '/';

const GROUP_SYSTEM = [
  '你在群里分享一个刚看的 B 站视频，只输出一句分享文案，不要解释。',
  '要求：不超过 60 字，带一句你的态度（好看/一般/避雷），最后附视频链接；不要用「我发现」「推荐给大家」这种播报腔。',
].join('\n');

const OWNER_SYSTEM = [
  '你在给主人分享一个刚看的 B 站视频，只输出分享文案，不要解释。',
  '要求：不超过 200 字；先说值不值得看（一句话），再补一句你自己的想法或吐槽；最后附视频链接。不要复述简介。',
].join('\n');

function template(candidate, chatType) {
  const title = String((candidate && candidate.title) || '').trim();
  const bvid = String((candidate && candidate.bvid) || '').trim();
  const link = bvid ? linkOf(bvid) : '';
  const head = title ? '《' + title + '》' : '刚看了个视频';
  const body = chatType === 'group'
    ? head + ' 还行，值得点开看看 ' + link
    : head + ' 看完了，值不值得看你自己判断；我觉得还行。' + link;
  return body.trim();
}

async function composeShare({ llm, candidate, digest, chatType = 'private', logger } = {}) {
  const fallback = template(candidate, chatType);
  if (!llm || llm.isMock || !candidate) return { text: fallback, usedModel: false };
  try {
    const system = chatType === 'group' ? GROUP_SYSTEM : OWNER_SYSTEM;
    const material = [
      '标题：' + (candidate.title || ''),
      'UP：' + ((candidate.owner && candidate.owner.name) || '未知'),
      '时长：' + Math.round((Number(candidate.durationSec) || 0) / 60) + ' 分钟',
      '链接：' + linkOf(candidate.bvid),
      digest ? '你看到的内容：\n' + String(digest).slice(0, 900) : '',
    ].filter(Boolean).join('\n');
    const raw = await llm.complete({ system, turns: [{ role: 'user', content: material }] });
    const text = String(raw || '').trim().replace(/^["“]|["”]$/g, '').trim();
    if (!text) return { text: fallback, usedModel: false };
    const max = chatType === 'group' ? 80 : 260;
    const clipped = text.length > max ? text.slice(0, max) : text;
    const withLink = clipped.includes(candidate.bvid) ? clipped : clipped + ' ' + linkOf(candidate.bvid);
    return { text: withLink.slice(0, 300), usedModel: true };
  } catch (err) {
    logger?.warn?.('[bili] 分享文案模型失败，用模板：' + ((err && err.code) || 'unknown'));
    return { text: fallback, usedModel: false };
  }
}

module.exports = { composeShare, template, linkOf, GROUP_SYSTEM, OWNER_SYSTEM };

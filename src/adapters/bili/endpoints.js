'use strict';

/**
 * B 站只读接口的「归一化层」：把上游结构收成鲸鲸自己能用的形状。
 *
 * 只做读：视频元信息、字幕、热评。写操作（点赞/评论/私信）第一版不做。
 * 所有函数都接受 createClient() 的实例，测试里换成假 client 即可离线跑。
 */

const { BiliError } = require('./wbi');

const BVID_RE = /(BV[0-9A-Za-z]{10})/;
const MAX_DESC = 2000;
const MAX_SUBTITLE = 12000;
const MAX_REPLIES = 5;
const MAX_REPLY_CHARS = 120;

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 字幕要保留换行（每句一行），只压水平空白与超长，不把整段压成一行。 */
function clipBlock(value, max) {
  const s = String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 从任意文本里取 BV 号（支持完整链接、带参数的链接、纯 BV）。 */
function parseBvid(input) {
  const text = String(input || '').trim();
  const m = text.match(BVID_RE);
  return m ? m[1] : '';
}

/** 视频元信息（需要 WBI 签名；未登录也能读公开视频）。 */
async function view(client, bvid) {
  const id = parseBvid(bvid);
  if (!id) throw new BiliError('没有识别到 BV 号', 'bvid_invalid');
  const body = await client.request('/x/web-interface/wbi/view', { bvid: id }, { needWbi: true });
  const d = body && body.data;
  if (!d || !d.bvid) throw new BiliError('视频信息为空（可能已删除或仅限登录）', 'view_empty');
  return {
    bvid: d.bvid,
    aid: Number(d.aid) || 0,
    cid: Number(d.cid) || 0,
    title: clip(d.title, 120),
    desc: clip(d.desc, MAX_DESC),
    durationSec: Number(d.duration) || 0,
    owner: { mid: String(d.owner?.mid || ''), name: clip(d.owner?.name, 40) },
    pubdate: Number(d.pubdate) || 0,
    stat: {
      view: Number(d.stat?.view) || 0,
      like: Number(d.stat?.like) || 0,
      reply: Number(d.stat?.reply) || 0,
      danmaku: Number(d.stat?.danmaku) || 0,
    },
    cover: String(d.pic || ''),
  };
}

/** 字幕：优先中文字幕，取不到返回 { text: '', lang: '' }（不是错误）。 */
async function subtitle(client, bvid, cid) {
  const id = parseBvid(bvid);
  if (!id || !cid) return { text: '', lang: '', reason: 'no_cid' };
  let body;
  try {
    body = await client.request('/x/player/wbi/v2', { bvid: id, cid }, { needWbi: true });
  } catch (err) {
    if (err instanceof BiliError) return { text: '', lang: '', reason: 'player_failed' };
    throw err;
  }
  const list = body?.data?.subtitle?.subtitles;
  if (!Array.isArray(list) || !list.length) return { text: '', lang: '', reason: 'no_subtitle' };
  const pick = list.find((s) => /^zh/i.test(String(s.lan || ''))) || list[0];
  const raw = String(pick.subtitle_url || '');
  if (!raw) return { text: '', lang: '', reason: 'no_url' };
  const url = raw.startsWith('//') ? 'https:' + raw : raw;
  const data = await client.request(url, {}, {});
  const lines = Array.isArray(data?.body) ? data.body : [];
  const text = lines.map((line) => String(line?.content || '')).filter(Boolean).join('\n');
  return { text: clipBlock(text, MAX_SUBTITLE), lang: String(pick.lan || ''), reason: text ? '' : 'empty_subtitle' };
}

/** 热评（不需要 WBI；失败当作没有，不阻塞总结）。 */
async function hotReplies(client, aid, limit = MAX_REPLIES) {
  if (!aid) return [];
  try {
    const body = await client.request('/x/v2/reply', { type: 1, oid: aid, sort: 2, ps: Math.min(20, limit), pn: 1 });
    const list = body?.data?.replies;
    if (!Array.isArray(list)) return [];
    return list.slice(0, limit).map((row) => ({
      author: clip(row?.member?.uname, 20),
      text: clip(row?.content?.message, MAX_REPLY_CHARS),
      like: Number(row?.like) || 0,
    })).filter((row) => row.text);
  } catch {
    return [];
  }
}

/** 一次取齐「看一个视频」需要的材料；字幕/热评失败只降级，不整体失败。 */
async function watchMaterials(client, input) {
  const info = await view(client, input);
  const [subs, replies] = await Promise.all([
    subtitle(client, info.bvid, info.cid).catch(() => ({ text: '', lang: '', reason: 'error' })),
    hotReplies(client, info.aid).catch(() => []),
  ]);
  return { info, subtitle: subs, replies };
}

module.exports = {
  parseBvid, view, subtitle, hotReplies, watchMaterials,
  MAX_DESC, MAX_SUBTITLE, MAX_REPLIES, MAX_REPLY_CHARS,
};

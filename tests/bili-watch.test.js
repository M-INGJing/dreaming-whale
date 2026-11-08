'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const biliWatch = require('../src/services/biliWatch');
const persona = require('../src/persona');

const INFO = {
  bvid: 'BV1xx411c7mD',
  title: '标题',
  desc: '这是一个简介',
  durationSec: 213,
  owner: { name: '某UP' },
  stat: { view: 108228680, like: 2974033 },
};

function materials(overrides = {}) {
  return {
    info: { ...INFO, ...(overrides.info || {}) },
    subtitle: overrides.subtitle !== undefined ? overrides.subtitle : { text: '第一句\n第二句', lang: 'zh-CN' },
    replies: overrides.replies !== undefined ? overrides.replies : [
      { author: 'A', text: '好看' }, { author: 'B', text: '再来一遍' }, { author: 'C', text: '第三条不该出现' },
    ],
  };
}

test('isVideoUrl：只认 bilibili.com 视频页，b23 短链与专栏都不算', () => {
  assert.equal(biliWatch.isVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=1&t=2'), true);
  assert.equal(biliWatch.isVideoUrl('https://bilibili.com/video/BV1GJ411x7h7'), true);
  assert.equal(biliWatch.isVideoUrl('https://b23.tv/abc123'), false, '短链需要跟跳转，P0.5 再做');
  assert.equal(biliWatch.isVideoUrl('https://www.bilibili.com/read/cv123'), false);
  assert.equal(biliWatch.isVideoUrl('https://example.com/video/BV1GJ411x7h7'), false);
  assert.equal(biliWatch.isVideoUrl(''), false);
});

test('buildDigest：标题/UP/时长/播放/简介/字幕/热评都在，热评只留 2 条', () => {
  const text = biliWatch.buildDigest(materials());
  assert.ok(text.startsWith('【B站视频】标题'));
  assert.match(text, /UP：某UP/);
  assert.match(text, /时长 3:33/);
  assert.match(text, /播放 1\.1亿/);
  assert.match(text, /点赞 297\.4万/);
  assert.match(text, /简介：这是一个简介/);
  assert.match(text, /字幕摘录：第一句/);
  assert.match(text, /A：好看/);
  assert.match(text, /B：再来一遍/);
  assert.doesNotMatch(text, /第三条不该出现/);
});

test('buildDigest：没有字幕时明确说「没看到画面」，不假装看懂', () => {
  const text = biliWatch.buildDigest(materials({ subtitle: { text: '', reason: 'no_subtitle' } }));
  assert.match(text, /没有字幕/);
  assert.match(text, /没看到画面/);
  assert.doesNotMatch(text, /字幕摘录/);
});

test('buildDigest：整段不超过提示词上限（1200 字），超长会被截断并加省略号', () => {
  const text = biliWatch.buildDigest(materials({
    subtitle: { text: '很长的字幕'.repeat(2000) },
    info: { title: 'T'.repeat(2000), desc: 'x'.repeat(5000) },
  }));
  assert.ok(text.length <= biliWatch.DIGEST_MAX + 1, '实际长度 ' + text.length);
  assert.ok(text.endsWith('…'));
});

test('buildDigest：字幕摘录单独限长（700 字），不会把整段字幕塞进提示词', () => {
  const text = biliWatch.buildDigest(materials({ subtitle: { text: '字'.repeat(5000) } }));
  const line = text.split('\n').find((l) => l.startsWith('字幕摘录：')) || '';
  assert.ok(line.length <= biliWatch.SUBTITLE_EXCERPT + 6, '字幕行 ' + line.length);
});

test('readVideo：注入假 client/watchMaterials，离线返回 digest', async () => {
  const out = await biliWatch.readVideo({}, 'https://www.bilibili.com/video/BV1xx411c7mD', {
    client: {}, watchMaterials: async (client, bvid) => { assert.equal(bvid, 'BV1xx411c7mD'); return materials(); },
  });
  assert.match(out, /^【B站视频】标题/);
});

test('readVideo：读不到（抛错）时返回空串并记录结构信息，不影响回复', async () => {
  const warns = [];
  const out = await biliWatch.readVideo({}, 'https://www.bilibili.com/video/BV1xx411c7mD', {
    client: {},
    logger: { warn: (line) => warns.push(line) },
    watchMaterials: async () => { const err = new Error('boom'); err.code = 'bili_api_-404'; throw err; },
  });
  assert.equal(out, '');
  assert.deepEqual(warns, ['[bili] 读取视频失败 code=bili_api_-404']);
  assert.equal(JSON.stringify(warns).includes('BV1xx411c7mD'), false, '日志不带 URL/BV');
});

test('readVideo：没有 BV 时直接返回空，不发请求', async () => {
  let called = false;
  const out = await biliWatch.readVideo({}, 'https://b23.tv/abc', {
    client: {}, watchMaterials: async () => { called = true; return materials(); },
  });
  assert.equal(out, '');
  assert.equal(called, false);
});

test('readVideo：元信息为空（视频被删）也返回空，不抛', async () => {
  const out = await biliWatch.readVideo({}, 'BV1xx411c7mD', {
    client: {}, watchMaterials: async () => ({ info: {}, subtitle: { text: '' }, replies: [] }),
  });
  assert.equal(out, '');
});

test('linkBlock：B 站视频用「看过字幕但没看画面」的说法，普通链接沿用旧说法', () => {
  const bili = persona.linkBlock('【B站视频】标题\nUP：A');
  assert.match(bili, /B 站视频/);
  assert.match(bili, /别说自己看懂了画面/);
  const plain = persona.linkBlock('链接标题：随便一个网页');
  assert.match(plain, /【对方发的链接】/);
  assert.match(plain, /别假装看完了整个视频或文章/);
});

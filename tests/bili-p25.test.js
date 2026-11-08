'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const digest = require('../src/services/bili/digest');
const styleCore = require('../src/core/bili/style');
const styleService = require('../src/services/bili/style');
const chatService = require('../src/services/bili/chat');
const biliStore = require('../src/infra/biliStore');
const biliWatch = require('../src/services/biliWatch');

function makeConfig(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-p25-'));
  const config = {
    paths: { dataDir: path.join(root, 'data') },
    features: { bili: true },
    bili: { diary: { enabled: true, digestTokens: 200 }, style: { enabled: true }, ...(overrides.bili || {}) },
    ...(overrides.config || {}),
  };
  return { root, config };
}

const now = new Date(2026, 10, 8, 12, 0, 0);

test('diary：能认出「她今天看了什么」这类问题，普通聊天不注入', () => {
  for (const text of ['你今天看了啥', '今天刷了什么视频', '看看你的日记', 'B站最近看了什么', '你刚看了什么']) {
    assert.equal(digest.isDiaryQuestion(text), true, text);
  }
  for (const text of ['今天吃什么', '不要发日记', '帮我写一段代码', '', '随便聊聊']) {
    assert.equal(digest.isDiaryQuestion(text), false, text);
  }
});

test('diary：blockFor 只在开关打开且命中问题、且有当天日记时返回内容', () => {
  const { config } = makeConfig();
  assert.equal(digest.blockFor(config, '今天吃什么', now), '');
  assert.equal(digest.blockFor(config, '你今天看了啥', now), '', '还没写日记');

  biliStore.appendDiary(config, 'owner', now, '今天看了猫猫视频，还挺治愈。');
  const block = digest.blockFor(config, '你今天看了啥', now);
  assert.match(block, /B 站（日记摘要）/);
  assert.match(block, /猫猫视频/);

  const off = makeConfig({ config: { features: { bili: false } } });
  assert.equal(digest.blockFor(off.config, '你今天看了啥', now), '', '开关关掉不注入');
});

test('styleCore：短语清洗/合并去重/提及累加/上限/衰减', () => {
  assert.equal(styleCore.cleanPhrase('  确实  '), '确实');
  assert.equal(styleCore.cleanPhrase('这是一句非常非常非常非常非常非常长而且没有任何意义的完整句子超出上限'), '');
  assert.equal(styleCore.cleanPhrase('！！！'), '');

  let items = styleCore.merge([], ['确实', '笑死', '确实'], now.getTime());
  assert.equal(items.length, 2);
  assert.equal(items.find((x) => x.text === '确实').mentions, 2);

  items = styleCore.merge(items, ['笑死'], now.getTime() + 1000);
  assert.equal(items.find((x) => x.text === '笑死').mentions, 2);

  const old = now.getTime() - 31 * 86400000;
  const decayed = styleCore.merge([{ text: '旧梗', norm: '旧梗', mentions: 9, lastSeenAt: old }], [], now.getTime());
  assert.equal(decayed.length, 0, '30 天没出现就丢掉');

  const many = Array.from({ length: 30 }, (_, i) => '梗' + i);
  assert.equal(styleCore.merge([], many, now.getTime()).length, styleCore.MAX_ITEMS);
});

test('styleCore.block：最多 3 条，带「别堆砌」的约束', () => {
  const items = styleCore.merge([], ['确实', '笑死', '离谱', '破防', '好家伙'], now.getTime());
  const block = styleCore.block(items, now.getTime());
  assert.match(block, /评论区说话习惯/);
  assert.match(block, /别堆砌/);
  const firstLine = block.split('\n')[0];
  const quoted = (firstLine.match(/「/g) || []).length;
  assert.equal(quoted, 3);
});

test('styleService：没有模型时按规则从热评里学「气口」并落盘', async () => {
  const { config } = makeConfig();
  const out = await styleService.learn({
    config,
    llm: null,
    now,
    replies: [
      { author: 'A', text: '确实，这波属于是典中典了' },
      { author: 'B', text: '笑死，建议看看评论区' },
      { author: 'C', text: '这是一个完全正常的评论没有任何口头禅' },
    ],
  });
  assert.ok(out.total >= 2, JSON.stringify(out));
  const saved = JSON.parse(fs.readFileSync(biliStore.paths(config).style, 'utf8'));
  const texts = saved.items.map((x) => x.text);
  assert.ok(texts.some((t) => t.includes('确实')), texts.join(','));
  assert.ok(texts.some((t) => t.includes('笑死')), texts.join(','));
});

test('styleService.blockFor：开关关掉返回空；打开时返回注入块', () => {
  const { config } = makeConfig();
  biliStore.writeJson(biliStore.paths(config).style, {
    items: [{ text: '确实', norm: '确实', mentions: 3, lastSeenAt: now.getTime() }],
  });
  assert.match(styleService.blockFor(config, now), /确实/);
  const off = makeConfig({ bili: { style: { enabled: false } } });
  assert.equal(styleService.blockFor(off.config, now), '');
});

test('chat.blocks：同时拼日记摘要与说话习惯；任一缺失不影响另一块', () => {
  const { config } = makeConfig();
  biliStore.appendDiary(config, 'owner', now, '今天看了猫猫和 AI 视频。');
  biliStore.writeJson(biliStore.paths(config).style, {
    items: [{ text: '确实', norm: '确实', mentions: 2, lastSeenAt: now.getTime() }],
  });
  const block = chatService.blocks(config, '你今天看了啥', now);
  assert.match(block, /B 站（日记摘要）/);
  assert.match(block, /评论区说话习惯/);

  const smallTalk = chatService.blocks(config, '在吗', now);
  assert.doesNotMatch(smallTalk, /B 站（日记摘要）/, '不是问日记就不塞日记');
  assert.match(smallTalk, /评论区说话习惯/, '说话习惯可以一直带');
});

test('biliWatch.readMaterials：返回摘要 + 结构化热评；解析不到 BV 返回空结构', async () => {
  const client = {};
  const watchMaterials = async () => ({
    info: { bvid: 'BV1xx411c7mD', title: '标题', desc: '', durationSec: 60, owner: { name: 'UP' }, stat: { view: 1 } },
    subtitle: { text: '第一句' },
    replies: [{ author: 'A', text: '确实' }],
  });
  const out = await biliWatch.readMaterials({}, 'https://www.bilibili.com/video/BV1xx411c7mD', { client, watchMaterials });
  assert.match(out.digest, /【B站视频】/);
  assert.equal(out.replies.length, 1);
  assert.equal(out.info.bvid, 'BV1xx411c7mD');

  const none = await biliWatch.readMaterials({}, 'https://b23.tv/abc', { client, watchMaterials });
  assert.deepEqual(none, { digest: '', info: null, replies: [] });
});

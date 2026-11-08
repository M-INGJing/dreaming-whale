'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const indexer = require('../src/infra/stickerIndex');
const collect = require('../src/services/stickerCollect');
const classify = require('../src/services/stickerClassify');

function makeRuntime(collectOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-collect-'));
  const logs = [];
  const config = {
    root,
    features: { stickers: true },
    sticker: { dir: 'data/stickers', collect: { enabled: true, maxPerDay: 30, maxFileBytes: 2 * 1024 * 1024, dhashDistance: 6, sameFormatOnly: true, minConfidence: 0.6, allowNewCategories: true, classifyDelaySec: 0, ...collectOverrides } },
    persona: { master: { wxids: [], names: ['主人'] } },
  };
  const runtime = { config, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, store: null };
  return { root, runtime, logs };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const png = (n) => Buffer.concat([PNG, Buffer.alloc(24, n)]);

test('collect：新图写进待定、索引和队列', () => {
  const { root, runtime } = makeRuntime();
  const out = collect.collect(runtime, { image: png(1).toString('base64'), mime: 'image/png', dhash: '0123456789abcdef', chatType: 'group', chatId: 'example@chatroom', sender: '群友' });
  assert.equal(out.ok, true);
  assert.equal(out.duplicate, false);
  assert.equal(out.queued, true);
  const idx = indexer.load(runtime.config, root);
  const row = idx.items[out.sha];
  assert.equal(row.category, '待定');
  assert.equal(row.dhash, '0123456789abcdef');
  assert.ok(fs.existsSync(path.join(root, 'data/stickers', row.file)));
  assert.equal(collect.readQueue(runtime.config, root).length, 1);
});

test('collect：内容相同判重复，只 seen++，不重复落盘', () => {
  const { root, runtime } = makeRuntime();
  const first = collect.collect(runtime, { image: png(2).toString('base64'), mime: 'image/png' });
  const again = collect.collect(runtime, { image: png(2).toString('base64'), mime: 'image/png' });
  assert.equal(again.duplicate, true);
  assert.equal(again.reason, 'exact');
  const idx = indexer.load(runtime.config, root);
  assert.equal(idx.items[first.sha].seen, 2);
  assert.equal(collect.readQueue(runtime.config, root).length, 1);
});

test('collect：字节不同但 dHash 近似 → 判重复（不发新文件）', () => {
  const { root, runtime } = makeRuntime();
  collect.collect(runtime, { image: png(3).toString('base64'), mime: 'image/png', dhash: 'ffffffffffffffff' });
  const near = collect.collect(runtime, { image: png(4).toString('base64'), mime: 'image/png', dhash: 'fffffffffffffffe' });
  assert.equal(near.duplicate, true);
  assert.equal(near.reason, 'near');
  const idx = indexer.load(runtime.config, root);
  assert.equal(Object.keys(idx.items).length, 1);
});

test('collect：格式不同（gif vs png）即使 dHash 相同也不判重', () => {
  const { root, runtime } = makeRuntime();
  collect.collect(runtime, { image: png(5).toString('base64'), mime: 'image/png', dhash: 'aaaaaaaaaaaaaaaa' });
  const gif = collect.collect(runtime, { image: png(6).toString('base64'), mime: 'image/gif', dhash: 'aaaaaaaaaaaaaaaa' });
  assert.equal(gif.duplicate, false);
  assert.equal(Object.keys(indexer.load(runtime.config, root).items).length, 2);
});

test('collect：开关/来源/大小/单日上限都会被拒绝', () => {
  const offFeature = makeRuntime();
  offFeature.runtime.config.features.stickers = false;
  assert.equal(collect.collect(offFeature.runtime, { image: png(7).toString('base64'), mime: 'image/png' }).reason, 'feature_off');

  const offCollect = makeRuntime({ enabled: false });
  assert.equal(collect.collect(offCollect.runtime, { image: png(7).toString('base64'), mime: 'image/png' }).reason, 'collect_off');

  const groupOff = makeRuntime({ fromGroups: false });
  assert.equal(collect.collect(groupOff.runtime, { image: png(7).toString('base64'), mime: 'image/png', chatType: 'group' }).reason, 'group_off');

  const cap = makeRuntime({ maxPerDay: 1 });
  collect.collect(cap.runtime, { image: png(8).toString('base64'), mime: 'image/png', dhash: '1111111111111111' });
  assert.equal(collect.collect(cap.runtime, { image: png(9).toString('base64'), mime: 'image/png', dhash: '2222222222222222' }).reason, 'daily_cap');
});

test('classify：高置信度归档到分类目录，队列清空', async () => {
  const { root, runtime } = makeRuntime();
  const out = collect.collect(runtime, { image: png(10).toString('base64'), mime: 'image/png', dhash: '3333333333333333' });
  const stats = await classify.processQueue(runtime, {
    describe: async () => '一只猫在笑',
    llm: { isMock: false, complete: async () => '{"category":"开心","confidence":0.9,"tags":["猫"],"description":"一只猫在笑"}' },
  });
  assert.equal(stats.done, 1);
  const idx = indexer.load(runtime.config, root);
  assert.equal(idx.items[out.sha].category, '开心');
  assert.match(idx.items[out.sha].file, /^开心\//);
  assert.ok(fs.existsSync(path.join(root, 'data/stickers', idx.items[out.sha].file)));
  assert.equal(collect.readQueue(runtime.config, root).length, 0);
  // 自动归类之后仍然留在「待定」（还没人工确认），不会下一次点开就消失
  const pending = collect.pendingList(runtime, 50);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].category, '开心');
  assert.equal(pending[0].sha, out.sha);

  // 人工归档后才从待定里消失
  idx.items[out.sha].reviewed = true;
  indexer.save(runtime.config, root, idx);
  assert.equal(collect.pendingList(runtime, 50).length, 0);
});

test('classify：新收藏先等 classifyDelaySec 秒再分类（回复优先）', async () => {
  const { root, runtime } = makeRuntime({ classifyDelaySec: 600 });
  collect.collect(runtime, { image: png(21).toString('base64'), mime: 'image/png', dhash: '6666666666666666' });
  let called = 0;
  const stats = await classify.processQueue(runtime, {
    describe: async () => { called += 1; return '猫'; },
    llm: { isMock: false, complete: async () => { called += 1; return '{"category":"开心","confidence":0.9}'; } },
  });
  assert.equal(stats.deferred, 1);
  assert.equal(called, 0, '延迟期内不许调用模型');
  assert.equal(collect.readQueue(runtime.config, root).length, 1);
});

test('classify：置信度不够就留在待定（队列重试后丢弃任务）', async () => {
  const { root, runtime } = makeRuntime({ minConfidence: 0.8 });
  const out = collect.collect(runtime, { image: png(11).toString('base64'), mime: 'image/png', dhash: '4444444444444444' });
  await classify.processQueue(runtime, {
    describe: async () => '看不太清',
    llm: { isMock: false, complete: async () => '{"category":"开心","confidence":0.4}' },
  });
  const idx = indexer.load(runtime.config, root);
  assert.equal(idx.items[out.sha].category, '待定');
  assert.equal(classify.MAX_ATTEMPTS, 3);
});

test('classify：允许新分类时创建目录并登记到 sticker-categories.json', async () => {
  const { root, runtime } = makeRuntime();
  const out = collect.collect(runtime, { image: png(12).toString('base64'), mime: 'image/png', dhash: '5555555555555555' });
  await classify.processQueue(runtime, {
    describe: async () => '一只阴阳怪气的猫',
    llm: { isMock: false, complete: async () => '{"category":"阴阳","confidence":0.9,"description":"猫在阴阳怪气"}' },
  });
  const idx = indexer.load(runtime.config, root);
  assert.equal(idx.items[out.sha].category, '阴阳');
  assert.match(idx.items[out.sha].file, /^阴阳\//);
  const cats = JSON.parse(fs.readFileSync(path.join(root, 'data', 'sticker-categories.json'), 'utf8'));
  assert.ok(cats.some((c) => c.label === '阴阳'));
});

test('parseModel：能容忍多余文字，非法输出返回 null', () => {
  assert.deepEqual(classify.parseModel('好的 {"category":"开心","confidence":0.8} 完'), { category: '开心', confidence: 0.8, tags: [], description: '' });
  assert.equal(classify.parseModel('没有 JSON'), null);
});

test('indexer.rebuild：目录里已有的图能重建索引', () => {
  const { root, runtime } = makeRuntime();
  fs.mkdirSync(path.join(root, 'data/stickers/开心'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/stickers/开心/a.png'), png(13));
  const idx = indexer.rebuild(runtime.config, root);
  assert.equal(Object.keys(idx.items).length, 1);
  const row = Object.values(idx.items)[0];
  assert.equal(row.category, '开心');
});

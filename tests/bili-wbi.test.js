'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const wbi = require('../src/adapters/bili/wbi');

const IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';

test('mixinKey：官方测试向量的结果不能变（签名漂移会立刻发现）', () => {
  assert.equal(wbi.mixinKey(IMG, SUB), 'ea1db124af3c7062474693fa704f4ff8');
});

test('mixinKey：只取文件名，忽略域名和查询串', () => {
  assert.equal(
    wbi.mixinKey('https://cdn.example.com/a/b/7cd084941338484aae1ad9425b84077c.png?x=1',
      '//other.host/4932caff0ff746eab6f01bf08b70ac45.png'),
    wbi.mixinKey(IMG, SUB));
});

test('mixinKey：密钥不完整时抛 BiliError，不拿半截密钥签名', () => {
  assert.throws(() => wbi.mixinKey('', SUB), (err) => err.code === 'wbi_key_missing');
  assert.throws(() => wbi.mixinKey(IMG, 'https://x/y.png'), (err) => err.code === 'wbi_key_missing');
});

test('sign：参数顺序不影响签名（先排序再加 wts）', () => {
  const a = wbi.sign({ bvid: 'BV1xx411c7mD', p: 1, t: 'x' }, IMG, SUB, 1700000000);
  const b = wbi.sign({ t: 'x', p: 1, bvid: 'BV1xx411c7mD' }, IMG, SUB, 1700000000);
  assert.equal(a, b);
});

test('sign：过滤 !\'()* 与空值，带上 wts 与 32 位 w_rid', () => {
  const query = wbi.sign({ keyword: 'a!b(c)d', empty: '', nothing: null, p: 2 }, IMG, SUB, 1700000000);
  assert.match(query, /keyword=abcd/);
  assert.doesNotMatch(query, /empty=/);
  assert.match(query, /wts=1700000000/);
  const rid = (query.match(/w_rid=([0-9a-f]{32})$/) || [])[1];
  assert.ok(rid, 'w_rid 必须是 32 位十六进制');
});

test('sign：wts 不同 → w_rid 不同（防止缓存串号）', () => {
  const a = wbi.sign({ bvid: 'BV1xx411c7mD' }, IMG, SUB, 1700000000);
  const b = wbi.sign({ bvid: 'BV1xx411c7mD' }, IMG, SUB, 1700000001);
  assert.notEqual(a, b);
});

test('filterValue：只删官方要求删除的四个符号', () => {
  assert.equal(wbi.filterValue("a!b'c(d)e*f"), 'abcdef');
  assert.equal(wbi.filterValue('中 文-_.~'), '中 文-_.~');
});

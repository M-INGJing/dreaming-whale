'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const biliStore = require('../src/infra/biliStore');
const diaryView = require('../src/services/bili/diaryView');

function tmpConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-view-'));
  return { root, config: { paths: { dataDir: path.join(root, 'data') } } };
}

const d1 = new Date(2026, 10, 7, 21, 0, 0);
const d2 = new Date(2026, 10, 8, 21, 0, 0);

test('splitSections：按天拆分两本日记', () => {
  const md = '## 2026-11-07\n\n昨天看了猫\n\n## 2026-11-08\n\n今天看了狗\n';
  const out = diaryView.splitSections(md);
  assert.equal(out['2026-11-07'], '昨天看了猫');
  assert.equal(out['2026-11-08'], '今天看了狗');
});

test('listDays：把日记、看过的视频（标题来自 feed 日志）、分享数拼起来', () => {
  const { config } = tmpConfig();
  biliStore.appendDiary(config, 'owner', d1, '昨天看了猫猫。');
  biliStore.appendDiary(config, 'self', d1, '更喜欢猫。');
  biliStore.appendDiary(config, 'owner', d2, '今天看了 AI 视频。');
  biliStore.appendDiary(config, 'self', d2, '更喜欢实测。');

  biliStore.appendFeedLog(config, d1, [
    { bvid: 'BV1xx411c7mD', title: '猫猫日常', score: 9, watched: true },
    { bvid: 'BV2xx411c7mD', title: '没看的', score: 3, watched: false },
  ]);
  biliStore.appendFeedLog(config, d2, [
    { bvid: 'BV3xx411c7mD', title: 'AI 实测', score: 7, watched: true },
  ]);

  const p = biliStore.paths(config);
  fs.writeFileSync(p.events, [
    { at: d1.toISOString(), kind: 'wake', watched: ['BV1xx411c7mD'], share: 'none' },
    { at: d1.toISOString(), kind: 'share_sent', bvid: 'BV1xx411c7mD' },
    { at: d2.toISOString(), kind: 'wake', watched: ['BV3xx411c7mD'] },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  const out = diaryView.listDays(config, { days: 10 });
  assert.equal(out.days.length, 2);
  assert.equal(out.days[0].date, '2026-11-08', '新的在前');
  assert.equal(out.days[0].owner, '今天看了 AI 视频。');
  assert.equal(out.days[0].self, '更喜欢实测。');
  assert.deepEqual(out.days[0].watched, [{ bvid: 'BV3xx411c7mD', title: 'AI 实测', score: 7 }]);
  assert.equal(out.days[1].date, '2026-11-07');
  assert.equal(out.days[1].watched[0].title, '猫猫日常');
  assert.equal(out.days[1].shares, 1);
  fs.rmSync(path.dirname(config.paths.dataDir), { recursive: true, force: true });
});

test('listDays：feed 日志没有标题时用 titles.json 缓存补上', () => {
  const { config } = tmpConfig();
  biliStore.appendDiary(config, 'owner', d2, '今天看了 AI 视频。');
  biliStore.appendFeedLog(config, d2, [{ bvid: 'BV3xx411c7mD', score: 7, watched: true }]);
  biliStore.mergeTitles(config, { BV3xx411c7mD: 'AI 实测（补的标题）' });
  const p = biliStore.paths(config);
  fs.writeFileSync(p.events, JSON.stringify({ at: d2.toISOString(), kind: 'wake', watched: ['BV3xx411c7mD'] }) + '\n');

  const out = diaryView.listDays(config, { days: 10 });
  assert.equal(out.days[0].watched[0].title, 'AI 实测（补的标题）');
  fs.rmSync(path.dirname(config.paths.dataDir), { recursive: true, force: true });
});

test('listDays：没有日记时返回空数组（不报错）', () => {
  const { config } = tmpConfig();
  const out = diaryView.listDays(config, { days: 10 });
  assert.deepEqual(out.days, []);
});

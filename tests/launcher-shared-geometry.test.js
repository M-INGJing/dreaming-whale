'use strict';

/**
 * 空态插画（鲸尾）只允许在 App.xaml 里定义一次。
 *
 * 之前状态页、表情包、提醒页各复制了一份 42 个字符的路径字符串，改一处就要找三处。
 * 这条测试守两件事：路径字符串只有一份；三个页面都通过 StaticResource 引用它。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'launcher');
const TAIL = 'M3 13c4.6-.3 7.7-2.8 9-7.7 1.3 4.9 4.4 7.4 9 7.7-1.3-5.2-4.9-8.6-9-8.6S4.3 7.8 3 13Z';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.xaml$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(root);

test('鲸尾路径字符串只在 App.xaml 里出现一次', () => {
  const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes(TAIL));
  assert.deepStrictEqual(
    hits.map((f) => path.basename(f)),
    ['App.xaml'],
    '有其他文件复制了鲸尾路径，改成 {StaticResource WhaleTail}'
  );
});

test('App.xaml 定义了 WhaleTail 几何资源', () => {
  const app = fs.readFileSync(path.join(root, 'App.xaml'), 'utf8');
  assert.ok(/x:Key="WhaleTail"/.test(app), 'App.xaml 里找不到 WhaleTail');
  assert.ok(/<PathGeometry[^>]*x:Key="WhaleTail"/.test(app), 'WhaleTail 应该是 PathGeometry（Geometry 是抽象类型，不能直接实例化）');
});

test('三个空态都引用共享资源', () => {
  for (const name of ['StatusPage.xaml', 'StickerPage.xaml', 'ReminderPage.xaml']) {
    const text = fs.readFileSync(path.join(root, 'Views', name), 'utf8');
    assert.ok(text.includes('{StaticResource WhaleTail}'), name + ' 没有引用 WhaleTail');
  }
});

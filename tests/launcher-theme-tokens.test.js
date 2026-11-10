'use strict';

/**
 * 主题色一致性：启动器所有颜色都是命名画刷。
 *   App.xaml        → 启动瞬间（ApplyTheme 之前）用的默认值
 *   Appearance.cs   → Light / Dark 两个字典，启动和切换时覆盖进 Application.Resources
 *
 * 三张表只要有一处漏键或值不同，对应主题下就是一块取不到刷子的空白 / 一次闪色，
 * 而 WPF 编译期不会报错 —— 这种错只能靠这条测试拦。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const XAML = path.join(root, 'launcher', 'App.xaml');
const CS = path.join(root, 'launcher', 'Appearance.cs');

/** App.xaml 里的 <SolidColorBrush x:Key="X" Color="#AARRGGBB" /> */
function readBrushes() {
  const text = fs.readFileSync(XAML, 'utf8');
  const out = new Map();
  const re = /<SolidColorBrush\s+x:Key="([A-Za-z0-9_]+)"\s+Color="(#[0-9A-Fa-f]{8})"\s*\/>/g;
  let m;
  while ((m = re.exec(text))) out.set(m[1], m[2].toUpperCase());
  return out;
}

/** Appearance.cs 里某个字典的 ["Key"] = "#AARRGGBB" 条目 */
function readDict(name) {
  const text = fs.readFileSync(CS, 'utf8');
  const at = text.indexOf('Dictionary<string, string> ' + name);
  assert.ok(at >= 0, 'Appearance.cs 里找不到 ' + name + ' 字典');
  const open = text.indexOf('{', at);
  const close = text.indexOf('};', open);
  assert.ok(open > 0 && close > open, name + ' 字典格式异常');
  const body = text.slice(open, close);
  const out = new Map();
  const re = /\["([A-Za-z0-9_]+)"\]\s*=\s*"(#[0-9A-Fa-f]{8})"/g;
  let m;
  while ((m = re.exec(body))) out.set(m[1], m[2].toUpperCase());
  return out;
}

/** WCAG 2.1 相对亮度；输入 #AARRGGBB，只取 RGB */
function luminance(hex) {
  const rgb = hex.replace('#', '').slice(2);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(rgb.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const brushes = readBrushes();
const light = readDict('Light');
const dark = readDict('Dark');

test('App.xaml 的每个画刷在 Light / Dark 里都有同名键', () => {
  assert.ok(brushes.size >= 30, 'App.xaml 只解析到 ' + brushes.size + ' 个画刷，正则可能失效');
  for (const key of brushes.keys()) {
    assert.ok(light.has(key), '浅色字典缺 ' + key + '：切到浅色主题时这块会取不到刷子');
    assert.ok(dark.has(key), '深色字典缺 ' + key + '：切到深色主题时这块会取不到刷子');
  }
});

test('两个字典没有 App.xaml 里不存在的多余键', () => {
  for (const [dict, name] of [[light, 'Light'], [dark, 'Dark']]) {
    for (const key of dict.keys()) {
      assert.ok(brushes.has(key), name + ' 字典里的 ' + key + ' 在 App.xaml 没有默认值');
    }
  }
});

test('App.xaml 默认值与深色字典一致（启动瞬间不该闪一次旧色）', () => {
  for (const [key, color] of brushes) {
    assert.strictEqual(color, dark.get(key), key + '：App.xaml 默认值与 Dark 不一致');
  }
});

test('选中态文字在两种主题下都达到 4.5:1', () => {
  // 这是 AccentText 存在的唯一理由：Accent 压在 AccentSoft 上，浅色只有 3.9:1
  for (const [name, dict] of [['浅色', light], ['深色', dark]]) {
    const ratio = contrast(dict.get('AccentText'), dict.get('AccentSoft'));
    assert.ok(ratio >= 4.5, name + '主题 AccentText on AccentSoft 只有 ' + ratio.toFixed(2) + ':1');
  }
});

test('正文与辅助文字在各自底色上达到 4.5:1', () => {
  const pairs = [
    ['浅色 Accent on CardBg', light.get('Accent'), light.get('CardBg')],
    ['浅色 Muted on CardBg', light.get('Muted'), light.get('CardBg')],
    ['浅色 Dim on Bg', light.get('Dim'), light.get('Bg')],
    ['深色 Dim on CardBg', dark.get('Dim'), dark.get('CardBg')],
    ['深色 Muted on CardBg', dark.get('Muted'), dark.get('CardBg')],
    ['深色 Text on Bg', dark.get('Text'), dark.get('Bg')],
  ];
  for (const [label, fg, bg] of pairs) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, label + ' 只有 ' + ratio.toFixed(2) + ':1');
  }
});

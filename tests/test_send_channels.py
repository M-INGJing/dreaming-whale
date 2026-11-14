# -*- coding: utf-8 -*-
"""发送通道策略（bridge/sender_mixin.py, bridge/window_mixin.py）的离线回归。

背景：`features.stickers=true` 曾经被映射成 `G.STICKER_TEST_ON`，而发送链路拿它
当「必须前台」的开关用：
  - `send_text` 把零焦点通道整个跳过；
  - `with_window_on_top` 直接 `require_foreground=True`。
结果是「一打开表情包，所有文字回复都必须有前台」，在 RDP 断连（会话没有前台）
时连普通文字都发不出去。表情包自己有 `send_sticker` 走前台，不该连累文字。

这些断言是 AST 级的「结构回归」：它们直接检查代码里有没有把开关重新接回去。
"""

import ast
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))

from bridge_ast import _TREES  # noqa: E402


def _function(name):
    for _path, tree in _TREES:
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == name:
                return node
    raise AssertionError('bridge/*.py 里找不到函数 %s' % name)


def _names(node):
    out = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Attribute):
            out.add(n.attr)
        elif isinstance(n, ast.Name):
            out.add(n.id)
    return out


class SendTextPolicy(unittest.TestCase):
    def test_text_send_is_not_gated_by_sticker_switch(self):
        fn = _function('send_text')
        self.assertNotIn(
            'STICKER_TEST_ON', _names(fn),
            'send_text 不能再受表情包总开关影响：文字回复必须永远先试零焦点通道')

    def test_background_channel_is_tried_before_window_on_top(self):
        fn = _function('send_text')
        lines = {}
        for n in ast.walk(fn):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
                lines.setdefault(n.func.attr, n.lineno)
        self.assertIn('bg_send', lines, 'send_text 里必须还在调 bg_send')
        self.assertIn('with_window_on_top', lines, 'send_text 里必须还有前台兜底')
        self.assertLess(lines['bg_send'], lines['with_window_on_top'],
                        '零焦点通道必须排在前台兜底之前')


class WindowOnTopPolicy(unittest.TestCase):
    def test_does_not_force_foreground_for_every_send(self):
        fn = _function('with_window_on_top')
        self.assertNotIn(
            'force_front', _names(fn),
            'with_window_on_top 不能再按表情包开关强制前台')
        for n in ast.walk(fn):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) \
                    and n.func.attr == 'force_send_foreground':
                for kw in n.keywords:
                    if kw.arg == 'require_foreground' and isinstance(kw.value, ast.Constant) \
                            and kw.value.value is True:
                        self.fail('with_window_on_top 里不应再用 require_foreground=True')


class StickerStillOwnsForeground(unittest.TestCase):
    def test_send_sticker_keeps_its_own_foreground_step(self):
        """表情包本身仍然要抢前台（它靠真实前台粘贴文件）。"""
        fn = _function('send_sticker')
        self.assertIn('force_foreground', _names(fn),
                      'send_sticker 必须保留自己的抢前台步骤')


if __name__ == '__main__':
    unittest.main()

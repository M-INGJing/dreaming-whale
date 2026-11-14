# -*- coding: utf-8 -*-
"""窗口恢复判定（bridge/window_state.py）的离线单测。"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))

from window_state import (  # noqa: E402
    SW_RESTORE, SW_SHOW, describe_window, needs_restore, restore_calls,
)


class WindowState(unittest.TestCase):
    def test_minimized_needs_restore_only(self):
        self.assertTrue(needs_restore(True, True))
        self.assertEqual(restore_calls(True, True), [SW_RESTORE])

    def test_hidden_needs_show(self):
        self.assertTrue(needs_restore(False, False))
        self.assertEqual(restore_calls(False, False), [SW_SHOW])

    def test_hidden_and_minimized_shows_then_restores(self):
        self.assertEqual(restore_calls(True, False), [SW_SHOW, SW_RESTORE])

    def test_normal_window_does_nothing(self):
        self.assertFalse(needs_restore(False, True))
        self.assertEqual(restore_calls(False, True), [])


class DescribeWindow(unittest.TestCase):
    """心跳里那句窗口状态：断连不能再说成「已最小化」。"""

    def test_visible(self):
        self.assertEqual(describe_window(False, True, False), '可见')

    def test_minimized(self):
        self.assertEqual(describe_window(True, True, False), '已最小化')

    def test_tray(self):
        self.assertEqual(describe_window(False, False, False), '在托盘（窗口隐藏）')

    def test_disconnected_wins_over_iconic(self):
        # RDP 断开时窗口一定是 iconic 的；必须报「已断连」而不是「已最小化」，
        # 否则排查方向会被带到「把窗口打开」而不是「tscon 回 console」。
        label = describe_window(True, True, True)
        self.assertIn('已断连', label)
        self.assertNotEqual(label, '已最小化')

    def test_disconnected_even_if_tree_looks_normal(self):
        self.assertIn('已断连', describe_window(False, True, True))



if __name__ == '__main__':
    unittest.main()

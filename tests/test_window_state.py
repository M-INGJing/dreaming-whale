# -*- coding: utf-8 -*-
"""窗口恢复判定（bridge/window_state.py）的离线单测。"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))

from window_state import SW_RESTORE, SW_SHOW, needs_restore, restore_calls  # noqa: E402


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


if __name__ == '__main__':
    unittest.main()

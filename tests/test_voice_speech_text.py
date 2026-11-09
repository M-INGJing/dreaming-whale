# -*- coding: utf-8 -*-
"""语音文本清洗（bridge/voice_reply.sanitize_for_speech）的离线单测。"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))

from voice_reply import sanitize_for_speech  # noqa: E402


class SanitizeForSpeech(unittest.TestCase):
    def test_removes_kaomoji_and_tilde(self):
        out = sanitize_for_speech('今天也不错(๑•̀ㅂ•́)و✧，晚安～')
        self.assertEqual(out, '今天也不错，晚安')

    def test_removes_emoji(self):
        self.assertEqual(sanitize_for_speech('好耶 😭✨'), '好耶')
        self.assertEqual(sanitize_for_speech('哈哈 😭🤡💀 真的'), '哈哈真的')

    def test_removes_markdown_links_and_urls(self):
        out = sanitize_for_speech('**重点**：[点这里](https://example.com) 和 https://b23.tv/x')
        self.assertIn('重点', out)
        self.assertIn('点这里', out)
        self.assertNotIn('http', out)
        self.assertNotIn('**', out)

    def test_removes_ascii_faces(self):
        self.assertEqual(sanitize_for_speech('我怎么知道>w<'), '我怎么知道')
        self.assertEqual(sanitize_for_speech('qwq 好难过'), '好难过')

    def test_keeps_chinese_stage_direction(self):
        self.assertEqual(sanitize_for_speech('怎么突然这么客气了（歪头）'), '怎么突然这么客气了（歪头）')

    def test_empty_or_symbol_only_returns_empty(self):
        self.assertEqual(sanitize_for_speech(''), '')
        self.assertEqual(sanitize_for_speech('(๑•̀ㅂ•́)و✧ ✨ 😭'), '')

    def test_collapses_spaces_and_punctuation(self):
        out = sanitize_for_speech('好的 ， 那 就 这 样 。')
        self.assertEqual(out, '好的，那就这样。')


if __name__ == '__main__':
    unittest.main()

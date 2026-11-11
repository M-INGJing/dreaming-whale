# -*- coding: utf-8 -*-
"""封面卡片合成（bridge/share_card.py）的离线单测：不联网，patch 掉封面下载。"""

import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))

import share_card  # noqa: E402


def cover_bytes(w=640, h=360, color=(200, 80, 120)):
    buf = io.BytesIO()
    Image.new('RGB', (w, h), color).save(buf, 'PNG')
    return buf.getvalue()


class ShareCard(unittest.TestCase):
    def test_make_card_outputs_sized_jpeg(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(share_card, '_download_cover', return_value=cover_bytes()):
                path = share_card.make_card({
                    'id': 'job-1',
                    'bvid': 'BV1xx411c7mD',
                    'title': '拿黄仁勋开刀，民主党真要毁掉美国AI？',
                    'cover': 'https://i0.hdslb.com/cover.jpg',
                }, out_dir=tmp)
            self.assertTrue(path)
            self.assertTrue(str(path).endswith('.jpg'))
            with Image.open(path) as img:
                self.assertEqual(img.size, (share_card.CARD_W, share_card.CARD_H))

    def test_wrap_keeps_two_lines(self):
        from PIL import ImageDraw
        img = Image.new('RGB', (720, 500), 'white')
        draw = ImageDraw.Draw(img)
        font = share_card._font(24, bold=True)
        lines = share_card._wrap(draw, '这是一个很长很长很长很长很长很长的视频标题需要换行', font, 600, max_lines=2)
        self.assertLessEqual(len(lines), 2)
        self.assertTrue(all(len(line) > 0 for line in lines))

    def test_missing_cover_returns_none(self):
        self.assertIsNone(share_card.make_card({'id': 'x', 'title': 't', 'cover': ''}))


if __name__ == '__main__':
    unittest.main()

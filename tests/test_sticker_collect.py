# -*- coding: utf-8 -*-
"""表情包收藏（bridge/sticker_collect.py）的离线单测：PIL 造图、假 HTTP，不联网。"""

import base64
import io
import sys
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))

from sticker_collect import collect_async, fingerprint, submit  # noqa: E402


def png_bytes(pattern):
    img = Image.new('RGB', (64, 64), 'white')
    px = img.load()
    for x in range(64):
        for y in range(64):
            if (x // 8 + y // 8) % 2 == (0 if pattern else 1):
                px[x, y] = (0, 0, 0)
    out = io.BytesIO()
    img.save(out, format='PNG')
    return out.getvalue()


class FakeRuntime:
    def __init__(self, response):
        self.response = response
        self.sticker_base = 'http://127.0.0.1:8787'
        self.sticker_headers = {'x-bot-token': 't', 'x-whale-bridge': '1'}
        self.posts = []
        runtime = self

        class Http:
            def post(self, url, json=None, headers=None, timeout=None):
                runtime.posts.append((url, json))
                return type('R', (), {'status_code': 200, 'json': lambda self: runtime.response})()

        class Db:
            def get_nickname(self, wxid):
                return '群友'

        self.LOCAL_HTTP = Http()
        self.db = Db()


class StickerCollect(unittest.TestCase):
    def test_fingerprint_sha_and_dhash(self):
        raw = png_bytes(True)
        sha, dhash = fingerprint(raw)
        self.assertEqual(len(sha), 64)
        self.assertRegex(dhash, r'^[0-9a-f]{16}$')

    def test_same_picture_different_size_has_near_dhash(self):
        raw = png_bytes(True)
        _, a = fingerprint(raw)
        small = Image.open(io.BytesIO(raw)).resize((32, 32))
        out = io.BytesIO()
        small.save(out, format='PNG')
        _, b = fingerprint(out.getvalue())
        distance = bin(int(a, 16) ^ int(b, 16)).count('1')
        self.assertLessEqual(distance, 6)

    def test_different_picture_has_far_dhash(self):
        _, a = fingerprint(png_bytes(True))
        _, b = fingerprint(png_bytes(False))
        distance = bin(int(a, 16) ^ int(b, 16)).count('1')
        self.assertGreater(distance, 6)

    def test_submit_posts_base64_and_metadata(self):
        captured = []

        def post_json(path, payload):
            captured.append((path, payload))
            return {'ok': True, 'duplicate': False, 'sha': 'x'}

        out = submit(post_json, png_bytes(True), 'group', '123@chatroom', '群友')
        self.assertTrue(out.get('ok'))
        path, payload = captured[0]
        self.assertEqual(path, '/api/stickers/collect')
        self.assertEqual(payload['chatType'], 'group')
        self.assertEqual(payload['chatId'], '123@chatroom')
        self.assertEqual(payload['sender'], '群友')
        self.assertEqual(len(base64.b64decode(payload['image'])), len(png_bytes(True)))
        self.assertRegex(payload['dhash'], r'^[0-9a-f]{16}$')

    def test_submit_never_raises_when_http_fails(self):
        def boom(path, payload):
            raise RuntimeError('offline')

        self.assertEqual(submit(boom, png_bytes(True), 'private', 'wxid_a', ''), {})

    def test_collect_async_spawns_and_posts(self):
        rt = FakeRuntime({'ok': True, 'duplicate': True, 'reason': 'exact'})
        msg = {'username': 'wxid_a', 'sender_username': 'wxid_a'}
        collect_async(rt, msg, png_bytes(True))
        # 等后台线程把请求发出去
        import time
        for _ in range(50):
            if rt.posts:
                break
            time.sleep(0.02)
        self.assertTrue(rt.posts, '后台线程应该提交一次收藏请求')
        url, payload = rt.posts[0]
        self.assertIn('/api/stickers/collect', url)
        self.assertEqual(payload['chatType'], 'private')


if __name__ == '__main__':
    unittest.main()

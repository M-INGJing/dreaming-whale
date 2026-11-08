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


def gif_bytes():
    frames = [Image.new('RGB', (64, 64), c) for c in ('red', 'blue')]
    out = io.BytesIO()
    frames[0].save(out, format='GIF', save_all=True, append_images=frames[1:], duration=100, loop=0)
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


    def test_collect_async_uses_injected_http_when_runtime_lacks_local_http(self):
        # 回归：engine.LOCAL_HTTP 是模块级全局，不在 runtime 上；上一版取 runtime.LOCAL_HTTP 直接 AttributeError
        class Bare:
            sticker_base = 'http://127.0.0.1:8787'
            sticker_headers = {'x-bot-token': 't'}

        posts = []

        class Http:
            def post(self, url, json=None, headers=None, timeout=None):
                posts.append((url, json))
                return type('R', (), {'status_code': 200, 'json': lambda self: {'ok': True}}) ()

        msg = {'username': 'wxid_a', 'sender_username': 'wxid_a'}
        collect_async(Bare(), msg, png_bytes(True), http=Http())
        import time
        for _ in range(50):
            if posts:
                break
            time.sleep(0.02)
        self.assertTrue(posts, '注入的 http 必须被用上')


    def test_collect_async_fetches_original_gif_from_network(self):
        # 微信本地缓存只有静态预览，原图要联网取；后台线程里取到 GIF 就按 GIF 提交
        import emoji_vision

        class Bare:
            sticker_base = 'http://127.0.0.1:8787'
            sticker_headers = {'x-bot-token': 't'}

            class db:
                @staticmethod
                def get_nickname(wxid):
                    return ''

        posts = []

        class Http:
            def post(self, url, json=None, headers=None, timeout=None):
                posts.append(json)
                return type('R', (), {'status_code': 200, 'json': lambda self: {'ok': True}})()

        original_load = emoji_vision.load_original
        try:
            emoji_vision.load_original = lambda *a, **k: gif_bytes()
            collect_async(
                Bare(), {'username': 'wxid_a', 'sender_username': 'wxid_a', 'content': '<emoji md5="' + 'a' * 32 + '"/>'},
                png_bytes(True), http=Http(), account_dir='x', content='<emoji/>',
            )
            import time
            for _ in range(80):
                if posts:
                    break
                time.sleep(0.02)
            self.assertTrue(posts)
            self.assertEqual(posts[0]['mime'], 'image/gif')
            self.assertEqual(base64.b64decode(posts[0]['image']), gif_bytes())
        finally:
            emoji_vision.load_original = original_load

    def test_submit_posts_mime_for_gif(self):
        captured = []

        def post_json(path, payload):
            captured.append(payload)
            return {'ok': True, 'duplicate': True}

        gif = gif_bytes()
        submit(post_json, gif, 'private', 'wxid_a', '', mime='image/gif')
        self.assertEqual(captured[0]['mime'], 'image/gif')
        self.assertEqual(base64.b64decode(captured[0]['image']), gif)

    def test_guess_mime_by_magic(self):
        import emoji_vision

        self.assertEqual(emoji_vision.guess_mime(b'GIF89a....'), 'image/gif')
        self.assertEqual(emoji_vision.guess_mime(b'\x89PNG\r\n\x1a\n....'), 'image/png')
        self.assertEqual(emoji_vision.guess_mime(b'\xff\xd8\xff\xe0....'), 'image/jpeg')

    def test_load_original_prefers_animation(self):
        import emoji_vision

        original_attrs = emoji_vision.attributes
        original_sources = emoji_vision.sources
        try:
            emoji_vision.attributes = lambda content: {'md5': 'a' * 32}
            emoji_vision.sources = lambda *a, **k: iter([gif_bytes()])
            out = emoji_vision.load_original('', 'x')
            self.assertIsNotNone(out)
            self.assertEqual(emoji_vision.guess_mime(out), 'image/gif')
        finally:
            emoji_vision.attributes = original_attrs
            emoji_vision.sources = original_sources


if __name__ == '__main__':
    unittest.main()

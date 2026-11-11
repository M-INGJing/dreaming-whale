# -*- coding: utf-8 -*-
"""B 站分享传送带（bridge/bili_outbox.py）的离线单测：不起微信、不联网。"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))

from bili_outbox import watch_once  # noqa: E402


class FakeKernel:
    def __init__(self, item=None, claim_ok=True):
        self.item = item
        self.claim_ok = claim_ok
        self.acks = []
        self.claims = []

    def get_json(self, path):
        assert path == '/api/bili/pending'
        return {'ok': True, 'item': self.item}

    def post_json(self, path, payload):
        if path == '/api/bili/claim':
            self.claims.append(payload)
            if not self.claim_ok:
                return {'ok': False}
            return {'ok': True, 'item': self.item}
        if path == '/api/bili/ack':
            self.acks.append(payload)
            return {'ok': True}
        raise AssertionError('unexpected path ' + path)


class Send:
    def __init__(self, ok=True, raises=None):
        self.ok = ok
        self.raises = raises
        self.calls = []

    def __call__(self, text, name, chat_id):
        self.calls.append((text, name, chat_id))
        if self.raises:
            raise self.raises
        return self.ok


class SendImage:
    def __init__(self, ok=True, raises=None):
        self.ok = ok
        self.raises = raises
        self.calls = []

    def __call__(self, path, name, chat_id):
        self.calls.append((path, name, chat_id))
        if self.raises:
            raise self.raises
        return self.ok


def item(**kw):
    base = {'id': 'job-1', 'bvid': 'BV1xx411c7mD', 'text': '看了个视频 https://www.bilibili.com/video/BV1xx411c7mD/', 'chatId': 'wxid_owner', 'chatType': 'private', 'name': ''}
    base.update(kw)
    return base


class BiliShareBridge(unittest.TestCase):
    def test_idle_when_nothing_pending(self):
        k = FakeKernel(item=None)
        self.assertEqual(watch_once(k.get_json, k.post_json, Send()), 'idle')
        self.assertEqual(k.claims, [])

    def test_sent_claims_then_acks_success(self):
        k = FakeKernel(item=item())
        s = Send(ok=True)
        self.assertEqual(watch_once(k.get_json, k.post_json, s), 'sent')
        self.assertEqual(k.claims, [{'id': 'job-1'}])
        self.assertEqual(s.calls, [('看了个视频 https://www.bilibili.com/video/BV1xx411c7mD/', '', 'wxid_owner')])
        self.assertEqual(k.acks, [{'id': 'job-1', 'status': 'sent', 'error': ''}])

    def test_failed_send_acks_failed(self):
        k = FakeKernel(item=item())
        self.assertEqual(watch_once(k.get_json, k.post_json, Send(ok=False)), 'failed')
        self.assertEqual(k.acks[-1]['status'], 'failed')
        self.assertEqual(k.acks[-1]['error'], 'send_failed')

    def test_exception_acks_failed_and_never_raises(self):
        k = FakeKernel(item=item())
        self.assertEqual(watch_once(k.get_json, k.post_json, Send(raises=RuntimeError('boom'))), 'failed')
        self.assertEqual(k.acks[-1]['status'], 'failed')
        self.assertEqual(k.acks[-1]['error'], 'RuntimeError')

    def test_claim_failure_does_not_send(self):
        k = FakeKernel(item=item(), claim_ok=False)
        s = Send()
        self.assertEqual(watch_once(k.get_json, k.post_json, s), 'claim_failed')
        self.assertEqual(s.calls, [])
        self.assertEqual(k.acks, [])

    def test_group_job_keeps_raw_chat_id(self):
        k = FakeKernel(item=item(chatId='example-group@chatroom', chatType='group', name='某个群'))
        s = Send()
        self.assertEqual(watch_once(k.get_json, k.post_json, s), 'sent')
        self.assertEqual(s.calls[0][2], 'example-group@chatroom')
        self.assertEqual(k.acks[-1]['status'], 'sent')

    def test_cover_card_sent_before_text(self):
        k = FakeKernel(item=item(cover='https://i0.hdslb.com/cover.jpg'))
        s = Send(ok=True)
        img = SendImage(ok=True)
        made = []

        def make_card(job, log=None):
            made.append(job.get('bvid'))
            return 'data/bili/share-cards/job-1.jpg'

        self.assertEqual(watch_once(k.get_json, k.post_json, s, send_image=img, make_card=make_card), 'sent')
        self.assertEqual(made, ['BV1xx411c7mD'])
        self.assertEqual(img.calls, [('data/bili/share-cards/job-1.jpg', '', 'wxid_owner')])
        self.assertEqual(s.calls, [('看了个视频 https://www.bilibili.com/video/BV1xx411c7mD/', '', 'wxid_owner')])
        self.assertEqual(k.acks[-1]['status'], 'sent')

    def test_image_failure_still_sends_text(self):
        k = FakeKernel(item=item(cover='https://i0.hdslb.com/cover.jpg'))
        s = Send(ok=True)
        img = SendImage(raises=RuntimeError('uia down'))
        self.assertEqual(watch_once(k.get_json, k.post_json, s, send_image=img, make_card=lambda job, log=None: 'x.jpg'), 'sent')
        self.assertEqual(len(s.calls), 1, '图片失败不能挡住文字')
        self.assertEqual(k.acks[-1]['status'], 'sent')

    def test_no_cover_skips_image(self):
        k = FakeKernel(item=item())
        s = Send(ok=True)
        img = SendImage()
        self.assertEqual(watch_once(k.get_json, k.post_json, s, send_image=img, make_card=lambda job, log=None: 'x.jpg'), 'sent')
        self.assertEqual(img.calls, [])
        self.assertEqual(len(s.calls), 1)

    def test_card_generation_none_falls_back_to_text(self):
        k = FakeKernel(item=item(cover='https://i0.hdslb.com/cover.jpg'))
        s = Send(ok=True)
        img = SendImage()
        self.assertEqual(watch_once(k.get_json, k.post_json, s, send_image=img, make_card=lambda job, log=None: None), 'sent')
        self.assertEqual(img.calls, [])
        self.assertEqual(len(s.calls), 1)


if __name__ == '__main__':
    unittest.main()

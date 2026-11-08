# -*- coding: utf-8 -*-
"""自动语音「确认目标会话」的回归。

现场（2026-11-08 01:40 起）每次自动语音都停在
`自动语音未完成：阶段=等待发送通道 原因=无法确认目标账号或会话`，
而同一时刻文字发送的 `[核对]` 是通过的。根因是 voice 的 prepare 只读一次
`current_chat()`：微信 4.2 在 open_chat 之后会短暂把它读成 None，于是直接
判失败、回退文字。这里锁住「读不到就等、读到别的才切换」的行为。
"""

import os
import sys
import threading
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
sys.path.insert(0, str(ROOT / 'bridge'))
from bridge_ast import load_function  # noqa: E402
from send_state import _chat_identity_level  # noqa: E402


class FakeUIA:
    def __init__(self, titles):
        self.titles = list(titles)
        self.opened = 0

    def current_chat(self):
        return self.titles.pop(0) if self.titles else None

    def open_chat(self, keys):
        self.opened += 1
        return True


def make(target_hwnd=100):
    logs = []
    holder = {}

    def env(uia):
        holder['uia'] = uia
        return {
            'G': types.SimpleNamespace(log=lambda *a: logs.append(' '.join(str(x) for x in a)),
                                       time=types.SimpleNamespace(sleep=lambda d: None),
                                       _chat_identity_level=_chat_identity_level),
            'self': types.SimpleNamespace(
                group_is_alive=lambda u: True,
                sticker_quarantine_allows=lambda *a: True,
                account_send_allowed=lambda w: True,
                ACCOUNT={'hwnd': target_hwnd},
                gui_lock=threading.Lock(),
                gui=types.SimpleNamespace(_get_uia=lambda: uia),
                bind_gui_window=lambda g: None,
                aliases_for=lambda username, who: [who],
            ),
            'logs': logs,
        }

    return env, logs


class VoiceTargetReady(unittest.TestCase):
    def test_waits_while_title_reads_none_then_accepts(self):
        uia = FakeUIA([None, None, '成员甲、成员乙'])
        env, logs = make()
        fn = load_function('voice_target_ready', env(uia))
        self.assertEqual(fn('example-group@chatroom', '成员甲、成员乙', 100), '成员甲、成员乙')
        self.assertEqual(uia.opened, 0, '标题还没刷新时不该去点会话行')
        self.assertEqual(logs, [])

    def test_switches_only_when_another_chat_is_really_open(self):
        uia = FakeUIA(['另一个会话', '成员甲、成员乙'])
        env, _ = make()
        fn = load_function('voice_target_ready', env(uia))
        self.assertEqual(fn('example-group@chatroom', '成员甲、成员乙', 100), '成员甲、成员乙')
        self.assertEqual(uia.opened, 1)

    def test_member_name_title_matches_regardless_of_db_order(self):
        # 现场：群在 contact.db 里成员顺序是「成员乙、成员甲」，会话列表标题是
        # 「成员甲、成员乙」。以前语音用字符串相等，群聊永远「无法确认会话」。
        uia = FakeUIA(['成员甲、成员乙'])
        env, logs = make()
        fn = load_function('voice_target_ready', env(uia))
        self.assertEqual(fn('example-group@chatroom', '成员乙、成员甲', 100), '成员甲、成员乙')
        self.assertEqual(uia.opened, 0)
        self.assertEqual(logs, [])

    def test_gives_up_with_explicit_log_when_title_never_matches(self):
        uia = FakeUIA(['另一个会话'] * 40)
        env, logs = make()
        fn = load_function('voice_target_ready', env(uia))
        self.assertEqual(fn('example-group@chatroom', '期望的群', 100), '')
        self.assertTrue(any('无法确认会话' in line for line in logs), logs)

    def test_window_change_never_touches_uia(self):
        uia = FakeUIA(['成员甲、成员乙'])
        env, logs = make(target_hwnd=999)
        fn = load_function('voice_target_ready', env(uia))
        self.assertEqual(fn('example-group@chatroom', '成员甲、成员乙', 100), '')
        self.assertEqual(uia.opened, 0)
        self.assertTrue(any('目标窗口已变化' in line for line in logs), logs)


if __name__ == '__main__':
    unittest.main()

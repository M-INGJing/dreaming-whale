# -*- coding: utf-8 -*-
"""UIA 文字发送：会话命中的回归。

现场（2026-11-08）：微信 4.2 在发送完一条后会把 `current_chat` 短暂读成 None，
旧代码只读一次就当「不在目标会话」，于是又去点会话行；点一下之后标题更久读不到，
再退到搜索框兜底（日志：`点了 'shicm、Zzz.' 但 current_chat=None，回退搜索框`，
一次 open_chat 10 秒）。另外群标题是「成员甲、成员乙」时 DB 里的成员顺序可能不同，
旧的字符串相等会把它判成别的会话。这里锁住「等它刷新 + 成员集合判定」。
"""

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
        self.opened = []
        self.sent = []

    def current_chat(self):
        return self.titles.pop(0) if self.titles else None

    def open_chat(self, keys):
        self.opened.append(tuple(keys))
        return True

    def send_text(self, text):
        self.sent.append(text)
        return True

    def back_to_chat_tab(self):
        return True


def make(uia, aliases):
    logs = []
    env = {
        'G': types.SimpleNamespace(
            log=lambda *a: logs.append(' '.join(str(x) for x in a)),
            log_warn=lambda *a: logs.append(' '.join(str(x) for x in a)),
            time=types.SimpleNamespace(time=lambda: 1.0, sleep=lambda d: None),
            BACKGROUND_SEND=False,
            STICKER_TEST_ON=False,
            _chat_identity_level=_chat_identity_level,
            ChatIdentityError=type('ChatIdentityError', (Exception,), {}),
        ),
        'self': types.SimpleNamespace(
            account_send_allowed=lambda w: True,
            wechat_window_alive=lambda: True,
            gui_lock=threading.Lock(),
            UIA_CACHE={'u': uia},
            gui=types.SimpleNamespace(_get_uia=lambda: uia),
            aliases_for=lambda username, who: list(aliases),
            open_cache={},
            install_quiet_uia=lambda u: None,
            _require_chat_identity=lambda u, who, keys, where: u.current_chat(),
            _input_value=lambda u: '',
            press_enter=lambda flag: None,
        ),
        'logs': logs,
    }
    return env, logs


class UiaSendTarget(unittest.TestCase):
    def test_waits_out_none_instead_of_clicking(self):
        uia = FakeUIA([None, None, '成员甲、成员乙'])
        env, _ = make(uia, ['成员乙、成员甲'])
        fn = load_function('uia_send', env)
        self.assertTrue(fn('你好', '成员甲、成员乙', 'example-group@chatroom'))
        self.assertEqual(uia.opened, [], '标题只是还没刷新，不该去点会话行')
        self.assertEqual(uia.sent, ['你好'])

    def test_member_order_from_db_still_counts_as_current_chat(self):
        uia = FakeUIA(['成员甲、成员乙'])
        env, _ = make(uia, ['成员乙、成员甲'])
        fn = load_function('uia_send', env)
        self.assertTrue(fn('你好', '成员甲、成员乙', 'example-group@chatroom'))
        self.assertEqual(uia.opened, [])

    def test_clicks_only_when_a_different_chat_is_really_open(self):
        uia = FakeUIA(['另一个会话', '成员甲、成员乙'])
        env, _ = make(uia, ['成员甲、成员乙'])
        fn = load_function('uia_send', env)
        self.assertTrue(fn('你好', '成员甲、成员乙', 'example-group@chatroom'))
        self.assertEqual(len(uia.opened), 1)


if __name__ == '__main__':
    unittest.main()

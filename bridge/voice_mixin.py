# -*- coding: utf-8 -*-
"""Bridge runtime mixin: VoiceMixin."""
import engine as G


class VoiceMixin:

    def voice_target_ready(self, username, who, hwnd):
        """确认目标会话已打开并返回显示名；失败返回 ''（同时说明原因）。

        现场：自动语音每次都停在「阶段=等待发送通道 原因=无法确认目标账号或会话」，
        而同一时刻文字发送的 [核对] 是通过的。原因是这里只读一次 current_chat：
        微信 4.2 在 open_chat 之后会短暂把它读成 None，旧代码于是直接返回空，
        白白回退文字。文字通道有重试，所以一直好使。
        """
        if (not self.group_is_alive(username)
                or not self.sticker_quarantine_allows(username, who)
                or not self.account_send_allowed('自动语音发送前')):
            G.log('[voice] 发送前检查没通过（会话/草稿/账号），放弃这次语音')
            return ''
        if int(self.ACCOUNT.get('hwnd') or 0) != hwnd:
            G.log('[voice] 目标窗口已变化，放弃这次语音')
            return ''
        with self.gui_lock:
            if self.gui is None:
                self.gui = self.WeChatGUI()
            self.bind_gui_window(self.gui)
            u = self.gui._get_uia()
            if u is None:
                G.log('[voice] UIA 不可用，放弃这次语音')
                return ''
            keys = self.aliases_for(username, who)

            def current():
                try:
                    return str(u.current_chat() or '')
                except Exception:
                    return ''

            def matched(title):
                """和文字发送同一套身份判定：完全相同，或「成员甲、成员乙」集合吻合。

                实测：未命名的群在 contact.db 里成员顺序是「Zzz.、shicm」，会话列表
                标题却是「shicm、Zzz.」。语音这里以前用字符串相等，群聊永远对不上
                （日志：无法确认会话：当前='shicm、Zzz.' 期望=['Zzz.、shicm']）；
                文字通道用的是 _chat_identity_level，所以文字一直好使。
                """
                if not title:
                    return False
                try:
                    return G._chat_identity_level(title, keys) is not None
                except Exception:
                    return title in keys

            cur = current()
            # 读不到标题时先等 UI 刷新，不要立刻判「会话不对」。
            for _ in range(12):
                if matched(cur):
                    return cur
                if cur:
                    break
                G.time.sleep(0.25)
                cur = current()
            if not matched(cur):
                try:
                    u.open_chat(keys)
                except Exception as exc:
                    G.log('[voice] 切换目标会话失败：%s: %s' % (type(exc).__name__, exc))
                for _ in range(12):
                    cur = current()
                    if matched(cur):
                        return cur
                    G.time.sleep(0.25)
            if not matched(cur):
                G.log('[voice] 无法确认会话：当前=%r 期望=%r' % (cur, keys))
                return ''
            return cur

    def send_voice_reply(self, text, who, username, cancelled=None, outcome=None):
        if not self.group_is_alive(username) or not self.account_send_allowed('自动语音'):
            return False
        if cancelled is not None and cancelled():
            if outcome is not None:
                outcome.update(Status='failed', Error='语音测试已取消')
            return False
        hwnd = int(self.ACCOUNT.get('hwnd') or 0)
        if not hwnd:
            return False

        def prepare():
            return self.voice_target_ready(username, who, hwnd)

        return G.voice_reply.deliver(G.ROOT, text, hwnd, prepare, G.log, cancelled=cancelled, outcome=outcome, send_lock=self.send_lock)

    def voice_test_loop(self):
        while True:
            try:
                G.voice_send_test.process_pending(G.ROOT, self.send_voice_reply)
            except Exception:
                pass
            G.time.sleep(0.25)

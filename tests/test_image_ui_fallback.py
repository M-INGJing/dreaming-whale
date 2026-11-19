import io
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

try:
    from PIL import Image
except ImportError:
    raise unittest.SkipTest('图片预览测试需要 Pillow')

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from image_ui_fallback import (
    PreviewUnavailable, build_preview_request, capture_preview_image, read_image_via_ui,
)


class ImagePreviewTests(unittest.TestCase):
    def setUp(self):
        self.main, self.preview, self.pid = 100, 200, 42
        self.foreground = self.main
        self.windows = {self.main: (self.pid, 'mmui::MainWindow', '微信', self.main)}
        self.rect = SimpleNamespace(left=0, top=100, right=600, bottom=300)
        self.row = SimpleNamespace(BoundingRectangle=self.rect, IsOffscreen=False)
        self.win = SimpleNamespace(
            IsWindow=lambda h: h in self.windows,
            IsWindowVisible=lambda h: h in self.windows,
            IsIconic=lambda h: False,
            GetForegroundWindow=lambda: self.foreground,
            GetClassName=lambda h: self.windows[h][1],
            GetWindowText=lambda h: self.windows[h][2],
            GetAncestor=lambda h, mode: self.windows[h][3] if mode == 3 else h,
            WindowFromPoint=Mock(return_value=self.main),
            EnumWindows=lambda fn, arg: [fn(hwnd, arg) for hwnd in tuple(self.windows)],
            PostMessage=Mock(),
        )
        self.process = SimpleNamespace(GetWindowThreadProcessId=lambda h: (1, self.windows[h][0]))
        self.uia = SimpleNamespace(
            current_chat=Mock(return_value='测试会话'),
            _message_list=lambda: SimpleNamespace(BoundingRectangle=self.rect),
        )
        self.locator = SimpleNamespace(
            _visible_rows=lambda messages: [('image', '图片', self.row)],
            _align_index=Mock(return_value=0),
            _bubble_click_xs=lambda rect, own: [170, 430],
        )
        self.inp = SimpleNamespace(real_click=Mock(side_effect=lambda *args: self.open_preview()))
        image = Image.new('RGB', (400, 300), 'white')
        image.paste('blue', (0, 0, 200, 150))
        self.grab = Mock(return_value=image)
        self.request = {'hwnd': self.main, 'pid': self.pid, 'chat': '测试会话', 'target': 0,
                        'sequence': [{'kind': 'image', 'content': '', 'local_id': 0}], 'is_self': False}

    def open_preview(self, pid=None, owner=None):
        self.windows[self.preview] = (pid or self.pid, 'Qt663QWindowIcon', '图片和视频', owner or self.main)
        self.foreground = self.preview

    def capture(self):
        return capture_preview_image(
            self.request, win=self.win, process=self.process, uia=self.uia, locator=self.locator,
            inp=self.inp, grab=self.grab, pause=lambda seconds: None,
        )

    def test_captures_and_closes_only_the_preview_opened_for_the_matched_image(self):
        raw = self.capture()
        with Image.open(io.BytesIO(raw)) as image:
            self.assertEqual(image.size, (400, 300))
            self.assertGreater(image.getpixel((12, 12))[2], 200)
        self.inp.real_click.assert_called_once_with(170, 200)
        self.grab.assert_called_once_with(window=self.preview)
        self.win.PostMessage.assert_called_once_with(self.preview, 0x0010, 0, 0)

    def test_wrong_conversation_or_ambiguous_message_never_clicks(self):
        self.uia.current_chat.return_value = '另一会话'
        with self.assertRaisesRegex(PreviewUnavailable, 'conversation_mismatch'):
            self.capture()
        self.uia.current_chat.return_value = self.request['chat']
        self.locator._align_index.return_value = None
        with self.assertRaisesRegex(PreviewUnavailable, 'message_not_aligned'):
            self.capture()
        self.inp.real_click.assert_not_called()
        self.grab.assert_not_called()

    def test_click_point_must_belong_to_bound_window(self):
        self.win.WindowFromPoint.return_value = 999
        with self.assertRaisesRegex(PreviewUnavailable, 'message_not_aligned'):
            self.capture()
        self.inp.real_click.assert_not_called()

    def test_focus_loss_during_hit_test_stops_the_click(self):
        def covered(point):
            self.foreground = 999
            return self.main

        self.win.WindowFromPoint.side_effect = covered
        with self.assertRaisesRegex(PreviewUnavailable, 'wechat_not_foreground'):
            self.capture()
        self.inp.real_click.assert_not_called()

    def test_existing_preview_is_neither_captured_nor_closed(self):
        self.open_preview()
        self.foreground = self.main
        with self.assertRaisesRegex(PreviewUnavailable, 'preview_changed'):
            self.capture()
        self.grab.assert_not_called()
        self.win.PostMessage.assert_not_called()

    def test_preview_in_other_process_or_owned_by_other_window_is_rejected(self):
        for pid, owner in [(55, self.main), (self.pid, 333)]:
            self.foreground = self.main
            self.windows.pop(self.preview, None)
            self.inp.real_click.side_effect = lambda *args: self.open_preview(pid, owner)
            with self.assertRaisesRegex(PreviewUnavailable, 'preview_changed'):
                self.capture()
        self.grab.assert_not_called()
        self.win.PostMessage.assert_not_called()

    def test_focus_change_while_capturing_discards_bytes_without_closing_other_window(self):
        def capture_and_switch(**kwargs):
            self.foreground = 999
            return self.grab.return_value

        self.grab.side_effect = capture_and_switch
        with self.assertRaisesRegex(PreviewUnavailable, 'preview_changed'):
            self.capture()
        self.win.PostMessage.assert_not_called()

    def test_request_uses_shard_identity_and_leaves_private_fields_out(self):
        photo1 = {'type': '图片', 'local_id': 7, 'shard': 'first', 'sender_username': 'someone',
                  'content': '<image data=private>', 'packed_info': b'private'}
        photo2 = {**photo1, 'shard': 'second', 'sender_username': 'self-fixture'}
        text = {'type': '文本', 'content': 'A' * 800}
        db = SimpleNamespace(wxid='self-fixture', get_messages=Mock(return_value=[photo2, text, photo1]))
        msg = {'username': 'peer', 'local_id': 7, 'shard': 'second'}
        request = build_preview_request(db, msg, '测试会话', self.main, self.pid)
        self.assertEqual(request['target'], 2)
        self.assertTrue(request['is_self'])
        self.assertEqual(len(request['sequence'][1]['content']), 160)
        self.assertNotIn('private', json.dumps(request))
        self.assertIsNone(build_preview_request(db, {**msg, 'shard': None}, '测试会话', self.main, self.pid))

    def test_worker_errors_log_fixed_reason_instead_of_stderr(self):
        run = Mock(return_value=SimpleNamespace(returncode=3, stdout=b'privileged payload'))
        log = Mock()
        self.assertEqual(read_image_via_ui(self.request, log, run=run), b'')
        self.assertIn('reason=conversation_mismatch', log.call_args.args[0])
        self.assertNotIn('privileged', str(log.mock_calls))
        self.assertEqual(run.call_args.kwargs['stderr'], subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()

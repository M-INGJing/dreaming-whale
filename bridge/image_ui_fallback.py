"""用微信已经渲染的预览补救聊天图片读取失败。原生调用只在限时子进程执行。"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
from contextlib import redirect_stdout

CAPTURE_TIMEOUT = 12
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_HISTORY = 300
MAX_REQUEST_BYTES = 128 * 1024
FAILURES = (
    '', 'internal_error', 'wechat_not_foreground', 'conversation_mismatch',
    'message_not_aligned', 'preview_not_opened', 'preview_changed', 'capture_unavailable',
)


class PreviewUnavailable(RuntimeError):
    pass


def build_preview_request(db, msg, chat_name, hwnd, pid):
    """只传定位所需的消息摘要。用独立序号避免不同分片的同号图片错配。"""
    username, local_id = msg.get('username'), msg.get('local_id')
    shard = msg.get('shard')
    chat_name = (chat_name or '').strip()
    if not username or local_id is None or not chat_name:
        return None
    sequence, targets = [], []
    for row in reversed(db.get_messages(username, limit=MAX_HISTORY)):
        kind = {'文本': 'text', '图片': 'image'}.get(row.get('type'))
        content = str(row.get('content') or '')
        if kind is None and '<title>' in content:
            # 引用/卡片类 appmsg 在界面上就是一行文字（标题 + 引用块），
            # 序列里必须按文本对待；否则可视行比序列多一行，对齐全错位。
            import re as _re
            import html as _html
            _m = _re.search(r'<title>(.*?)</title>', content, _re.S)
            if _m:
                kind = 'text'
                content = _html.unescape(_m.group(1)).strip()
        if not kind:
            continue
        index = len(sequence)
        anchor = content.strip()[:160] if kind == 'text' else ''
        sequence.append({'kind': kind, 'content': anchor, 'local_id': index})
        if (kind == 'image' and row.get('local_id') == local_id
                and (not shard or row.get('shard') == shard)):
            targets.append((index, row))
    if len(targets) != 1:
        return None
    index, row = targets[0]
    self_id = getattr(db, 'wxid', None)
    return {'hwnd': hwnd, 'pid': pid, 'chat': chat_name, 'sequence': sequence, 'target': index,
            'is_self': bool(self_id and row.get('sender_username') == self_id),
            'newest': index >= len(sequence) - 1}


def _visible_previews(win, process, main, pid):
    handles = set()

    def collect(hwnd, _):
        try:
            if (hwnd != main and win.IsWindowVisible(hwnd) and not win.IsIconic(hwnd)
                    and process.GetWindowThreadProcessId(hwnd)[1] == pid
                    and win.GetAncestor(hwnd, 3) in (main, hwnd)):
                cls = win.GetClassName(hwnd)
                if cls == 'mmui::PreviewWindow' or (
                        cls.startswith('Qt') and win.GetWindowText(hwnd).strip() in (
                            '图片和视频', '圖片和影片', 'Pictures and Videos')):
                    handles.add(hwnd)
        except Exception:
            # 枚举过程中窗口可能已被关闭。
            pass
        return True

    win.EnumWindows(collect, None)
    return handles


def _locate_target_row(locator, messages, request, uia, deadline):
    """把目标消息滚进可视区并返回它的行控件；认不出返回 None。

    先用严格对齐；对不上就借 _align_window 的窗口偏移判断目标在可视区上方还是下方，
    逐格朝那个方向滚，边滚边对齐。到时限或两个方向都滚不动就放弃（绝不猜行）。
    """
    seq, target = request['sequence'], request['target']
    hwnd, pid = request['hwnd'], request['pid']
    rows = locator._visible_rows(messages)
    index = locator._align_index(rows, seq, target)
    if index is not None and 0 <= index < len(rows) and not rows[index][2].IsOffscreen:
        return rows[index][2]
    tried_reverse = False
    last_step = -120                 # 记住上一次成功的滚动方向，对齐失败时沿用
    # 先滚到底建立确定性锚点：从「最新」一端开始，目标只会在上方，
    # 方向判断不会受用户当前滚动位置影响。
    try:
        locator._scroll_list(messages, -120, 20, uia, hwnd, pid)
        time.sleep(0.3)
    except Exception:
        pass
    step = -120                      # 默认先往「更新」方向滚（新图通常在下边）
    while time.time() < deadline:
        rows = locator._visible_rows(messages)
        if rows:
            w = None
            try:
                w = locator._align_window(rows, seq, 0.95, 1)
            except Exception:
                w = None
            if w is not None:
                j = target - w['offset']
                if 0 <= j < len(rows) and not rows[j][2].IsOffscreen:
                    return rows[j][2]
                if j >= len(rows):
                    step, times = -120, min(6, max(1, j - len(rows) + 1))
                else:
                    step, times = 120, min(6, max(2, -j))
                last_step = step
            else:
                # 对齐失败（可视行里图片太多、锚点不够）：沿用上一次的方向，
                # 别直接掉头——掉头会把刚滚过来的目标又滚出去。
                step, times = last_step, 2
        before = [(k, n) for k, n, _ in rows]
        try:
            locator._scroll_list(messages, step, times, uia, hwnd, pid)
        except Exception:
            return None
        time.sleep(0.2)
        after = locator._visible_rows(messages)
        if [(k, n) for k, n, _ in after] == before:
            if tried_reverse:
                return None
            tried_reverse = True
            step = -step
    return None



def capture_preview_image(request, *, win, process, uia, locator, inp, grab, pause=time.sleep):
    main, pid = request['hwnd'], request['pid']
    if (not win.IsWindow(main) or not win.IsWindowVisible(main) or win.IsIconic(main)
            or process.GetWindowThreadProcessId(main)[1] != pid or win.GetForegroundWindow() != main):
        raise PreviewUnavailable('wechat_not_foreground')
    if (uia.current_chat() or '').strip() != request['chat']:
        raise PreviewUnavailable('conversation_mismatch')
    messages = uia._message_list()
    rows = locator._visible_rows(messages) if messages is not None else []
    index = locator._align_index(rows, request['sequence'], request['target'])
    target = rows[index][2] if index is not None and 0 <= index < len(rows) else None
    if target is None and messages is not None:
        target = _locate_target_row(locator, messages, request, uia, time.time() + 8.0)
    if target is None:
        raise PreviewUnavailable('message_not_aligned')
    if target.IsOffscreen:
        raise PreviewUnavailable('message_not_aligned')

    before = _visible_previews(win, process, main, pid)
    preview = None
    clicked = False

    def fresh_preview():
        candidates = _visible_previews(win, process, main, pid) - before
        foreground = win.GetForegroundWindow()
        if len(candidates) > 1 or (foreground not in (0, main) and foreground not in candidates):
            raise PreviewUnavailable('preview_changed')
        if len(candidates) == 1:
            candidate = next(iter(candidates))
            if foreground == candidate or (foreground == main and win.GetAncestor(candidate, 3) == main):
                return candidate
        return None

    try:
        # 只尝试同一条消息发送方一侧的气泡，不滚动或切换其他会话。
        initial = target.BoundingRectangle
        initial_rect = (initial.left, initial.top, initial.right, initial.bottom)
        midpoint = (initial.left + initial.right) / 2
        xs = [x for x in locator._bubble_click_xs(initial, request['is_self'])
              if initial.left <= x < initial.right and (x > midpoint) == request['is_self']][:2]
        for x in xs:
            candidate = fresh_preview()
            if candidate:
                if not clicked:
                    raise PreviewUnavailable('preview_changed')
                preview = candidate
                break
            if win.GetForegroundWindow() != main or (uia.current_chat() or '').strip() != request['chat']:
                raise PreviewUnavailable('conversation_mismatch')
            rect = target.BoundingRectangle
            bounds = messages.BoundingRectangle
            y = (rect.top + rect.bottom) // 2
            if ((rect.left, rect.top, rect.right, rect.bottom) != initial_rect or target.IsOffscreen or
                    not (bounds.left <= x < bounds.right and bounds.top <= y < bounds.bottom) or
                    win.GetAncestor(win.WindowFromPoint((x, y)), 2) != main):
                raise PreviewUnavailable('message_not_aligned')
            if (win.GetForegroundWindow() != main
                    or process.GetWindowThreadProcessId(main)[1] != pid):
                raise PreviewUnavailable('wechat_not_foreground')
            inp.real_click(x, y)
            clicked = True
            for _ in range(12):
                pause(0.12)
                preview = fresh_preview()
                if preview:
                    break
            if preview:
                break
        if not preview:
            raise PreviewUnavailable('preview_not_opened')

        # 通过窗口句柄获取画面，避免把聊天列表或遮挡预览的窗口送去识图。
        pause(0.4)
        if fresh_preview() != preview:
            raise PreviewUnavailable('preview_changed')
        image = grab(window=preview).convert('RGB')
        if fresh_preview() != preview:
            raise PreviewUnavailable('preview_changed')
        if min(image.size) < 120 or all(lo == hi for lo, hi in image.getextrema()):
            raise PreviewUnavailable('capture_unavailable')
        image.thumbnail((2560, 2560))
        out = io.BytesIO()
        image.save(out, format='JPEG', quality=88)
        data = out.getvalue()
        if len(data) > MAX_IMAGE_BYTES:
            raise PreviewUnavailable('capture_unavailable')
        return data
    finally:
        # 只关闭本次打开、仍归属已核验微信窗口的预览。焦点改变后交给用户处理。
        if preview:
            try:
                if fresh_preview() == preview:
                    win.PostMessage(preview, 0x0010, 0, 0)  # WM_CLOSE
            except Exception:
                pass


def read_image_via_ui(request, log, *, timeout=CAPTURE_TIMEOUT, run=None):
    """父进程只等固定时限。UIA 或截图库挂起时，由 subprocess 终止并回收子进程。"""
    try:
        payload = json.dumps(request, ensure_ascii=False).encode('utf-8')
        if len(payload) > MAX_REQUEST_BYTES:
            log('图片预览兜底跳过 reason=request_too_large')
            return b''
        result = (run or subprocess.run)(
            [sys.executable, '-X', 'utf8', '-B', os.path.abspath(__file__), '--capture-preview'],
            input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except subprocess.TimeoutExpired:
        log('图片预览兜底子进程超时，已停止（%.0f 秒）' % timeout)
        return b''
    except Exception as exc:
        log('图片预览兜底启动失败 type=%s' % type(exc).__name__)
        return b''
    if result.returncode:
        code = result.returncode
        reason = FAILURES[code] if 0 < code < len(FAILURES) else 'worker_exited'
        log('图片预览兜底未取到图 reason=%s code=%s' % (reason, code))
        return b''
    data = result.stdout
    if not data.startswith(b'\xff\xd8\xff') or len(data) > MAX_IMAGE_BYTES:
        log('图片预览兜底未取到图 reason=invalid_capture')
        return b''
    log('图片预览兜底已取图（%d KB）' % (len(data) // 1024))
    return data


def _worker():
    output = sys.stdout.buffer
    try:
        with redirect_stdout(sys.stderr):
            payload = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
            if len(payload) > MAX_REQUEST_BYTES:
                return 1
            request = json.loads(payload.decode('utf-8'))
            import win32gui as win
            import win32process as process

            hwnd, pid = request['hwnd'], request['pid']
            if (not win.IsWindow(hwnd) or win.GetForegroundWindow() != hwnd
                    or process.GetWindowThreadProcessId(hwnd)[1] != pid):
                return FAILURES.index('wechat_not_foreground')
            import uiautomation as auto
            from PIL import ImageGrab
            from wechatauto import MediaDownloader
            from wechatauto.guia import WinInput
            from wechatauto.uia_driver import WeChatUIA

            uia = WeChatUIA(search_timeout=0.5)
            # 本 fork 的 wechatauto 行类型映射只认 ChatBubbleReferItemView；
            # 微信 4.2 的图片气泡是 ChatImageItemView，补上（只影响本次子进程）。
            try:
                from wechatauto.media import MediaDownloader as _MD
                _MD._UI_ROW_KIND = dict(getattr(_MD, '_UI_ROW_KIND', {}),
                                          **{'mmui::ChatImageItemView': 'image'})
            except Exception:
                pass
            root = auto.ControlFromHandle(hwnd)
            if root is None or root.ProcessId != pid or root.NativeWindowHandle != hwnd:
                return FAILURES.index('wechat_not_foreground')
            # 直接使用已存在的控件树，避免重新搜窗、激活或建立第二个数据库连接。
            uia._win = root
            data = capture_preview_image(
                request, win=win, process=process, uia=uia, locator=MediaDownloader(None),
                inp=WinInput(), grab=ImageGrab.grab,
            )
        output.write(data)
        output.flush()
        return 0
    except PreviewUnavailable as exc:
        return FAILURES.index(exc.args[0])
    except Exception:
        return 1


if __name__ == '__main__' and sys.argv[1:] == ['--capture-preview']:
    sys.exit(_worker())

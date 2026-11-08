# -*- coding: utf-8 -*-
"""收藏别人发的表情包：本地算 sha256/dhash，异步提交内核。

为什么在桥接算 dHash：内核是零依赖 Node，没有图片解码器；桥接已经有 PIL。
提交必须异步：收消息的线程不能等一次网络往返。
"""

import base64
import hashlib
import io
import threading


def fingerprint(raw):
    """返回 (sha256 hex, dhash 16 位 hex)；算不出 dHash 时返回空串。"""
    sha = hashlib.sha256(raw).hexdigest()
    dhash = ''
    try:
        from PIL import Image

        with Image.open(io.BytesIO(raw)) as img:
            img.seek(0)
            gray = img.convert('L').resize((9, 8))
            pixels = list(gray.getdata())
            bits = 0
            for row in range(8):
                base = row * 9
                for col in range(8):
                    bits = (bits << 1) | (1 if pixels[base + col] > pixels[base + col + 1] else 0)
            dhash = '%016x' % bits
    except Exception:  # noqa: BLE001 - 没有 PIL / 图片坏了都只是没有 dHash
        dhash = ''
    return sha, dhash


def submit(post_json, raw, chat_type, chat_id, sender, log=None):
    """提交一张候选；返回内核响应（失败返回 {}）。post_json(path, payload) 由调用方注入。"""
    sha, dhash = fingerprint(raw)
    payload = {
        'image': base64.b64encode(raw).decode('ascii'),
        'mime': 'image/png',
        'sha256': sha,
        'dhash': dhash,
        'chatType': 'group' if chat_type == 'group' else 'private',
        'chatId': str(chat_id or ''),
        'sender': str(sender or '')[:40],
    }
    try:
        out = post_json('/api/stickers/collect', payload) or {}
    except Exception as exc:  # noqa: BLE001
        if log:
            log('表情包收藏：提交失败 %r' % (exc,))
        return {}
    if log:
        if out.get('duplicate'):
            log('表情包收藏：重复，跳过（%s）' % out.get('reason', ''))
        elif out.get('ok'):
            log('表情包收藏：已收 %s' % sha[:8])
        else:
            log('表情包收藏：未收（%s）' % out.get('reason', ''))
    return out


def collect_async(runtime, msg, raw, log=None, http=None):
    """从收到的 emoji 消息里异步收一张；任何异常都不允许影响收消息。

    http 由调用方注入（engine.LOCAL_HTTP 是模块级全局，不在 runtime 上；
    上一版在这里取 runtime.LOCAL_HTTP，结果每张都 AttributeError）。
    """
    try:
        if not raw:
            return
        if len(raw) > 2 * 1024 * 1024:
            return
    except Exception:  # noqa: BLE001
        return

    chat_id = str(msg.get('username') or '')
    chat_type = 'group' if chat_id.endswith('@chatroom') else 'private'
    sender = ''
    try:
        sender = runtime.db.get_nickname(msg.get('sender_username')) or ''
    except Exception:  # noqa: BLE001
        sender = ''

    def run():
        try:
            client = http or getattr(runtime, 'LOCAL_HTTP', None)
            if client is None:
                if log:
                    log('表情包收藏：没有可用的 HTTP 客户端，跳过')
                return

            def post_json(path, payload):
                resp = client.post(
                    runtime.sticker_base + path,
                    json=payload,
                    headers=runtime.sticker_headers,
                    timeout=15,
                )
                return resp.json() if getattr(resp, 'status_code', 0) == 200 else {}

            submit(post_json, raw, chat_type, chat_id, sender, log=log)
        except Exception as exc:  # noqa: BLE001
            if log:
                log('表情包收藏：后台提交异常 %r' % (exc,))

    try:
        threading.Thread(target=run, daemon=True, name='sticker-collect').start()
    except Exception:  # noqa: BLE001
        pass

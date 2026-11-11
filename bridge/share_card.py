# -*- coding: utf-8 -*-
"""把 B 站分享合成一张「封面卡片」图片（核心里没有图片库，放在桥接侧做）。

微信原生链接卡片是协议层的 appmsg，UIA 只能粘贴文字；这里退一步：
封面 + 标题 + BV 号合成一张图，先发图再发短链接。视觉上接近卡片，点图不能跳转。
"""

import io
import os
import re
import urllib.request

CARD_W = 720
CARD_H = 500
COVER_H = 400
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'


def _font(size, bold=False):
    from PIL import ImageFont
    names = ['msyhbd.ttc', 'msyh.ttc'] if bold else ['msyh.ttc', 'simhei.ttf']
    for name in names:
        path = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts', name)
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:  # noqa: BLE001
                continue
    return ImageFont.load_default()


def _download_cover(url, timeout=10, limit=6 * 1024 * 1024):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Referer': 'https://www.bilibili.com/',
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read(limit + 1)
    if len(data) > limit:
        raise ValueError('cover too large')
    return data


def _wrap(draw, text, font, max_width, max_lines=2):
    lines = []
    current = ''
    for ch in str(text or ''):
        probe = current + ch
        if draw.textlength(probe, font=font) <= max_width:
            current = probe
            continue
        if current:
            lines.append(current)
        current = ch
        if len(lines) >= max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    if len(lines) == max_lines and draw.textlength(''.join(lines), font=font) > 0:
        # 超出两行的部分用省略号收尾
        last = lines[-1]
        while last and draw.textlength(last + '…', font=font) > max_width:
            last = last[:-1]
        lines[-1] = (last + '…') if len(''.join(lines)) < len(str(text or '')) else lines[-1]
    return lines


def make_card(job, out_dir=None, log=None):
    """job: {id,bvid,title,cover}。返回图片路径；失败返回 None（调用方退回纯文字）。"""
    try:
        from PIL import Image, ImageDraw
    except Exception as exc:  # noqa: BLE001
        if log:
            log('B 站分享：没有 Pillow，跳过封面卡片（%s）' % type(exc).__name__)
        return None
    cover_url = str((job or {}).get('cover') or '').strip()
    if not re.match(r'^https?://', cover_url, re.I):
        return None
    title = str((job or {}).get('title') or '').strip() or str((job or {}).get('bvid') or '')
    bvid = str((job or {}).get('bvid') or '')
    try:
        raw = _download_cover(cover_url)
        cover = Image.open(io.BytesIO(raw)).convert('RGB')
    except Exception as exc:  # noqa: BLE001
        if log:
            log('B 站分享：封面下载失败（%s），改发纯文字' % type(exc).__name__)
        return None

    # 封面裁成 16:9 填满上半部分
    target_ratio = CARD_W / COVER_H
    w, h = cover.size
    if w / max(1, h) > target_ratio:
        nw = int(h * target_ratio)
        cover = cover.crop(((w - nw) // 2, 0, (w + nw) // 2, h))
    else:
        nh = int(w / target_ratio)
        cover = cover.crop((0, max(0, (h - nh) // 2), w, max(0, (h - nh) // 2) + nh))
    cover = cover.resize((CARD_W, COVER_H), Image.LANCZOS)

    card = Image.new('RGB', (CARD_W, CARD_H), '#ffffff')
    card.paste(cover, (0, 0))
    draw = ImageDraw.Draw(card)
    # B 站粉色小标签
    draw.rectangle([0, 0, 96, 34], fill='#fb7299')
    draw.text((14, 8), 'B 站', font=_font(18, bold=True), fill='#ffffff')
    # 底部标题区
    title_font = _font(24, bold=True)
    meta_font = _font(16)
    lines = _wrap(draw, title, title_font, CARD_W - 48, max_lines=2)
    y = COVER_H + 14
    for line in lines:
        draw.text((24, y), line, font=title_font, fill='#18191c')
        y += 32
    meta = ('BV ' + bvid) if bvid else ''
    draw.text((24, CARD_H - 30), meta, font=meta_font, fill='#9499a0')
    draw.text((CARD_W - 150, CARD_H - 30), 'bilibili.com', font=meta_font, fill='#9499a0')

    dir_path = out_dir or os.path.join('data', 'bili', 'share-cards')
    os.makedirs(dir_path, exist_ok=True)
    safe = re.sub(r'[^0-9A-Za-z_.-]', '', str((job or {}).get('id') or bvid) or 'card')[:60]
    path = os.path.join(dir_path, (safe or 'card') + '.jpg')
    card.save(path, 'JPEG', quality=90)
    if log:
        log('B 站分享：封面卡片已生成（%s）' % os.path.basename(path))
    return path

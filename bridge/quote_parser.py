# -*- coding: utf-8 -*-
"""微信「引用回复」消息解析（纯函数，不依赖 engine / wechatauto，可单独测）。

微信的引用回复是 appmsg（类型号 57<<32|49，类型名落到「文件/链接/卡片」），
正文是一条没有 <url> 的 XML；老的链接解析找不到 <url> 就把整条丢掉 ——
用户「引用一句再回」时机器人像没收到。这里把 XML 拆成「被引用者 / 被引用正文 /
这次新打的字」，再拼成一句模型能看懂的正文。
"""
import html
import re
import xml.etree.ElementTree as _et


def _nested_quote_text(quoted):
    """被引用的内容本身还是 XML（多层引用）时，往里剥最多两层拿纯文字。"""
    for _ in range(2):
        if quoted.startswith('<') and '<refermsg' in quoted:
            inner = re.search(r'<refermsg>.*?</refermsg>', quoted, re.S)
            if inner:
                content = re.search(r'<content>(.*?)</content>', inner.group(0), re.S)
                if content:
                    quoted = html.unescape(content.group(1)).strip()
                    continue
        break
    return quoted


def parse_quote_content(content):
    """把微信的引用消息 XML 拆成 (被引用者, 被引用正文, 这次新打的字)。

    微信 4.x 把引用者这次真正打的字放在 <title> 里；老版本放在最后一个 </msg>
    之后。两者都取，优先取 </msg> 之后那段。

    没有完整引用结构或类型不符时返回 None，交给原来的类型分支处理。
    """
    if '<refermsg' not in str(content or ''):
        return None
    content = str(content)
    end = content.rfind('</msg>')
    if end < 0:
        return None
    try:
        root = _et.fromstring(content[:end + len('</msg>')])
    except _et.ParseError:
        return None
    if root.tag != 'msg':
        return None
    apps = root.findall('appmsg')
    if len(apps) > 1:
        return None
    envelope = apps[0] if apps else root
    if len(envelope.findall('refermsg')) != 1:
        return None
    quote_type = envelope.findtext('type')
    if quote_type is not None and quote_type.strip() != '57':
        return None
    quoted_by = quoted = ''
    block = re.search(r'<refermsg>.*?</refermsg>', content, re.S)
    if block:
        body = block.group(0)
        name = re.search(r'<displayname>(.*?)</displayname>', body, re.S)
        said = re.search(r'<content>(.*?)</content>', body, re.S)
        quoted_by = html.unescape(name.group(1)).strip() if name else ''
        quoted = html.unescape(said.group(1)).strip() if said else ''
    quoted = _nested_quote_text(quoted)
    tail = html.unescape(content.rsplit('</msg>', 1)[-1]).strip() if '</msg>' in content else ''
    title = re.search(r'<title>(.*?)</title>', content, re.S)
    reply = tail or (html.unescape(title.group(1)).strip() if title else '')
    return quoted_by, quoted, reply


def quote_content_text(content):
    """引用消息转成给模型看的正文；不是引用返回 None，是引用但没有可读内容返回空串。"""
    parsed = parse_quote_content(content)
    if parsed is None:
        return None
    quoted_by, quoted, reply = parsed
    if not quoted and not reply:
        return ''
    if quoted and reply:
        return ('（引用%s「%s」）%s' % (quoted_by or '对方', quoted, reply)).strip()
    if reply:
        return reply
    return ('（引用%s「%s」）' % (quoted_by or '对方', quoted)).strip()

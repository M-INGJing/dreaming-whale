# -*- coding: utf-8 -*-
"""微信「引用回复」解析的回归测试（纯函数，不连微信、不导 engine）。"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'bridge') not in sys.path:
    sys.path.insert(0, str(ROOT / 'bridge'))

from quote_parser import parse_quote_content, quote_content_text  # noqa: E402


def _quote_xml(title='好的没问题', name='小明', said='明天一起吃饭吗'):
    return (
        '<msg><appmsg appid="" sdkver="0">'
        '<title>%s</title><des></des><action></action><type>57</type><showtype>0</showtype>'
        '<content></content><url></url><lowurl></lowurl>'
        '<refermsg><type>1</type><svrid>123</svrid><fromusr>wxid_a</fromusr>'
        '<chatusr>wxid_b</chatusr><displayname>%s</displayname><content>%s</content>'
        '</refermsg></appmsg></msg>'
    ) % (title, name, said)


class QuoteParserTest(unittest.TestCase):
    def test_parse_full_quote(self):
        by, said, reply = parse_quote_content(_quote_xml())
        self.assertEqual(by, '小明')
        self.assertEqual(said, '明天一起吃饭吗')
        self.assertEqual(reply, '好的没问题')

    def test_text_combines_quote_and_reply(self):
        text = quote_content_text(_quote_xml())
        self.assertEqual(text, '（引用小明「明天一起吃饭吗」）好的没问题')

    def test_reply_in_tail_after_msg(self):
        xml = _quote_xml() + '尾巴补充'
        by, said, reply = parse_quote_content(xml)
        self.assertEqual(reply, '尾巴补充')

    def test_non_quote_returns_none(self):
        self.assertIsNone(quote_content_text('普通文本'))
        self.assertIsNone(parse_quote_content('<msg><appmsg><title>x</title></appmsg></msg>'))

    def test_nested_quote_peeled(self):
        # 多层引用：被引用内容本身又是一个完整 refermsg XML 时，往里剥出纯文字。
        from quote_parser import _nested_quote_text
        nested = '<refermsg><displayname>小红</displayname><content>再往下剥一层</content></refermsg>'
        self.assertEqual(_nested_quote_text(nested), '再往下剥一层')
        self.assertEqual(_nested_quote_text('普通文字'), '普通文字')

    def test_empty_quote_returns_empty(self):
        xml = _quote_xml(title='', name='', said='')
        self.assertEqual(quote_content_text(xml), '')


if __name__ == '__main__':
    unittest.main()

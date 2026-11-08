# -*- coding: utf-8 -*-
"""桥接启动路径上的「未定义异常变量」回归。

为什么要有这条：4.0.8 的桥接模块化（bridge/app.py）里混进了一行
`G.log('朋友圈读取通道未启动 type=%s' % type(exc).__name__)`——它既不在
`except ... as exc` 里，也没有任何地方绑定 `exc`。结果是桥接把该起的线程都起完、
日志打得像要好了，然后 `NameError: name 'exc' is not defined` 直接退出（code=1），
用户看到的是「桥接已退出」，真实原因却只是一行残留。

静态检查比「真的起一遍桥接」便宜得多：起桥接要微信、要 admin、要数据库密钥，
这条用例只解析源码，几毫秒就能在 CI 里挡住同类残留。
"""

import ast
import builtins
import glob
import os
import symtable
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE_FILES = sorted(glob.glob(os.path.join(ROOT, 'bridge', '*.py')))
EXAMPLES_FILES = sorted(glob.glob(os.path.join(ROOT, 'examples', '*.py')))

# 只查「约定俗成由 except ... as X 绑定」的名字：这类名字一旦没绑定就是必崩的
# NameError（普通变量写错通常还有别的测试会碰到，这里不重复造 pyflakes）。
EXCEPTION_ALIASES = {'exc', 'error', 'err'}

# 模块级由解释器注入的名字，不属于「未定义」
MODULE_DUNDERS = {'__file__', '__name__', '__doc__', '__package__', '__builtins__',
                  '__spec__', '__loader__', '__cached__'}


def find_undefined_globals(source, filename='<test>'):
    """返回 [(作用域名, 名字, 行号)]：读了模块里没定义、也不是内置的全局名。

    用 symtable 判作用域，嵌套函数捕获外层变量不会被误报。
    """
    table = symtable.symtable(source, filename, 'exec')
    known = set(table.get_identifiers()) | MODULE_DUNDERS | set(dir(builtins))
    problems = []

    def walk(scope, enclosing):
        bound = {s.get_name() for s in scope.get_symbols()
                 if s.is_assigned() or s.is_parameter() or s.is_imported() or s.is_namespace()}
        visible = set(enclosing) | bound
        for symbol in scope.get_symbols():
            name = symbol.get_name()
            if name in bound or name in visible or name in known:
                continue
            if symbol.is_referenced() or symbol.is_global() or symbol.is_free():
                problems.append((scope.get_name(), name, scope.get_lineno()))
        for child in scope.get_children():
            walk(child, visible)

    walk(table, set())
    return problems


def _bound_names(fn):
    """函数作用域里被绑定过的名字（参数、赋值、import、except 别名、with as 等）。"""
    names = set()
    for node in ast.walk(fn):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            args = node.args
            for arg in list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs):
                names.add(arg.arg)
            if args.vararg:
                names.add(args.vararg.arg)
            if args.kwarg:
                names.add(args.kwarg.arg)
        elif isinstance(node, ast.ExceptHandler):
            if node.name:
                names.add(node.name)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add((alias.asname or alias.name).split('.')[0])
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names.update(node.names)
    return names


def find_unbound_exception_aliases(source, filename='<test>'):
    """返回 [(函数名, 名字, 行号)]：函数里读了一个自己从没绑定过的异常别名。"""
    tree = ast.parse(source, filename)
    problems = []
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        bound = _bound_names(fn)
        for node in ast.walk(fn):
            if (isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
                    and node.id in EXCEPTION_ALIASES and node.id not in bound):
                problems.append((fn.name, node.id, node.lineno))
    return problems


LEGACY_SNIPPET = '''
class BridgeRuntime:
    def start(self):
        G.REMINDER_RUNNER = self.start_reminder_watch()
        G.log('朋友圈读取通道未启动 type=%s' % type(exc).__name__)
        return 0
'''


class BridgeUndefinedNames(unittest.TestCase):
    def test_checker_catches_the_regression(self):
        """自检：这条规则必须能抓住当初那行残留（修复前失败）。"""
        problems = find_unbound_exception_aliases(LEGACY_SNIPPET, 'legacy_app.py')
        self.assertEqual([('start', 'exc', 5)], problems)

    def test_no_unbound_exception_alias_in_bridge(self):
        """bridge/*.py 里不许出现只读不绑定的 exc / error / err。"""
        self.assertTrue(BRIDGE_FILES, '没找到 bridge/*.py，路径不对')
        broken = []
        for path in BRIDGE_FILES:
            with open(path, encoding='utf-8-sig') as fh:
                source = fh.read()
            for fn_name, name, lineno in find_unbound_exception_aliases(
                    source, os.path.basename(path)):
                broken.append('%s:%d 在 %s() 里引用了未绑定的 %r' % (
                    os.path.basename(path), lineno, fn_name, name))
        self.assertEqual([], broken, '未定义的异常变量会让桥接启动直接 NameError')

    def test_no_undefined_global_names_in_bridge_and_examples(self):
        """更广一层：函数里读不到定义的全局名同样会在运行时 NameError。

        用 symtable 判作用域（嵌套函数/闭包不会被误报），只认「在模块里没定义、
        也不是内置」的名字——正好覆盖当初那行 `type(exc)` 之外的同类残留。
        """
        broken = []
        for path in BRIDGE_FILES + EXAMPLES_FILES:
            with open(path, encoding='utf-8-sig') as fh:
                source = fh.read()
            for scope, name, lineno in find_undefined_globals(
                    source, os.path.basename(path)):
                broken.append('%s 的 %s 引用了未定义的名字 %r（symtable 行 %s）' % (
                    os.path.basename(path), scope, name, lineno))
        self.assertEqual([], broken)

    def test_undefined_global_checker_catches_a_nameerror(self):
        problems = find_undefined_globals(
            'def broken():\n    return not_defined_anywhere\n', 'sample.py')
        self.assertTrue(any(name == 'not_defined_anywhere' for _s, name, _l in problems), problems)


if __name__ == '__main__':
    unittest.main()

# -*- coding: utf-8 -*-
"""窗口恢复判定（纯逻辑，方便单测）。

微信最小化到任务栏 / 收进托盘时，UIA 树是空壳：只 SetWindowPos 不会把它恢复，
必须先 ShowWindow(SW_RESTORE / SW_SHOW)。这里只回答「要不要恢复、按什么顺序」。
"""

SW_SHOW = 5
SW_RESTORE = 9


def needs_restore(iconic, visible):
    return bool(iconic) or not bool(visible)


def restore_calls(iconic, visible):
    """返回需要依次调用的 ShowWindow 常量；空列表表示不用恢复。"""
    calls = []
    if not visible:
        calls.append(SW_SHOW)
    if iconic:
        calls.append(SW_RESTORE)
    return calls

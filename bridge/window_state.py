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


def describe_window(iconic, visible, disconnected=False):
    """把窗口现场翻译成心跳里给人看的一句话。

    为什么要单独判「会话断连」：RDP 断开后 Windows 会把该会话的窗口统一标成
    最小化（坐标挪到 -32000），但用户并没有点最小化。以前这里只报「已最小化」，
    排查时会被带到「把微信窗口打开」这种错误方向上去——真正的原因是整台会话
    没有前台，只有 tscon 回 console 才能恢复。
    """
    if disconnected:
        return '已断连（RDP，会话无前台）'
    if iconic:
        return '已最小化'
    if not visible:
        return '在托盘（窗口隐藏）'
    return '可见'


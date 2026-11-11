# -*- coding: utf-8 -*-
"""B 站分享：桥接侧的「取一条 → 领取 → 发送 → 回执」。

判断该不该发、发给谁全在内核（/api/bili/pending 已经过滤好），这里只做传送带，
所以是一个纯函数 `watch_once`，方便用假 HTTP 做单测（不起微信、不联网）。
"""


def watch_once(get_json, post_json, send_text, log=None, send_image=None, make_card=None):
    """跑一轮。返回 'idle' / 'sent' / 'failed' / 'claim_failed' / 'error'。

    send_image / make_card 可选：有封面时先发一张「封面卡片」图，再发文字链接。
    图片失败不影响文字（最多回到原来的纯文字分享）。
    """
    try:
        data = get_json('/api/bili/pending') or {}
    except Exception as exc:  # noqa: BLE001 - 网络异常只跳过这一轮
        if log:
            log('B 站分享：取件失败 %r' % (exc,))
        return 'error'
    if not data.get('ok'):
        return 'error'
    item = data.get('item')
    if not isinstance(item, dict) or not item.get('id'):
        return 'idle'
    job_id = str(item.get('id'))
    try:
        claimed = post_json('/api/bili/claim', {'id': job_id}) or {}
    except Exception as exc:  # noqa: BLE001
        if log:
            log('B 站分享：领取失败 %r' % (exc,))
        return 'claim_failed'
    if not claimed.get('ok'):
        return 'claim_failed'
    job = claimed.get('item') or item
    text = str(job.get('text') or '')
    chat_id = str(job.get('chatId') or '')
    name = str(job.get('name') or '')
    if not text or not chat_id:
        _ack(post_json, job_id, 'failed', 'bad_job', log)
        return 'failed'
    # 先发封面卡片（可选）：微信原生链接卡片是协议层的，UIA 做不到；
    # 用「封面 + 标题」合成图近似卡片效果，图片发完再补文字链接。
    if send_image and job.get('cover'):
        try:
            maker = make_card
            if maker is None:
                import share_card as share_card_module
                maker = share_card_module.make_card
            card_path = maker(job, log=log)
            if card_path:
                card_ok = bool(send_image(card_path, name, chat_id))
                if log:
                    log('B 站分享：封面卡片%s' % ('已发' if card_ok else '没发成，改发纯文字'))
        except Exception as exc:  # noqa: BLE001 - 卡片失败绝不影响文字
            if log:
                log('B 站分享：封面卡片失败（%s），改发纯文字' % type(exc).__name__)
    try:
        ok = bool(send_text(text, name, chat_id))
    except Exception as exc:  # noqa: BLE001
        _ack(post_json, job_id, 'failed', type(exc).__name__, log)
        if log:
            log('B 站分享：发送异常 %s' % type(exc).__name__)
        return 'failed'
    _ack(post_json, job_id, 'sent' if ok else 'failed', '' if ok else 'send_failed', log)
    if log:
        log('B 站分享：%s → %s' % ('已发' if ok else '未发出', '群' if str(job.get('chatType')) == 'group' else '私聊'))
    return 'sent' if ok else 'failed'


def _ack(post_json, job_id, status, error, log):
    try:
        post_json('/api/bili/ack', {'id': job_id, 'status': status, 'error': error})
    except Exception as exc:  # noqa: BLE001
        if log:
            log('B 站分享：回执失败 %r' % (exc,))

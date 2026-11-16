'use strict';

/**
 * 小红书技能（业务层）：把「搜攻略 / 读笔记 / 发笔记」三件事串起来。
 *
 * 触发方式（命令式为主，不依赖模型自觉）：
 *  - 搜：搜小红书 XX / 小红书搜一下 XX
 *  - 读：搜完之后说「看第 N 条」
 *  - 发：发小红书：标题…内容…#tag…（发布前回显草稿，等对方「发」确认）
 *
 * 状态按会话隔离（lastSearch / draft），纯内存：重启后上次搜索结果与未确认草稿会丢，
 * 这是刻意取舍——草稿本就不该长时间挂着，发布前总有确认环节兜底。
 */

const { XhsClient, XhsError, XhsVerificationError } = require('../adapters/xhs/client');
const features = require('../infra/features');

const MAX_TITLE = 20;

function parsePublish(text) {
  let body = String(text || '')
    .replace(/^(?:发|发布|上传|po|post)\s*(?:一下|个|到|上)?\s*(?:小红书|红书|xhs)[：:，,\s]*/i, '')
    .replace(/^(?:小红书|红书|xhs)\s*(?:发|发布|上传)[：:，,\s]*/i, '')
    .trim();
  const tags = [];
  const images = [];
  body = body
    .replace(/(?:图|图片|pic)[：:]\s*(\S{1,500})/gi, (_, p) => { images.push(p.replace(/[，,。！!？?~～]+$/, '')); return ' '; })
    .replace(/#([^\s#，,。！!？?]{1,20})/g, (_, tag) => { tags.push(tag); return ' '; });
  body = body.replace(/\s+/g, ' ').trim();

  // 抽「标题 / 内容」标签（可写可不写冒号）
  let title = '';
  let content = body;
  const tm = body.match(/^(?:标题|title)\s*[：:，,\s]*([^\n，,。！!？?]{1,40})/i);
  if (tm) { title = tm[1].trim(); content = body.slice(tm[0].length).replace(/^[，,。！!？?\s]+/, '').trim(); }
  const cm = content.match(/^(?:内容|正文|body)\s*[：:，,\s]*([\s\S]*)$/i);
  if (cm) content = cm[1].trim();
  if (!title) {
    const first = content.split(/[\n。！!？?]/)[0].trim();
    title = first ? first.slice(0, MAX_TITLE) : content.slice(0, MAX_TITLE);
  }
  return { title: title.slice(0, MAX_TITLE), content: content.replace(/\s+/g, ' ').trim(), tags: tags.slice(0, 10), images: images.slice(0, 9) };
}

function parseIntent(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 300) return null;
  if (/^(?:发|发吧|发出去|发布吧|发布|确认|确定|是|好|好的|ok|OK)[。.!！~～\s]*$/.test(t)) return { action: 'confirm' };
  if (/^(?:不发|不发了|算了|取消|先不|别发|取消发布)[。.!！~～\s]*$/.test(t)) return { action: 'cancel' };
  // 「看第 N 条」不要求带小红书关键词：搜完之后对方通常就只说序号。有没有上次结果由状态判断兜住。
  const read = t.match(/^(?:看|读|打开|看下|看看)\s*(?:一下|下)?\s*(?:第)?\s*(\d+)\s*条/);
  if (read) return { action: 'read', index: Number(read[1]) };
  if (!/小红书|红书|xhs/i.test(t)) return null;

  if (/(?:发|发布|上传|po|post)(?:布)?/.test(t)) return { action: 'publish', text: t };

  // 剥掉触发词（小红书 / 搜 / 查 / 找 / 一下 / 帮我…），剩下的就是关键词。「攻略」是内容不是触发词。
  const kw = t
    .replace(/小红书|红书|xhs/gi, ' ')
    .replace(/^(?:帮我|帮忙|请|给我)\s*/i, '')
    .replace(/(?:搜|查|找|看看|看下|搜下|查下)(?:一下|下|个|点)?/gi, ' ')
    .replace(/[，,。！!？?~～]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { action: 'search', keyword: kw };
}

class XhsService {
  constructor(config, { client = null, logger = null, now = () => Date.now() } = {}) {
    this.config = config || {};
    this.logger = logger;
    this.now = now;
    this.client = client || new XhsClient({
      baseUrl: this.config.xhs && this.config.xhs.url,
      token: this.config.xhs && this.config.xhs.token,
      timeoutMs: this.config.xhs && this.config.xhs.timeoutMs,
      logger,
    });
    this.chats = new Map();
    this.stats = { day: 0, publish: 0 };
  }

  enabled() {
    return features.isOn(this.config, 'xhs');
  }

  xhsConfig() { return this.config.xhs || {}; }

  state(chatId) {
    if (!this.chats.has(chatId)) this.chats.set(chatId, { lastSearch: [], draft: null });
    return this.chats.get(chatId);
  }

  dayKey() {
    const d = new Date(this.now());
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  publishQuotaLeft() {
    const max = Number(this.xhsConfig().maxPublishPerDay);
    if (!Number.isFinite(max) || max <= 0) return Infinity;
    const today = this.dayKey();
    if (this.stats.day !== today) { this.stats.day = today; this.stats.publish = 0; }
    return Math.max(0, max - this.stats.publish);
  }

  /**
   * 处理一条聊天消息，返回要给对方回的文案；不归本技能管就返回 null（交回正常聊天）。
   */
  async handle(text, { chatId = '' } = {}) {
    const id = String(chatId || '');
    if (!id) return null;
    const intent = parseIntent(text);
    if (!intent) return null;
    const st = this.state(id);
    switch (intent.action) {
      case 'confirm':
        if (!st.draft) return null; // 没有草稿，别抢「好/发」这种日常词
        return this.doPublish(id, st);
      case 'cancel':
        if (!st.draft) return null;
        st.draft = null;
        return '好，没发。';
      case 'search':
        return this.doSearch(id, st, intent.keyword);
      case 'read':
        if (!st.lastSearch.length) return null; // 没搜过，别抢「看第N条」
        return this.doRead(st, intent.index);
      case 'publish':
        return this.doDraft(id, st, intent.text);
      default:
        return null;
    }
  }

  async doSearch(id, st, keyword) {
    if (!this.enabled()) return '小红书功能还没开（去设置里打开「小红书」开关）。';
    const kw = String(keyword || '').trim();
    if (!kw) return '搜什么？跟我说「搜小红书 XX」这样。';
    try {
      const notes = await this.client.search(kw);
      st.lastSearch = notes.slice(0, 8);
      if (!notes.length) return `小红书没搜到「${kw}」相关的内容，换个词试试？`;
      const lines = notes.slice(0, 5).map((n, i) => `${i + 1}.《${n.title}》by ${n.author.name}（赞 ${n.likes}）`);
      return `小红书搜到 ${notes.length} 条，前几条：\n${lines.join('\n')}\n想看哪条就说「看第 N 条」。`;
    } catch (err) {
      return this.errText(err);
    }
  }

  async doRead(st, index) {
    if (!this.enabled()) return '小红书功能还没开。';
    const note = st.lastSearch[index - 1];
    if (!note) return `没这条，序号在 1~${st.lastSearch.length} 之间。`;
    try {
      const d = await this.client.detail(note);
      const body = (d.body || '').slice(0, 300);
      return `《${d.title}》\n${body || '（正文为空，可能只有图片）'}\n${d.url}\n评论 ${d.commentCount} 条。`;
    } catch (err) {
      return this.errText(err);
    }
  }

  async doDraft(id, st, text) {
    if (!this.enabled()) return '小红书功能还没开。';
    const draft = parsePublish(text);
    if (!draft.title || !draft.content) {
      return '发小红书要有个标题和正文，比如「发小红书：标题 今天吃啥，内容 随便聊聊 #美食」。';
    }
    st.draft = draft;
    if (this.xhsConfig().requireConfirm === false) return this.doPublish(id, st);
    const imgNote = draft.images.length ? `（配图 ${draft.images.length} 张）` : '（⚠️ 没配图：小红书图文笔记至少要一张图，先发张图/给个图片路径）';
    const body = draft.content.length > 100 ? draft.content.slice(0, 100) + '…' : draft.content;
    return `草稿好了，确认发吗？\n标题：${draft.title}\n正文：${body}\n标签：${draft.tags.length ? draft.tags.map((x) => '#' + x).join(' ') : '无'}${imgNote}\n回复「发」确认，回复「不发」取消。`;
  }

  async doPublish(id, st) {
    const draft = st.draft;
    st.draft = null;
    if (!draft.images || !draft.images.length) return '小红书图文笔记至少要一张图，先发一张图给我（或告诉我图片路径），再发。';
    if (this.publishQuotaLeft() <= 0) return '今天发布次数用完了，明天再来吧。';
    try {
      const r = await this.client.publish(draft);
      this.stats.publish += 1;
      return `发布好啦 🎉 小红书创作平台已接受（配图 ${r.images} 张）。`;
    } catch (err) {
      return this.errText(err);
    }
  }

  errText(err) {
    if (err instanceof XhsVerificationError) return '小红书遇到验证码 / 风控 / 登录问题，自动操作暂停，需要你在服务端人工处理。';
    if (err && err.code === 'need_image') return '小红书图文笔记至少要一张图，先发一张图给我（或告诉我图片路径），再发。';
    if (err && err.code === 'not_configured') return '小红书服务地址还没配置（xhs.url）。';
    if (err && err.code === 'service_unavailable') return '小红书服务连不上，检查服务是不是启动了（' + (this.xhsConfig().url || '') + '）。';
    if (err && err.code === 'auth_failed') return '小红书服务鉴权失败，检查服务令牌（xhs.token）。';
    if (err && err.code === 'uncertain') return '发布结果没拿到确认，需要你人工核对，我不会自动重发。';
    if (err && err.code === 'upstream_error') return `小红书操作失败（HTTP ${err.status || '?'}），稍后再试。`;
    if (err && err.code === 'bad_arg' && err.message) return err.message;
    return '小红书这次没弄成：' + ((err && err.message) || '未知错误');
  }
}

module.exports = { XhsService, parseIntent, parsePublish, MAX_TITLE };

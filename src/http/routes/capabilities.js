'use strict';

/**
 * 能力清单接口（给启动器「能力」页用）。
 *
 * 页面结构约定：一项能力 = 一个子菜单；新增能力不需要改启动器页面，
 * GET 返回的 items 会自动长出新的子菜单项。
 */

const { applyConfigPatch } = require('../../infra/configPatch');
const capabilities = require('../../services/capabilities');
const { json, readBody } = require('../util');

function payload(runtime) {
  const caps = capabilities.capsConfig(runtime.config);
  return {
    ok: true,
    enabled: caps.enabled !== false,
    maxPerDay: caps.maxPerDay === undefined ? 5 : Math.max(0, Number(caps.maxPerDay) || 0),
    items: capabilities.list(runtime.config, new Date()),
  };
}

module.exports = function register(router) {
  router.get('/api/capabilities', (runtime, req, res) => json(res, 200, payload(runtime)));

  router.post('/api/capabilities/set', async (runtime, req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: '请求内容必须是 JSON 对象' });
    const caps = capabilities.capsConfig(runtime.config);
    const items = { ...(caps.items && typeof caps.items === 'object' ? caps.items : {}) };
    const patch = { capabilities: {} };
    if (body.globalEnabled !== undefined) patch.capabilities.enabled = Boolean(body.globalEnabled);
    if (body.globalMaxPerDay !== undefined) {
      patch.capabilities.maxPerDay = Math.max(0, Math.min(100, Number(body.globalMaxPerDay) || 0));
    }
    const id = String(body.id || '').trim();
    if (id) {
      if (!capabilities.REGISTRY.some((entry) => entry.id === id)) {
        return json(res, 404, { ok: false, error: '没有这个能力：' + id });
      }
      const current = items[id] && typeof items[id] === 'object' ? items[id] : {};
      const next = { ...current };
      if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
      if (body.maxPerDay !== undefined) next.maxPerDay = Math.max(0, Math.min(100, Number(body.maxPerDay) || 0));
      items[id] = next;
    }
    if (id || body.globalEnabled !== undefined || body.globalMaxPerDay !== undefined) {
      patch.capabilities.items = items;
    }
    if (!Object.keys(patch.capabilities).length) return json(res, 400, { ok: false, error: '没有要改的字段' });
    try {
      applyConfigPatch(runtime, patch);
    } catch (err) {
      return json(res, 400, { ok: false, error: String((err && err.message) || err) });
    }
    runtime.logger.info('能力设置已保存：' + (id || '全局'));
    return json(res, 200, payload(runtime));
  });

  router.post('/api/capabilities/run', async (runtime, req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body && body.id ? body.id : '').trim();
    if (!id) return json(res, 400, { ok: false, error: '缺少能力 id' });
    const results = await capabilities.run(runtime, [id], { now: new Date() });
    const first = results[0] || { ok: false, summary: '没有执行' };
    return json(res, 200, { ok: Boolean(first.ok), result: first, results });
  });
};

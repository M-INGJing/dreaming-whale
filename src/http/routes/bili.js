'use strict';

/**
 * B 站（只读）的 HTTP 接口：登录状态、扫码登录、登出。
 *
 * 只回状态与二维码图片；cookie 本身永远不出内核。
 * 路由本身受全局安全闸保护（/api/* 默认只许本机，见 http/security.js）。
 */

const features = require('../../infra/features');
const { createBiliLogin } = require('../../services/biliLogin');
const { json } = require('../util');

const INSTANCES = new WeakMap();

function forRuntime(runtime) {
  let inst = INSTANCES.get(runtime);
  if (!inst) {
    inst = createBiliLogin({ logger: runtime.logger });
    INSTANCES.set(runtime, inst);
  }
  return inst;
}

module.exports = function register(router) {
  router.get('/api/bili/status', async (runtime, req, res) => {
    try {
      const out = await forRuntime(runtime).status(runtime.config);
      return json(res, 200, {
        ok: true,
        enabled: features.isOn(runtime.config, 'bili'),
        ...out,
      });
    } catch (err) {
      runtime.logger.warn('[bili] status 失败 code=' + (err && err.code ? err.code : 'unknown'));
      return json(res, 500, { ok: false, error: '读取 B 站状态失败' });
    }
  });

  router.post('/api/bili/login/qr', async (runtime, req, res) => {
    try {
      const out = await forRuntime(runtime).start(runtime.config);
      return json(res, 200, { ok: true, ...out });
    } catch (err) {
      runtime.logger.warn('[bili] 生成二维码失败 code=' + (err && err.code ? err.code : 'unknown'));
      return json(res, 502, { ok: false, error: '生成二维码失败（网络或 B 站接口异常）', code: (err && err.code) || '' });
    }
  });

  router.post('/api/bili/login/poll', async (runtime, req, res) => {
    try {
      const out = await forRuntime(runtime).pollOnce(runtime.config);
      if (out.state === 'idle') return json(res, 409, { ok: false, state: 'idle', error: '还没有二维码，请先点「扫码登录」' });
      return json(res, 200, { ok: true, ...out });
    } catch (err) {
      runtime.logger.warn('[bili] 轮询失败 code=' + (err && err.code ? err.code : 'unknown'));
      return json(res, 502, { ok: false, state: 'error', error: '轮询登录状态失败（网络异常）' });
    }
  });

  router.post('/api/bili/logout', (runtime, req, res) => {
    forRuntime(runtime).logout(runtime.config);
    return json(res, 200, { ok: true, removed: true });
  });
};

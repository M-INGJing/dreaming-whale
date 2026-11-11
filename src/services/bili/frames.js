'use strict';

/**
 * B 站视频「看画面」：取直链 → 下载 → ffmpeg 按画面变化抽帧 → 拼九宫格 → 视觉模型描述。
 *
 * 参考 dsh-bili-whale 的 watch-video：
 *   - 等间隔当骨架保证覆盖，再把每帧吸附到 ±半格内最近的变化点；
 *   - 变化点阈值 0.3 → 0.15 → 0.08 逐级放宽；
 *   - ffmpeg 不随仓库打包，只负责定位并调用。
 *
 * 失败全部降级为「没看到画面」，绝不影响文字资料/日记/分享。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SCENE_THRESHOLDS = [0.3, 0.15, 0.08];
let warnedNoFfmpeg = false;

function locateFfmpeg(env = process.env) {
  const tried = [];
  const candidates = [];
  if (env.FFMPEG) candidates.push(env.FFMPEG);
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'ffmpeg.exe'), path.join(dir, 'ffmpeg'));
  }
  candidates.push(
    'D:\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(os.homedir(), '.dsh', 'bili-whale', 'bin', 'ffmpeg.exe'),
    path.join(process.cwd(), 'bin', 'ffmpeg.exe'),
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  );
  for (const file of candidates) {
    tried.push(file);
    try {
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return { ok: true, file };
    } catch { /* 继续找 */ }
  }
  return { ok: false, file: '', tried };
}

function parseSceneTimes(stdout) {
  const out = [];
  for (const m of String(stdout || '').matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t > 0.2 && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 等间隔骨架 + 吸附最近变化点（变化点为空就纯等间隔）。 */
function pickTimes(durationSec, count, scenes = []) {
  const total = Math.max(0.1, Number(durationSec) || 0);
  const n = Math.max(1, Math.min(36, Number(count) || 9));
  const uniform = Array.from({ length: n }, (_, i) => ((i + 0.5) * total) / n);
  const list = (Array.isArray(scenes) ? scenes : []).filter((t) => Number.isFinite(t) && t > 0);
  if (!list.length) return uniform;
  const half = total / n / 2;
  return uniform.map((u) => {
    const near = list.filter((s) => Math.abs(s - u) <= half);
    if (!near.length) return u;
    return near.reduce((best, s) => (Math.abs(s - u) < Math.abs(best - u) ? s : best), near[0]);
  });
}

function parseGrid(grid) {
  const m = /^(\d+)x(\d+)$/i.exec(String(grid || '3x3'));
  if (!m) return { cols: 3, rows: 3 };
  return { cols: Math.max(1, Math.min(6, Number(m[1]))), rows: Math.max(1, Math.min(6, Number(m[2]))) };
}

function run(file, args, { exec = execFile, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    exec(file, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

function cookieHeader(config) {
  try {
    const { readCookieFor } = require('../../infra/biliCookie');
    return String(readCookieFor(config).cookie || '');
  } catch {
    return '';
  }
}

async function playurl(config, info, fetchImpl) {
  const bvid = String((info && info.bvid) || '');
  const cid = Number((info && info.cid) || 0);
  if (!bvid || !cid) throw new Error('no_cid');
  const url = 'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid)
    + '&cid=' + cid + '&qn=80&fnval=1&platform=pc&high_quality=1';
  const resp = await fetchImpl(url, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      ...(cookieHeader(config) ? { cookie: cookieHeader(config) } : {}),
    },
  });
  if (!resp.ok) throw new Error('playurl_http_' + resp.status);
  const body = await resp.json();
  const direct = body && body.data && body.data.durl && body.data.durl[0] && body.data.durl[0].url;
  if (!direct) throw new Error('no_durl');
  return String(direct);
}

function frameDir(config) {
  const dataDir = (config && config.paths && config.paths.dataDir) || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'bili', 'frames');
}

async function sceneTimes(ffmpeg, video, threshold) {
  const out = await run(ffmpeg, ['-hide_banner', '-i', video, '-vf',
    `select='gt(scene,${threshold})',metadata=print:file=-`, '-an', '-f', 'null', '-']);
  return parseSceneTimes(out);
}

async function download(url, file, fetchImpl) {
  const resp = await fetchImpl(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', range: 'bytes=0-' },
  });
  if (!resp.ok || !resp.body) throw new Error('download_http_' + (resp.status || 0));
  await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(file));
  return fs.statSync(file).size;
}

/**
 * 抽帧并拼图。返回 {ok, path, times, how, grid} 或 {ok:false, reason}。
 * opts 只给测试注入用：ffmpeg / fetchImpl / exec / force / outDir。
 */
async function capture(config, info, opts = {}) {
  const cfg = (config && config.bili && config.bili.frames) || {};
  if (cfg.enabled === false) return { ok: false, reason: 'disabled' };
  const ff = opts.ffmpeg || locateFfmpeg();
  if (!ff || !ff.file) return { ok: false, reason: 'no_ffmpeg' };
  const fetchImpl = opts.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no_fetch' };
  const bvid = String((info && info.bvid) || '');
  if (!bvid) return { ok: false, reason: 'no_bvid' };
  const duration = Number((info && info.durationSec) || 0);
  if (!duration) return { ok: false, reason: 'no_duration' };
  const maxMinutes = Math.max(1, Number(cfg.maxMinutes) || 20);
  if (duration > maxMinutes * 60) return { ok: false, reason: 'too_long' };
  const grid = String(opts.grid || cfg.grid || '3x3');
  const { cols, rows } = parseGrid(grid);
  const count = cols * rows;
  const dir = opts.outDir || frameDir(config);
  await fsp.mkdir(dir, { recursive: true });
  const sheet = path.join(dir, bvid + '-' + grid + '.jpg');
  if (!opts.force && fs.existsSync(sheet)) return { ok: true, path: sheet, cached: true, times: [], grid, how: '复用已有截帧' };

  const stamp = Date.now();
  const video = path.join(dir, '.' + bvid + '-' + stamp + '.mp4');
  const tmp = path.join(dir, '.frames-' + bvid + '-' + stamp);
  try {
    const direct = await playurl(config, info, fetchImpl);
    await download(direct, video, fetchImpl);
    let scenes = [];
    let used = SCENE_THRESHOLDS[0];
    for (const th of SCENE_THRESHOLDS) {
      used = th;
      scenes = await sceneTimes(ff.file, video, th).catch(() => []);
      if (scenes.length >= count) break;
    }
    const times = pickTimes(duration, count, scenes);
    const how = scenes.length
      ? `等间隔骨架 + 吸附画面变化点（阈值 ${used}，检出 ${scenes.length} 处）`
      : '纯等间隔（未检出画面变化）';
    await fsp.mkdir(tmp, { recursive: true });
    let i = 0;
    for (const t of times) {
      const out = path.join(tmp, 'f' + String(i).padStart(2, '0') + '.jpg');
      await run(ff.file, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', video, '-frames:v', '1', '-q:v', '3', out], { exec: opts.exec });
      i += 1;
    }
    const tile = Math.max(240, Math.min(1280, Number(cfg.tile) || 720));
    await run(ff.file, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
      `scale=${tile}:-1,tile=${cols}x${rows}`, '-frames:v', '1', sheet], { exec: opts.exec });
    if (!fs.existsSync(sheet)) throw new Error('no_sheet');
    return { ok: true, path: sheet, times, how, grid, cached: false };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err || 'error') };
  } finally {
    await fsp.rm(video, { force: true }).catch(() => {});
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const DEFAULT_PROMPT = [
  '这是一张 B 站视频的九宫格截帧（按时间顺序从左到右、从上到下）。',
  '只描述你能确定的画面：人物/场景/动作/画面上的文字，不要猜剧情，不要编字幕里没有的内容。',
  '用 2~4 句中文概括；如果没有明显画面或全黑，就说「画面看不清」。',
].join('\n');

/** 抽帧 + 视觉描述；任何一步失败返回 ''（调用方保持纯文字）。 */
async function describe(config, info, opts = {}) {
  const cfg = (config && config.bili && config.bili.frames) || {};
  if (cfg.enabled === false) return '';
  const logger = opts.logger || null;
  let shot;
  try {
    shot = await capture(config, info, opts);
  } catch (err) {
    shot = { ok: false, reason: String((err && err.code) || err) };
  }
  if (!shot.ok) {
    if (shot.reason === 'no_ffmpeg') {
      if (!warnedNoFfmpeg) {
        warnedNoFfmpeg = true;
        logger?.warn?.('[bili] 没找到 ffmpeg，暂时只能读文字资料（装好 ffmpeg 后重启桥接/内核即可抽帧）');
      }
    } else {
      logger?.warn?.('[bili] 截帧跳过：' + shot.reason);
    }
    return '';
  }
  try {
    const vision = require('../../adapters/vision');
    const bytes = await fsp.readFile(shot.path);
    const text = await vision.describe(config, {
      imageBase64: bytes.toString('base64'),
      mime: 'image/jpeg',
      prompt: DEFAULT_PROMPT,
    });
    return String(text || '').slice(0, Math.max(80, Number(cfg.descriptionChars) || 400));
  } catch (err) {
    logger?.warn?.('[bili] 画面描述失败：' + ((err && err.message) || 'vision'));
    return '';
  }
}

module.exports = {
  locateFfmpeg, parseSceneTimes, pickTimes, parseGrid, capture, describe,
  frameDir, UA,
};

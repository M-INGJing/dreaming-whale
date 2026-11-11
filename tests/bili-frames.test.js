'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const frames = require('../src/services/bili/frames');
const { createBiliScheduler } = require('../src/services/bili/scheduler');

test('locateFfmpeg：优先环境变量 FFMPEG，文件不存在时继续找', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-ff-'));
  const exe = path.join(root, 'ffmpeg.exe');
  fs.writeFileSync(exe, '');
  const found = frames.locateFfmpeg({ FFMPEG: exe, PATH: '' });
  assert.equal(found.ok, true);
  assert.equal(found.file, exe);
  const missing = frames.locateFfmpeg({ FFMPEG: path.join(root, 'nope.exe'), PATH: '' });
  assert.equal(typeof missing.ok, 'boolean');
  fs.rmSync(root, { recursive: true, force: true });
});

test('parseSceneTimes：解析 pts_time 并去重、过滤开头', () => {
  const out = 'pts_time:0.100\npts_time:12.5\npts_time:12.5\npts_time:99.25\n';
  assert.deepEqual(frames.parseSceneTimes(out), [12.5, 99.25]);
  assert.deepEqual(frames.parseSceneTimes(''), []);
});

test('pickTimes：等间隔骨架 + 吸附最近画面变化点', () => {
  const uniform = frames.pickTimes(100, 9, []);
  assert.equal(uniform.length, 9);
  assert.ok(uniform[0] > 0 && uniform[8] < 100);
  const snapped = frames.pickTimes(100, 9, [10, 50, 90]);
  assert.ok(snapped.includes(10), '10s 的变化点应吸附到最近的等间隔帧');
  assert.ok(snapped.includes(50));
  assert.ok(snapped.includes(90));
});

test('parseGrid：格式不对回退 3x3，并限制范围', () => {
  assert.deepEqual(frames.parseGrid('4x4'), { cols: 4, rows: 4 });
  assert.deepEqual(frames.parseGrid('bad'), { cols: 3, rows: 3 });
  assert.deepEqual(frames.parseGrid('9x9'), { cols: 6, rows: 6 });
});

function schedRuntime(framesCfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-sched-'));
  const now = new Date(2026, 10, 11, 22, 0);
  const config = {
    paths: { dataDir: path.join(root, 'data') },
    persona: { master: { wxids: ['wxid_owner'], names: ['主人'] } },
    features: { bili: true },
    bili: {
      preferences: { like: ['猫'], dislike: [] },
      night: { windows: [{ start: '00:00', end: '23:59', wakes: 1 }], skipChance: 0, maxVideos: 5, maxWakesPerDay: 1, maxMinutes: 45 },
      risk: { readHourly: 120, readDaily: 400 },
      share: { enabled: false },
      diary: { enabled: true },
      frames: { enabled: true, minScore: 1, maxPerRun: 1, ...framesCfg },
    },
  };
  return { root, now, config };
}

test('调度器：高分视频抽帧描述会拼进 digest，超过 maxPerRun 不再抽', async () => {
  const { root, now, config } = schedRuntime();
  const calls = [];
  const watched = [];
  const sched = createBiliScheduler({
    config,
    now: () => now,
    fetchFeed: async () => ({
      source: 'rcmd',
      items: [
        { bvid: 'BV1xx411c7mD', title: '猫猫日常', durationSec: 60, pubdate: Math.floor(now.getTime() / 1000), stat: { view: 1000000, like: 5000 } },
        { bvid: 'BV2xx411c7mD', title: '猫猫第二集', durationSec: 60, pubdate: Math.floor(now.getTime() / 1000), stat: { view: 900000, like: 4000 } },
      ],
    }),
    readMaterials: async (cfg, bvid) => ({
      digest: '【B站视频】' + bvid,
      info: { bvid, cid: 123, durationSec: 60, title: '猫猫' },
      replies: [],
    }),
    captureFrames: async (cfg, info) => { calls.push(info.bvid); return '画面里有一只橘猫在窗台上打滚。'; },
    writeDiary: async (opts) => { watched.push(...opts.watched); return { ownerChars: 1, selfChars: 1, rewritten: true }; },
  });
  const out = await sched.runRound({ dry: false, now });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1, 'maxPerRun=1 只抽一次');
  const withFrames = watched.find((w) => w.digest.includes('画面观察'));
  assert.ok(withFrames, '抽帧描述要拼进 digest');
  assert.match(withFrames.digest, /橘猫在窗台上打滚/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('调度器：frames.enabled=false 时不抽帧', async () => {
  const { root, now, config } = schedRuntime({ enabled: false });
  let called = 0;
  const sched = createBiliScheduler({
    config,
    now: () => now,
    fetchFeed: async () => ({ source: 'rcmd', items: [{ bvid: 'BV1xx411c7mD', title: '猫猫', durationSec: 60, pubdate: Math.floor(now.getTime() / 1000), stat: { view: 1000000 } }] }),
    readMaterials: async (cfg, bvid) => ({ digest: '【B站视频】' + bvid, info: { bvid, cid: 1, durationSec: 60 }, replies: [] }),
    captureFrames: async () => { called += 1; return '画面'; },
    writeDiary: async () => ({ ownerChars: 1, selfChars: 1, rewritten: true }),
  });
  await sched.runRound({ dry: false, now });
  assert.equal(called, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('capture：超长视频直接跳过，不下载', async () => {
  let fetched = 0;
  const out = await frames.capture(
    { paths: { dataDir: path.join(os.tmpdir(), 'frames-long') }, bili: { frames: { enabled: true, maxMinutes: 20 } } },
    { bvid: 'BV1xx411c7mD', cid: 1, durationSec: 3600 },
    { ffmpeg: { ok: true, file: 'ffmpeg' }, fetchImpl: async () => { fetched += 1; return {}; } },
  );
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'too_long');
  assert.equal(fetched, 0);
});

test('capture：真实 ffmpeg 抽帧并拼九宫格（本机没有 ffmpeg 时跳过）', async (t) => {
  const ff = frames.locateFfmpeg();
  if (!ff.ok) return t.skip('本机没有 ffmpeg');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-capture-'));
  const video = path.join(root, 'src.mp4');
  const { execFileSync } = require('node:child_process');
  execFileSync(ff.file, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=6', '-pix_fmt', 'yuv420p', video]);
  const bytes = fs.readFileSync(video);
  const fakeFetch = async (url) => {
    if (String(url).includes('playurl')) {
      return { ok: true, json: async () => ({ data: { durl: [{ url: 'https://example.test/v.mp4' }] } }) };
    }
    return { ok: true, status: 200, body: new Response(bytes).body };
  };
  const config = { paths: { dataDir: path.join(root, 'data') }, bili: { frames: { enabled: true, grid: '3x3', tile: 240 } } };
  const out = await frames.capture(config, { bvid: 'BV1xx411c7mD', cid: 1, durationSec: 6 }, {
    ffmpeg: ff, fetchImpl: fakeFetch, outDir: path.join(root, 'shots'),
  });
  assert.equal(out.ok, true, out.reason || '');
  assert.equal(out.times.length, 9);
  assert.ok(fs.existsSync(out.path));
  const { spawnSync } = require('node:child_process');
  const probe = spawnSync(ff.file, ['-hide_banner', '-i', out.path], { encoding: 'utf8' });
  const dim = /(\d{2,5})x(\d{2,5})/.exec(String(probe.stderr || ''));
  assert.ok(dim, 'ffmpeg 应能读出拼图尺寸');
  assert.equal(dim[1] + 'x' + dim[2], '720x405', '3x3、每格 240px 宽（16:9）应得 720x405');
  fs.rmSync(root, { recursive: true, force: true });
});

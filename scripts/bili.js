#!/usr/bin/env node
'use strict';

/**
 * B 站只读工具（P0）：先让「看看这个视频」在命令行跑通，再接进聊天。
 *
 *   node scripts/bili.js view <BV|链接>     看一个视频：元信息 + 是否有字幕 + 热评条数
 *   node scripts/bili.js view <BV> --json   同一份数据，给脚本用
 *   node scripts/bili.js whoami             看 cookie 是否有效（只回布尔，不回 cookie）
 *
 * 不联网的部分全部在 adapters 层；这里只做参数解析和打印，方便测试/排障。
 */

const path = require('node:path');
const { createClient } = require('../src/adapters/bili/api');
const endpoints = require('../src/adapters/bili/endpoints');
const { readCookie } = require('../src/infra/biliCookie');

const ROOT = path.resolve(__dirname, '..');

function usage() {
  console.log('用法：');
  console.log('  node scripts/bili.js view <BV|链接> [--json]');
  console.log('  node scripts/bili.js whoami');
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const json = rest.includes('--json');
  const target = rest.find((x) => !x.startsWith('--')) || '';
  const { cookie } = readCookie(ROOT);
  const client = createClient({ cookie });

  if (cmd === 'whoami') {
    const out = await client.status();
    console.log(JSON.stringify({
      loggedIn: out.loggedIn,
      nameLength: out.nameLength,
      wbiReady: out.wbiReady,
      hasCookie: Boolean(cookie),
    }, null, 2));
    return 0;
  }

  if (cmd === 'view') {
    if (!target) { usage(); return 2; }
    const bvid = endpoints.parseBvid(target);
    if (!bvid) {
      console.error('没有从参数里识别到 BV 号（b23.tv 短链暂不支持，请用 bilibili.com/video/BV… 或直接给 BV）');
      return 2;
    }
    const materials = await endpoints.watchMaterials(client, bvid);
    const { info, subtitle: subs, replies } = materials;
    if (json) {
      console.log(JSON.stringify({
        ...info,
        subtitle: { lang: subs.lang, chars: subs.text.length, reason: subs.reason || '' },
        replies,
      }, null, 2));
      return 0;
    }
    const mm = Math.floor(info.durationSec / 60);
    const ss = String(info.durationSec % 60).padStart(2, '0');
    console.log(info.title);
    console.log(`UP：${info.owner.name}　时长：${mm}:${ss}　播放：${info.stat.view}　点赞：${info.stat.like}`);
    console.log(`链接：https://www.bilibili.com/video/${info.bvid}/`);
    if (info.desc) console.log(`简介：${info.desc.slice(0, 120)}`);
    console.log(subs.text
      ? `字幕：${subs.lang}，${subs.text.length} 字（前 60 字）${subs.text.slice(0, 60).replace(/\n/g, ' ')}`
      : `字幕：无（${subs.reason || 'unknown'}）`);
    console.log(`热评：${replies.length} 条`);
    for (const r of replies.slice(0, 3)) console.log(`  · ${r.author}：${r.text}`);
    return 0;
  }

  usage();
  return 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  // 只打结构信息：code/status，不打 URL 与 cookie
  console.error('失败：' + (err && err.code ? err.code : 'error') + '（' + (err && err.message ? err.message : '未知错误') + '）');
  process.exit(1);
});

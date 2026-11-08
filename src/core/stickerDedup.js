'use strict';

/**
 * 表情包查重：64 位 dHash 的汉明距离（纯函数，不碰 IO）。
 *
 * dHash 由桥接算好（Python + PIL），内核只负责比较：
 *  - 完全相同的内容走 sha256，不用算距离；
 *  - dHash 用来抓「同一张图被转发/压缩/改尺寸」的近似重复；
 *  - 格式（gif/png）参与判重：动画和静态各留一张。
 */

const HEX64 = /^[0-9a-f]{16}$/i;

function validHash(value) {
  return HEX64.test(String(value || ''));
}

function popcount32(n) {
  let v = n >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/** 两个 64 位十六进制哈希的汉明距离；任一非法返回 64（视为最远）。 */
function hamming(a, b) {
  if (!validHash(a) || !validHash(b)) return 64;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  let distance = 0;
  for (let i = 0; i < 16; i += 2) {
    distance += popcount32(parseInt(x.slice(i, i + 2), 16) ^ parseInt(y.slice(i, i + 2), 16));
  }
  return distance;
}

/** 是否近似重复。distance 默认 6（同一张图转到发白/压缩通常 ≤4）。 */
function isNear(a, b, distance = 6) {
  const limit = Math.max(0, Math.min(64, Number(distance) || 0));
  return hamming(a, b) <= limit;
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? '.' + m[1].toLowerCase() : '';
}

function sameFormat(a, b) {
  return extOf(a) === extOf(b);
}

/**
 * 在一组候选中找近似重复。
 * @param {Array<{sha256:string,dhash:string,file:string}>} items
 * @param {{dhash:string, ext:string}} target
 * @param {{distance?:number, sameFormatOnly?:boolean}} opts
 */
function findNear(items, target, opts = {}) {
  const distance = Number.isFinite(opts.distance) ? opts.distance : 6;
  const sameOnly = opts.sameFormatOnly !== false;
  let best = null;
  let bestDistance = 65;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.dhash) continue;
    if (sameOnly && !sameFormat(item.file, target.ext || '')) continue;
    const d = hamming(item.dhash, target.dhash);
    if (d <= distance && d < bestDistance) {
      best = item;
      bestDistance = d;
    }
  }
  return best ? { item: best, distance: bestDistance } : null;
}

/** 内容更清晰/更大 → 用新图替换旧图（只改索引，文件替换由调用方做）。 */
function isClearer(newSize, oldSize) {
  return Number(newSize) > Number(oldSize) * 1.2;
}

module.exports = { validHash, hamming, isNear, extOf, sameFormat, findNear, isClearer, popcount32 };

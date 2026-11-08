'use strict';

/**
 * 视频打分：只做「值不值得看」的纯计算，不联网。
 *
 * 权重写在代码里（第一版不开放调参），偏好来自 config.bili.preferences：
 * 喜欢命中权重最高（VISION 里那句「你看什么，由她决定」），不喜欢一票否决式降权。
 */

const W = { like: 3, dislike: -5, hot: 3, fresh: 2, seen: -999, long: -2, durationMissing: 0 };

function textOf(candidate) {
  return [candidate && candidate.title, candidate && candidate.desc].filter(Boolean).join(' ').toLowerCase();
}

function hits(text, words) {
  if (!text || !Array.isArray(words)) return [];
  return words.map((w) => String(w || '').trim()).filter((w) => w && text.includes(w.toLowerCase()));
}

function hotScore(stat) {
  const view = Number(stat && stat.view) || 0;
  if (view <= 0) return 0;
  // 对数分桶：1 万 → 1，10 万 → 2，100 万+ → 3，避免大 UP 通吃
  const bucket = Math.floor(Math.log10(Math.max(1, view)) - 3);
  return Math.max(0, Math.min(W.hot, bucket));
}

function freshScore(pubdate, now) {
  const seconds = Number(pubdate) || 0;
  if (!seconds) return 0;
  const ageHours = Math.max(0, (now - seconds * 1000) / 3600000);
  if (ageHours <= 24) return W.fresh;
  if (ageHours <= 72) return W.fresh / 2;
  return 0;
}

/**
 * @param {object} candidate { bvid, title, desc, durationSec, pubdate, stat }
 * @param {object} prefs { like: string[], dislike: string[] }
 * @param {object} opts { now, seen:Set<string>, maxMinutes }
 */
function scoreCandidate(candidate, prefs = {}, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const seen = opts.seen instanceof Set ? opts.seen : new Set(opts.seen || []);
  if (!candidate || !candidate.bvid) return { score: -Infinity, reasons: ['no_bvid'] };
  if (seen.has(candidate.bvid)) return { score: W.seen, reasons: ['seen'] };
  const text = textOf(candidate);
  const like = hits(text, prefs.like);
  const dislike = hits(text, prefs.dislike);
  const reasons = [];
  let score = 0;
  if (like.length) { score += W.like * like.length; reasons.push('like:' + like.join('/')); }
  if (dislike.length) { score += W.dislike * dislike.length; reasons.push('dislike:' + dislike.join('/')); }
  const hot = hotScore(candidate.stat);
  if (hot) { score += hot; reasons.push('hot:' + hot); }
  const fresh = freshScore(candidate.pubdate, now);
  if (fresh) { score += fresh; reasons.push('fresh:' + fresh); }
  const maxMinutes = Number(opts.maxMinutes) || 0;
  const minutes = (Number(candidate.durationSec) || 0) / 60;
  if (maxMinutes > 0 && minutes > maxMinutes) { score += W.long; reasons.push('too_long'); }
  return { score, reasons };
}

/** 排序 + 取前 n；分数相同按发布时间新的优先。 */
function rankCandidates(candidates, prefs, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const scored = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && c.bvid)
    .map((c) => ({ candidate: c, ...scoreCandidate(c, prefs, { ...opts, now }) }))
    .filter((row) => Number.isFinite(row.score));
  scored.sort((a, b) => (b.score - a.score) || ((Number(b.candidate.pubdate) || 0) - (Number(a.candidate.pubdate) || 0)));
  const limit = Math.max(1, Number(opts.limit) || 5);
  return scored.slice(0, limit);
}

module.exports = { W, scoreCandidate, rankCandidates, hotScore, freshScore, hits };

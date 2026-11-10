'use strict';

/**
 * 跑一次人格漂移分析：node scripts/drift.js [days]
 * 读 data/memory/chats 下各会话的 messages.jsonl 里的 assistant 回复，按天统计指标，
 * 超健康区间打一句提示。可挂 cron / 手动跑，结果写 data/drift.json。
 */

const path = require('node:path');
const { loadConfig } = require('../src/infra/config');
const drift = require('../src/services/drift');

const root = path.resolve(__dirname, '..');
const config = loadConfig({ root });
const days = Math.max(1, Math.min(30, Number(process.argv[2]) || 7));

const report = drift.analyze(config, { days });

console.log('最近 ' + report.days.length + ' 天有数据：');
for (const d of report.days) {
  const pct = (n) => (n * 100).toFixed(0) + '%';
  console.log(`  ${d.date}  回复 ${String(d.count).padStart(3)} 条  中位 ${String(d.p50).padStart(3)} 字  emoji ${pct(d.emojiRate)}  问句 ${pct(d.questionRate)}  AI味 ${(d.aiRate * 100).toFixed(1)}%  复读 ${d.maxSim.toFixed(2)}`);
}
console.log(report.hint ? '提示：' + report.hint : '健康，无需提示。');

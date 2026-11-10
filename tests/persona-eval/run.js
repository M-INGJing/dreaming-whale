'use strict';

/**
 * 金标评测集：对一个人设预设，跑一批场景，用「可编程规则」判分。
 *
 * 用法：
 *   node tests/persona-eval/run.js [presetId] [--dry-run] [--limit N] [--json]
 *
 *   presetId      要测的预设 id（默认 persona-standard；default = 仓库默认人设）
 *   --dry-run     只拼提示词、不调模型（无 API key 时用它验证 harness 与场景可解析）
 *   --limit N     只跑前 N 条
 *   --json        输出 JSON（机器可读）
 *
 * 依赖真实模型调用（需要 config.json / settings.json 里有可用的 API key）。
 * 判分规则是可编程的，不依赖人评：
 *   长度 ≤ maxChars；不出现 AI 味词；不出现 Markdown；不复读；缺要求语气则失败。
 */
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../../src/infra/config');
const { DeepSeekClient } = require('../../src/llm/client');
const persona = require('../../src/persona');
const presets = require('../../src/persona/presets');
const store = require('../../src/persona/store');

const ROOT = path.resolve(__dirname, '..', '..');
const CASES_FILE = path.join(__dirname, 'cases.jsonl');

/** 全局 AI 味词：任何回复命中即判失败 */
const AI_WORDS = ['首先', '其次', '总的来说', '希望这能帮到你', '作为一个 AI', '语言模型', '还有什么可以帮', '随时告诉我'];

/** 全局 Markdown / 列表 / 引用标记 */
const MD_RE = /(\*\*|`|^#{1,6}\s|^\s*[-*]\s|^\s*>\s|^\s*\d+[\.、]\s)/m;

function parseArgs(argv) {
  const args = { presetId: 'persona-standard', dryRun: false, limit: 0, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--limit' && argv[i + 1]) args.limit = Number(argv[++i]) || 0;
    else if (!a.startsWith('--')) args.presetId = a;
  }
  return args;
}

function readCases() {
  const lines = fs.readFileSync(CASES_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (err) {
      throw new Error(`cases.jsonl 第 ${i + 1} 行不是合法 JSON：${err.message}\n${l.slice(0, 120)}`);
    }
  });
}

/** 无依赖的日志桩：DeepSeekClient 只用到 warn/debug/info */
const silentLogger = { warn() {}, debug() {}, info() {}, error() {}, child() { return silentLogger; } };

/** 把预设写进 config.persona（走真实 toPatch + apply，避免各写各的） */
function applyPreset(config, presetId) {
  if (presetId === 'default') return config;
  const preset = presets.load(config, presetId);
  if (!preset) throw new Error(`找不到预设 ${presetId}（可用：${presets.list(config).map((p) => p.id).join(', ')}）`);
  const patch = presets.toPatch(preset);
  patch.sourcePreset = preset.id;
  store.apply(config, patch);
  return config;
}

function score(reply, c) {
  const fails = [];
  const expect = c.expect || {};
  if (expect.maxChars && reply.length > expect.maxChars) fails.push(`超长 ${reply.length}>${expect.maxChars}`);
  for (const w of expect.forbid || []) if (reply.includes(w)) fails.push(`命中禁用词「${w}」`);
  for (const w of AI_WORDS) if (reply.includes(w)) fails.push(`AI 味「${w}」`);
  if (MD_RE.test(reply)) fails.push('出现 Markdown/列表标记');
  if (expect.requireOneOf && expect.requireOneOf.length
    && !expect.requireOneOf.some((w) => reply.includes(w))) {
    fails.push(`缺少要求语气（${expect.requireOneOf.join(' / ')}）`);
  }
  // 复读：与上一条原话重合度过高
  const hist = c.history || [];
  if (hist.length) {
    const last = hist[hist.length - 1] || '';
    const overlap = overlapRatio(reply, last);
    if (overlap > 0.7 && last.length >= 4) fails.push(`复读上一条（重合 ${Math.round(overlap * 100)}%）`);
  }
  return fails;
}

/** 粗略的重合度：按 2 字 shingle 算，够用即可 */
function overlapRatio(a, b) {
  const sh = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const sa = sh(a);
  const sb = sh(b);
  if (!sb.size) return 0;
  let hit = 0;
  for (const x of sa) if (sb.has(x)) hit += 1;
  return hit / sb.size;
}

function buildMsg(c) {
  const isGroup = c.chatType === 'group';
  return {
    chatType: c.chatType || 'group',
    text: c.input,
    senderName: c.senderName || (isGroup ? '群友' : '对方'),
    chatTitle: c.chatTitle || (isGroup ? '评测群' : ''),
    ts: Date.now(),
    ...(c.flags || {}),
  };
}

function buildTurns(input, tail) {
  const content = [input, tail].filter(Boolean).join('\n\n');
  return [{ role: 'user', content }];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ root: ROOT });
  applyPreset(config, args.presetId);
  const client = new DeepSeekClient({ config, logger: silentLogger });
  const cases = readCases();
  const list = args.limit > 0 ? cases.slice(0, args.limit) : cases;

  const usingMock = client.mock === true;
  if (!args.dryRun && usingMock) {
    console.error(`没有可用的 API key（当前会走演示模式）。要真实评测请先配好 config.json 的 apiKey，或用 --dry-run 只验证提示词拼装。`);
    process.exit(2);
  }

  const rows = [];
  for (const c of list) {
    const msg = buildMsg(c);
    const parts = persona.buildPromptParts({ config, msg, now: new Date() });
    let reply = '';
    let fails = [];
    if (args.dryRun) {
      fails = parts.system ? [] : ['提示词为空'];
    } else {
      try {
        const res = await client.complete({ system: parts.system, turns: buildTurns(c.input, parts.tail), maxTokens: 300 });
        reply = typeof res === 'string' ? res : (res && res.text) || '';
        fails = score(reply, c);
      } catch (err) {
        fails = [`调用失败：${err.message}`];
      }
    }
    rows.push({ id: c.id, scene: c.scene, pass: fails.length === 0, fails, replyLen: reply.length, reply });
  }

  const pass = rows.filter((r) => r.pass).length;
  if (args.json) {
    console.log(JSON.stringify({ preset: args.presetId, dryRun: args.dryRun, total: rows.length, pass, rate: rows.length ? pass / rows.length : 0, rows }, null, 2));
  } else {
    for (const r of rows) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(12)} ${r.scene.padEnd(6)}${r.fails.length ? '  ' + r.fails.join('；') : ''}${r.pass ? '' : '  → ' + r.reply.slice(0, 60)}`);
    }
    console.log(`\n${args.presetId}：${pass}/${rows.length} 通过（${rows.length ? Math.round((pass / rows.length) * 100) : 0}%）${args.dryRun ? ' [dry-run，只验证提示词拼装]' : ''}`);
  }
  process.exitCode = pass === rows.length ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { score, readCases };

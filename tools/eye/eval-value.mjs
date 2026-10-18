#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tools/eye/eval-value.mjs
// Run a local model through aim4 eye's value tools on the held-out rounds and
// score what it does. No site, no browser: the tools are the same code the app
// runs (roundValue.js), fed from the .aim4replay packages the eval set came from.
//
//   llama-server -m model.gguf --jinja -c 16384 --port 8899
//   node --max-old-space-size=4096 tools/eye/eval-value.mjs --llama http://127.0.0.1:8899
//
//   --eval FILE      value-eval.jsonl from build-value-sft.mjs (default tools/eye/value-out/)
//   --dir DIR        the packages the eval set was built from (default sampledemos/)
//   --llama URL      an OpenAI-compatible server with tool calling (llama-server --jinja, Ollama /v1)
//   --model NAME     sent as "model" (servers that host several need it)
//   --kinds a,b      only these question kinds (decided, players, take, wrong)
//   --limit N        at most N cases
//   --thinking       let the model think (the app's default is off)
//   --only-value     offer only round_value and moment_value (default: every eye tool,
//                    so a call to anything else is counted as a wrong tool)
//   --out DIR        where results.jsonl and summary.json go (default tools/eye/value-out/run-<time>)
//   --oracle         no model: replay the reference answers through the real tools.
//                    Everything should pass; if not, the harness or the eval set is wrong.
//
// Scores (valueScore.mjs): tool choice, grounding (every number and clock in an
// answer is in a tool result), recall of the biggest swings, and the verdict.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYSTEM_PROMPT } from '../../src/replays/eye/eyeAgent.js';
import { clockLabel, parseClock } from '../../src/replays/eye/eyeImages.js';
import { MAX_RESULT_CHARS, TOOLS } from '../../src/replays/eye/eyeTools.js';
import { repairedNote, resolveRound } from '../../src/replays/eye/roundRefs.js';
import { momentReport, roundValueReport, valueRound } from '../../src/replays/eye/roundValue.js';
import { prepareMap } from '../../scripts/lib/duelCorpus.mjs';
import { SAMPLE_DIR, listSamplePackages, loadPackage } from '../../scripts/lib/sampledemoPackages.mjs';
import { runCase } from './evalLoop.mjs';
import { VALUE_TOOLS, scoreCase, summarise } from './valueScore.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const flag = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);

const evalFile = flag('--eval', path.join(here, 'value-out', 'value-eval.jsonl'));
const dir = flag('--dir', SAMPLE_DIR);
const llama = flag('--llama', 'http://127.0.0.1:8899').replace(/\/$/, '');
const modelName = flag('--model');
const kinds = flag('--kinds') ? flag('--kinds').split(',') : null;
const limit = Number(flag('--limit', 0)) || 0;
const oracle = has('--oracle');
const outDir = flag('--out', path.join(here, 'value-out', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`));

let cases = fs.readFileSync(evalFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (kinds) cases = cases.filter((c) => kinds.includes(c.kind));
if (limit) cases = cases.slice(0, limit);
if (!cases.length) {
  console.error(`No eval cases in ${evalFile}${kinds ? ` for ${kinds.join(',')}` : ''}.`);
  process.exit(1);
}

// ---- the rounds the cases ask about, priced once --------------------------

const wanted = new Map(); // demo -> Set(round file)
for (const c of cases) {
  if (!wanted.has(c.demo)) wanted.set(c.demo, new Set());
  wanted.get(c.demo).add(c.round);
}
const maps = new Map();
const priced = new Map(); // round file -> valueRound result
for (const file of await listSamplePackages(dir)) {
  const pkg = await loadPackage(file);
  const want = wanted.get(pkg.name);
  if (!want) continue;
  for (const entry of pkg.rounds) {
    if (!want.has(entry.file)) continue;
    const { meta, track } = pkg.readRound(entry);
    const network = await prepareMap(meta.map, maps).catch(() => null);
    const value = valueRound({ meta, track, network });
    if (value) priced.set(entry.file, value);
  }
}
const missing = cases.filter((c) => !priced.has(c.round));
if (missing.length) console.warn(`${missing.length} of ${cases.length} cases name a round not found in ${dir}; they are skipped.`);
cases = cases.filter((c) => priced.has(c.round));

/** The text the model reads, cut as the app cuts it. */
const fit = (value) => {
  const text = JSON.stringify(value);
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}… [cut: the rest did not fit]`;
};

/**
 * The value tools, as the app runs them: a slightly mangled round id is read
 * back against the rounds this eval knows (roundRefs.js), and the result says so.
 */
async function runTool(name, args) {
  if (!VALUE_TOOLS.has(name)) return `Error: ${name} is not available in the offline eval. Use round_value or moment_value.`;
  const hit = resolveRound(args.round, priced.keys());
  if (!hit) return 'Error: That round was not found. Use a file from find_rounds.';
  const value = priced.get(hit.round);
  const tag = (out) => ({ content: fit(hit.repaired ? { round_used: repairedNote(hit.round), ...out } : out), resolved: hit.round });
  if (name === 'round_value') return tag(roundValueReport(value, args.moments));
  const left = parseClock(args.clock ?? '1:55');
  if (left == null) return { content: `Error: "${args.clock}" is not a clock time. Use a round clock such as 1:20.`, resolved: hit.round };
  return tag(momentReport(value, left));
}

// ---- the model ------------------------------------------------------------

const tools = has('--only-value') ? TOOLS.filter((t) => VALUE_TOOLS.has(t.function.name)) : TOOLS;

async function callModel(messages, offered) {
  const res = await fetch(`${llama}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(modelName ? { model: modelName } : {}),
      messages,
      tools: offered,
      temperature: 0.3,
      stream: false,
      chat_template_kwargs: { enable_thinking: has('--thinking') }
    })
  });
  if (!res.ok) throw new Error(`the model server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body.choices?.[0]?.message || {};
}

/** A stand-in model that does what the reference trace does: price the round, then give the reference answer. */
function oracleFor(c) {
  const script = [{ tool_calls: [{ function: { name: 'round_value', arguments: JSON.stringify({ round: c.round }) } }] }];
  if (c.kind === 'take') {
    const clock = clockLabel((parseClock(c.truth.clock) ?? 0) + 1);
    script.push({ tool_calls: [{ function: { name: 'moment_value', arguments: JSON.stringify({ round: c.round, clock }) } }] });
  }
  script.push({ content: c.reference });
  let i = 0;
  return async () => script[Math.min(i++, script.length - 1)];
}

// ---- run ------------------------------------------------------------------

if (!oracle) {
  const up = await fetch(`${llama}/health`).then((r) => r.ok).catch(() => false);
  if (!up) console.warn(`warning: ${llama}/health is not answering (fine for servers that have no /health).`);
}
fs.mkdirSync(outDir, { recursive: true });
const rows = [];
const scored = [];
const started = Date.now();
for (const [n, c] of cases.entries()) {
  const t0 = Date.now();
  const run = await runCase(c, { callModel: oracle ? oracleFor(c) : callModel, runTool, tools, systemPrompt: SYSTEM_PROMPT });
  const score = scoreCase(c, run);
  scored.push(score);
  rows.push({
    kind: c.kind,
    round: c.round,
    question: c.question,
    truth: c.truth,
    ...score,
    steps: run.steps,
    error: run.error,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    tool_calls: run.calls.map((x) => ({ name: x.name, args: x.args })),
    answer: run.answer
  });
  process.stdout.write(`\r${n + 1}/${cases.length} ${score.pass ? 'pass' : 'FAIL'} ${c.kind}     `);
}
process.stdout.write('\n');

const summary = { model: oracle ? 'oracle' : modelName || llama, cases: cases.length, seconds: Math.round((Date.now() - started) / 1000), ...summarise(scored) };
fs.writeFileSync(path.join(outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

const pct = (x) => (x === null ? '  - ' : `${Math.round(x * 100)}%`.padStart(4));
console.log(`\n${summary.model}: ${summary.cases} cases in ${summary.seconds}s -> ${outDir}`);
console.log('kind       cases  pass  tool1  args  exact-ids  grounded  recall  check  wrong-tool-calls');
for (const [k, g] of [['overall', summary.overall], ...Object.entries(summary.by_kind)]) {
  console.log(`${k.padEnd(10)} ${String(g.cases).padStart(5)} ${pct(g.pass)}  ${pct(g.tool_first)}  ${pct(g.args_ok)}  ${pct(g.exact_ids).padStart(9)}  ${pct(g.grounded).padStart(8)}  ${pct(g.swing_recall)}  ${pct(g.check)}  ${g.wrong_tool_calls}`);
}
for (const r of rows.filter((x) => !x.pass).slice(0, 3)) {
  console.log(`\nFAIL ${r.kind}: ${r.question}`);
  console.log(`  tools: ${r.tool_calls.map((x) => x.name).join(' -> ') || 'none'}  grounded=${r.grounded} ungrounded=[${r.ungrounded_numbers}] invented=[${r.invented_clocks}] check=${r.check}${r.error ? ` error=${r.error}` : ''}`);
  console.log(`  answer: ${r.answer.slice(0, 240).replace(/\n/g, ' / ')}`);
}
if (oracle && summary.overall.pass !== 1) process.exitCode = 1;

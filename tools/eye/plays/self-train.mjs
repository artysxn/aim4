#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tools/eye/plays/self-train.mjs
// The eye learns plays the way a player learns them: it guesses first, checks,
// keeps what it got right and writes down what it got wrong.
//
//   llama-server -m model.gguf --jinja -c 32768 --port 8899
//   node --max-old-space-size=8192 tools/eye/plays/self-train.mjs --llama http://127.0.0.1:8899 [corpus flags]
//
// Each item is one question about one round, asked the way the app asks it:
//
//   plays    the round's moves (round_moves) -> the model's guess of the plays,
//            sent as round_plays' guess -> the check (right, wrong, missed) ->
//            its answer
//   review   the round's plays -> the model's verdict on one, sent as
//            play_review's guess -> the review from similar rounds -> its answer
//
// What comes out, in --out (default tools/eye/plays/out/self-train):
//
//   sft.jsonl      every item as a trace to learn from. What the model got right
//                  stays in its own words (confirmed); what it got wrong is
//                  replaced by the right guess and the reference answer
//   dpo.jsonl      for every miss, the right turn preferred to the model's own:
//                  learning from its actual mistakes, not invented ones
//   state.json     per item: seen, right, streak. Wrong items come back first in
//                  the next run (reinforced); an item right twice in a row is
//                  confirmed and left alone
//   play-notes.json  the lessons (notes.mjs): what it keeps confusing, with the
//                  definitions. They ride in the play tools' results from the
//                  next item on, here and in the app (--publish copies them to
//                  public/eye/play-notes.json)
//   progress.jsonl one line per item: the scores, to watch it learn
//
// Flags:
//   --llama URL        an OpenAI-compatible server with tool calling
//   --model NAME       sent as "model"
//   --items N          items this run (default 200)
//   --tasks a,b        plays, review (default both)
//   --thinking         let the model think (slower; the app keeps it on for notes)
//   --parallel N       questions in flight (llama-server --parallel N)
//   --grades FILE      the admin training export: "Bad" eye answers' notes become lessons
//   --eval             the held-out matches instead: score only, nothing is learned or written
//                      but out/eval-<time>.json. Run it on the base model and on
//                      each fine-tune; ship one only if it beats the base
//   --mock perfect|noisy  no model: a stand-in that is always right, or right
//                      about half the time, to check the loop itself
//   --publish          copy play-notes.json to public/eye/play-notes.json
//   --fresh            forget state.json and the notes
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SAMPLING, SYSTEM_PROMPT } from '../../../src/replays/eye/eyeAgent.js';
import { TOOLS } from '../../../src/replays/eye/eyeTools.js';
import { checkGuess } from '../../../src/replays/plays/findPlays.js';
import { lessonsFor } from '../../../src/replays/plays/playTools.js';
import { OUT_DIR, corpusOptions, flagOf, hash, heldOut, loadCorpus } from './corpus.mjs';
import { baselinesFor, fit, movesResult, playsMemo, playsResult, readJsonl, reviewResult, roundLabel, truthGuess } from './common.mjs';
import { PLAYS_QUESTIONS, REVIEW_QUESTION, gradePairs, gradePlays, gradeReview, perturbGuess, playsAnswer, reviewAnswer, reviewable, verdictOf, wrongVerdict } from './answers.mjs';
import { buildLessons, countGuess, countVerdict, emptyStats, mergeStats } from './notes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { flag, has } = flagOf();
const outDir = flag('--out', path.join(OUT_DIR, 'self-train'));
const llama = flag('--llama', 'http://127.0.0.1:8899').replace(/\/$/, '');
const modelName = flag('--model');
const itemsWanted = Number(flag('--items', 200)) || 200;
const tasks = new Set(flag('--tasks', 'plays,review').split(','));
const parallel = Math.max(1, Number(flag('--parallel', 1)) || 1);
const mock = flag('--mock');
const evalMode = has('--eval');
const thinking = has('--thinking');
/** A guess scoring this or more counts as right. */
const GUESS_RIGHT = 80;

fs.mkdirSync(outDir, { recursive: true });
const STATE = path.join(outDir, 'state.json');
const NOTES = path.join(outDir, 'play-notes.json');
if (has('--fresh')) for (const f of [STATE, NOTES]) fs.rmSync(f, { force: true });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { v: 1, items: {}, stats: emptyStats(), runs: [] };
let notes = fs.existsSync(NOTES) ? JSON.parse(fs.readFileSync(NOTES, 'utf8')) : { lessons: [] };
const gradeRows = has('--grades') ? readJsonl(flag('--grades')).filter((r) => r.task === 'eye-trace') : [];
const graded = gradeRows.filter((r) => r.verdict === 'no' && r.comment).map((r) => ({ question: r.subject?.question, comment: r.comment }));

// ---- the model ----------------------------------------------------------------

async function callModel(messages) {
  const res = await fetch(`${llama}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(modelName ? { model: modelName } : {}),
      messages,
      tools: TOOLS,
      ...(thinking ? SAMPLING.thinking : SAMPLING.plain),
      stream: false,
      chat_template_kwargs: { enable_thinking: thinking }
    })
  });
  if (!res.ok) throw new Error(`the model server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const m = body.choices?.[0]?.message || {};
  return { content: String(m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), tool_calls: m.tool_calls || [] };
}

/**
 * A stand-in for the model that knows the answers: always right ("perfect"),
 * or wrong about half the time in the ways a small model is ("noisy").
 */
function mockModel(item) {
  return async (messages) => {
    const step = messages.filter((m) => m.role === 'assistant').length;
    const noisy = mock === 'noisy' && hash(`${item.key}:${step}:${state.runs.length}`) % 2 === 0;
    if (item.task === 'plays') {
      if (step === 1) {
        const guess = noisy ? perturbGuess(item.truthGuess, item.plays, `${item.key}:${state.runs.length}`) : item.truthGuess;
        return { content: '', tool_calls: [{ id: 'm1', type: 'function', function: { name: 'round_plays', arguments: JSON.stringify({ round: item.index.file, guess }) } }] };
      }
      const report = JSON.parse(messages.at(-1).content);
      return { content: noisy ? `${playsAnswer(report)}\nThat took 99 seconds.` : playsAnswer(report, { check: report.check }), tool_calls: [] };
    }
    if (step === 1) {
      const verdict = noisy ? wrongVerdict(item.truth.verdict, item.key) : item.truth.verdict;
      return { content: '', tool_calls: [{ id: 'm1', type: 'function', function: { name: 'play_review', arguments: JSON.stringify({ round: item.index.file, play: item.play.id, guess: { verdict } }) } }] };
    }
    const review = JSON.parse(messages.at(-1).content);
    return { content: noisy ? reviewAnswer({ ...review, verdict: wrongVerdict(review.verdict, item.key) }) : reviewAnswer(review), tool_calls: [] };
  };
}

// ---- items --------------------------------------------------------------------

const corpus = await loadCorpus(corpusOptions());
const baselines = await baselinesFor(corpus);
const playsOf = playsMemo();
const items = [];
for (const [map, indexes] of corpus) {
  const baseline = baselines.get(map);
  if (!baseline?.anchors?.sites) continue;
  for (const index of indexes) {
    if (heldOut(index.file) !== evalMode) continue;
    const plays = playsOf(index, baseline);
    if (!plays.length) continue;
    const label = `Round ${index.file} (${roundLabel(index)})`;
    if (tasks.has('plays')) items.push({ task: 'plays', key: `plays|${index.file}`, map, index, baseline, plays, label, truthGuess: truthGuess(plays), pool: indexes });
    if (tasks.has('review')) {
      for (const play of reviewable(plays)) items.push({ task: 'review', key: `review|${index.file}|${play.id}`, map, index, baseline, plays, label, play, pool: indexes });
    }
  }
}

/**
 * Reinforce, then learn, then confirm: items the model got wrong last time
 * first, then ones it has not seen, then ones right once. Right twice in a
 * row is confirmed and skipped.
 */
function schedule(all) {
  if (evalMode) return all.slice(0, itemsWanted);
  const tier = (it) => {
    const s = state.items[it.key];
    if (!s) return 1;
    if (s.streak === 0) return 0;
    if (s.streak === 1) return 2;
    return 3;
  };
  return all
    .map((it) => ({ it, tier: tier(it), order: hash(`${it.key}:${state.runs.length}`) }))
    .filter((x) => x.tier < 3)
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .slice(0, itemsWanted)
    .map((x) => x.it);
}

// ---- one item -------------------------------------------------------------------

let callN = 0;
const call = (name, args) => ({ id: `call_${callN++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const opening = (question) => [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: question }
];
const toolMsg = (c, result) => ({ role: 'tool', tool_call_id: c.id, content: fit(result) });
const argsOf = (c) => {
  try {
    return JSON.parse(c?.function?.arguments || '{}');
  } catch {
    return null;
  }
};
const asAssistant = (reply) => ({ role: 'assistant', content: reply.content || '', ...(reply.tool_calls?.length ? { tool_calls: reply.tool_calls.map((c, i) => ({ id: c.id || `m${i}`, type: 'function', function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) } })) } : {}) });

async function runPlays(item, model, stats) {
  callN = 0;
  const { index, baseline, plays, map } = item;
  const question = PLAYS_QUESTIONS[hash(`${item.key}:q`) % PLAYS_QUESTIONS.length](item.label);
  const lessons = lessonsFor(notes, { map, kinds: [...new Set(plays.map((p) => p.kind))] });
  const messages = opening(question);
  const movesCall = call('round_moves', { round: index.file });
  messages.push({ role: 'assistant', content: '', tool_calls: [movesCall] }, toolMsg(movesCall, movesResult(index, baseline)));

  // 1. Guess.
  const r1 = await model(messages);
  const guessCall = (r1.tool_calls || []).find((c) => c.function?.name === 'round_plays');
  const guess = Array.isArray(argsOf(guessCall)?.guess) ? argsOf(guessCall).guess : null;
  // 2. Check.
  const check = checkGuess(guess || [], plays);
  const guessRight = Boolean(guessCall) && check.score >= GUESS_RIGHT;
  countGuess(stats, map, plays, check);
  const report = playsResult(index, baseline, plays, { guess: guess || [], lessons });
  const said = guessCall ? { ...asAssistant(r1), content: '' } : null;
  const onPolicy = said ? [...messages, said, toolMsg(said.tool_calls.find((c) => c.function.name === 'round_plays'), report)] : null;
  // 3. Answer.
  let answer = '';
  let grade = { pass: false, grounded: false };
  if (onPolicy) {
    const r2 = await model(onPolicy);
    answer = r2.tool_calls?.length ? '' : r2.content;
    grade = gradePlays(answer, onPolicy.filter((m) => m.role === 'tool').map((m) => m.content), report, question);
  }
  // 4. Keep what was right, correct what was not.
  const out = { sft: null, dpo: [] };
  if (!evalMode) {
    const truth = item.truthGuess;
    const usedGuess = guessRight ? guess : truth;
    const usedReport = guessRight ? report : playsResult(index, baseline, plays, { guess: truth, lessons });
    const gc = call('round_plays', { round: index.file, guess: usedGuess });
    const trace = [...messages, { role: 'assistant', content: '', tool_calls: [gc] }, toolMsg(gc, usedReport)];
    const final = guessRight && grade.pass ? answer : playsAnswer(usedReport, { check: usedReport.check });
    out.sft = { kind: 'plays', confirmed: guessRight && grade.pass, messages: [...trace, { role: 'assistant', content: final }], tools: TOOLS };
    if (!guessRight) {
      const tc = call('round_plays', { round: index.file, guess: truth });
      out.dpo.push({ kind: 'plays-guess', prompt: messages, chosen: [{ role: 'assistant', content: '', tool_calls: [tc] }], rejected: [said || asAssistant(r1)], tools: TOOLS });
    }
    if (onPolicy && !grade.pass) {
      out.dpo.push({ kind: 'plays-answer', prompt: onPolicy, chosen: [{ role: 'assistant', content: playsAnswer(report, { check: report.check }) }], rejected: [{ role: 'assistant', content: answer }], tools: TOOLS });
    }
  }
  return { right: guessRight && grade.pass, guess_score: check.score, called: Boolean(guessCall), answer_pass: grade.pass, grounded: grade.grounded, recall: grade.recall ?? null, missed: check.missed.map((m) => m.label), ...out };
}

async function runReview(item, model, stats) {
  callN = 0;
  const { index, baseline, plays, play, map } = item;
  const question = REVIEW_QUESTION(item.label, play);
  const pool = item.pool.filter((x) => x !== index);
  const lessons = lessonsFor(notes, { map, kinds: [play.kind] });
  const messages = opening(question);
  const pc = call('round_plays', { round: index.file });
  messages.push({ role: 'assistant', content: '', tool_calls: [pc] }, toolMsg(pc, playsResult(index, baseline, plays, { lessons })));
  // What the numbers say, before the model is asked (the mock model reads it; the real one never sees it).
  item.truth = { verdict: reviewResult(index, play, pool, baseline, playsOf).verdict };

  // 1. Guess the verdict.
  const r1 = await model(messages);
  const reviewCall = (r1.tool_calls || []).find((c) => c.function?.name === 'play_review');
  const args = argsOf(reviewCall) || {};
  const rightPlay = String(args.play || '').toUpperCase().replace(/\s+/g, '') === play.id;
  const said = String(args.guess?.verdict || '').toLowerCase() || null;
  // 2. Check: the review, with the model's verdict checked in it.
  const review = reviewResult(index, play, pool, baseline, playsOf, { guess: said ? { verdict: said } : null, lessons });
  const verdictRight = said === review.verdict;
  countVerdict(stats, map, play.kind, review.verdict, said);
  const guessRight = Boolean(reviewCall) && rightPlay && verdictRight;
  const asked = reviewCall ? { ...asAssistant(r1), content: '' } : null;
  const onPolicy = asked && rightPlay ? [...messages, asked, toolMsg(asked.tool_calls.find((c) => c.function.name === 'play_review'), review)] : null;
  // 3. Answer.
  let answer = '';
  let grade = { pass: false, grounded: false };
  if (onPolicy) {
    const r2 = await model(onPolicy);
    answer = r2.tool_calls?.length ? '' : r2.content;
    grade = gradeReview(answer, onPolicy.filter((m) => m.role === 'tool').map((m) => m.content), review, question);
  }
  // 4. Keep and correct.
  const out = { sft: null, dpo: [] };
  if (!evalMode) {
    const truthArgs = { round: index.file, play: play.id, guess: { verdict: review.verdict } };
    const truthReview = verdictRight ? review : reviewResult(index, play, pool, baseline, playsOf, { guess: { verdict: review.verdict }, lessons });
    const rc = call('play_review', guessRight ? { ...args, round: index.file, play: play.id } : truthArgs);
    const trace = [...messages, { role: 'assistant', content: '', tool_calls: [rc] }, toolMsg(rc, guessRight ? review : truthReview)];
    const final = guessRight && grade.pass ? answer : reviewAnswer(guessRight ? review : truthReview);
    out.sft = { kind: 'review', confirmed: guessRight && grade.pass, messages: [...trace, { role: 'assistant', content: final }], tools: TOOLS };
    if (!guessRight) {
      const tc = call('play_review', truthArgs);
      out.dpo.push({ kind: 'review-guess', prompt: messages, chosen: [{ role: 'assistant', content: '', tool_calls: [tc] }], rejected: [asked || asAssistant(r1)], tools: TOOLS });
    }
    if (onPolicy && !grade.pass) {
      out.dpo.push({ kind: 'review-answer', prompt: onPolicy, chosen: [{ role: 'assistant', content: reviewAnswer(review) }], rejected: [{ role: 'assistant', content: answer }], tools: TOOLS });
    }
  }
  return { right: guessRight && grade.pass, verdict: said, truth: review.verdict, verdict_right: verdictRight, right_play: rightPlay, answer_pass: grade.pass, grounded: grade.grounded, said_in_answer: verdictOf(answer), ...out };
}

// ---- the run ----------------------------------------------------------------------

if (gradeRows.length && !evalMode) {
  const pairs = gradePairs(gradeRows, { systemPrompt: SYSTEM_PROMPT, tools: TOOLS });
  if (pairs.length) fs.appendFileSync(path.join(outDir, 'dpo.jsonl'), pairs.map((p) => JSON.stringify(p)).join('\n') + '\n');
  console.log(`Grades: ${graded.length} corrections become lessons, ${pairs.length} bad play answers paired with the answer their tool results support`);
}

const chosen = schedule(items);
if (!chosen.length) {
  console.log(items.length ? 'Every item is confirmed (right twice in a row). Add rounds, or run with --fresh.' : 'No items: the corpus has no rounds with bombsites learned.');
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runStats = emptyStats();
const rows = [];
const sft = fs.createWriteStream(path.join(outDir, 'sft.jsonl'), { flags: 'a' });
const dpo = fs.createWriteStream(path.join(outDir, 'dpo.jsonl'), { flags: 'a' });
const progress = fs.createWriteStream(path.join(outDir, evalMode ? `eval-${stamp}.jsonl` : 'progress.jsonl'), { flags: 'a' });
console.log(`${evalMode ? 'Evaluating' : 'Training on'} ${chosen.length} items (${items.length} in all${mock ? `, mock model: ${mock}` : `, model at ${llama}`})`);

let next = 0;
let done = 0;
async function worker() {
  while (next < chosen.length) {
    const item = chosen[next++];
    const model = mock ? mockModel(item) : callModel;
    let r;
    try {
      r = item.task === 'plays' ? await runPlays(item, model, runStats) : await runReview(item, model, runStats);
    } catch (err) {
      r = { right: false, error: err.message };
      if (/model server|fetch failed|ECONNREFUSED/.test(err.message) && !mock) {
        console.error(`\n${err.message}. Is llama-server running at ${llama}?`);
        process.exit(1);
      }
    }
    const { sft: s, dpo: d, ...score } = r;
    if (s) sft.write(`${JSON.stringify(s)}\n`);
    for (const pair of d || []) dpo.write(`${JSON.stringify(pair)}\n`);
    const row = { at: new Date().toISOString(), task: item.task, round: item.index.file, ...(item.play ? { play: item.play.id } : {}), ...score };
    rows.push(row);
    progress.write(`${JSON.stringify(row)}\n`);
    if (!evalMode) {
      const st = (state.items[item.key] ||= { seen: 0, right: 0, streak: 0 });
      st.seen += 1;
      if (r.right) {
        st.right += 1;
        st.streak += 1;
      } else st.streak = 0;
      st.last = row.at;
    }
    done++;
    if (process.stdout.isTTY) process.stdout.write(`\r${done} of ${chosen.length}`);
    else if (done % 25 === 0 || done === chosen.length) console.log(`${done} of ${chosen.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(parallel, chosen.length) }, worker));
if (process.stdout.isTTY) process.stdout.write('\n');
await Promise.all([sft, dpo, progress].map((s) => new Promise((resolve) => s.end(resolve))));

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const share = (xs) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 100) : null);
const playRows = rows.filter((r) => r.task === 'plays');
const reviewRows = rows.filter((r) => r.task === 'review');
const summary = {
  at: new Date().toISOString(),
  model: mock ? `mock:${mock}` : modelName || llama,
  items: rows.length,
  errors: rows.filter((r) => r.error).length,
  plays: { items: playRows.length, guess_score: mean(playRows.map((r) => r.guess_score ?? 0)), guess_called: share(playRows.map((r) => r.called)), answer_pass: share(playRows.map((r) => r.answer_pass)), grounded: share(playRows.map((r) => r.grounded)) },
  review: { items: reviewRows.length, verdict_right: share(reviewRows.map((r) => r.verdict_right)), right_play: share(reviewRows.map((r) => r.right_play)), answer_pass: share(reviewRows.map((r) => r.answer_pass)), grounded: share(reviewRows.map((r) => r.grounded)) },
  right: share(rows.map((r) => r.right))
};

if (evalMode) {
  fs.writeFileSync(path.join(outDir, `eval-${stamp}.json`), JSON.stringify(summary, null, 2));
} else {
  mergeStats(state.stats, runStats);
  state.runs.push(summary);
  fs.writeFileSync(STATE, JSON.stringify(state));
  notes = buildLessons(state.stats, { graded });
  fs.writeFileSync(NOTES, JSON.stringify(notes, null, 2));
  if (has('--publish')) {
    const pub = path.join(here, '../../../public/eye/play-notes.json');
    fs.mkdirSync(path.dirname(pub), { recursive: true });
    fs.copyFileSync(NOTES, pub);
  }
  const confirmed = Object.values(state.items).filter((s) => s.streak >= 2).length;
  console.log(`${confirmed} items confirmed so far, ${notes.lessons.length} lessons in ${NOTES}${has('--publish') ? ' (published)' : ''}`);
}
console.log(JSON.stringify(summary, null, 2));

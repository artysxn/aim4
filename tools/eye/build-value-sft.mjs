#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tools/eye/build-value-sft.mjs
// Turn every round in a folder of parsed demos into examples of judging a
// round from the numbers, for fine-tuning aim4 eye.
//
//   node --max-old-space-size=4096 tools/eye/build-value-sft.mjs [out-dir]
//        [--dir sampledemos] [--limit packages] [--seed text]
//
// Nothing here is rated by a person and nothing comes from a handbook. Each
// round is priced by the round model and the duel model (roundValue.js); the
// question is asked the way a coach would, the tool calls are the ones eye
// makes, the tool results are exactly what the tools return, and the answer
// is written from those results alone. So what the model learns is when a move
// was worth points and when it only looked good, and every number in an answer
// is one it was handed.
//
//   out/value-sft.jsonl    chat-format traces: system, question, tool calls,
//                          tool results, answer, plus the tool schemas
//   out/value-eval.jsonl   held-out demos (one in five): the question and what
//                          the numbers say is true, to score a model against
//
// Held-out means by demo, never by round: two rounds of one match share
// players, maps and economy, and splitting between them would leak.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYSTEM_PROMPT } from '../../src/replays/eye/eyeAgent.js';
import { MAX_RESULT_CHARS, TOOLS } from '../../src/replays/eye/eyeTools.js';
import { clockLabel } from '../../src/replays/eye/eyeImages.js';
import { momentReport, roundValueReport, valueRound, victimRead } from '../../src/replays/eye/roundValue.js';
import { prepareMap } from '../../scripts/lib/duelCorpus.mjs';
import { SAMPLE_DIR, eachRound } from '../../scripts/lib/sampledemoPackages.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const flag = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
const outDir = positional[0] || path.join(here, 'value-out');
const dir = flag('--dir', SAMPLE_DIR);
const limit = Number(flag('--limit', 0)) || 0;
const seed = flag('--seed', 'aim4');

/** Small stable hash, so the same round always gets the same wording and split. */
function hash(text) {
  let h = 2166136261;
  for (const ch of `${seed}:${text}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
const pick = (key, options) => options[hash(key) % options.length];

/** The tool's own cut: what the model is shown is what it is trained on. */
const fit = (value) => {
  const text = JSON.stringify(value);
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}… [cut: the rest did not fit]`;
};

const signed = (n) => `${n >= 0 ? '+' : ''}${n}`;
const parseSeconds = (clock) => {
  const [m, s] = clock.split(':').map(Number);
  return m * 60 + s;
};

// ---- answers, written from the tool results only ---------------------------

const swingLine = (m) =>
  `At ${m.clock}, ${m.text}. ${m.side} win chance went from ${m.win_chance.before}% to ${m.win_chance.after}% (${signed(m.swing_pp)} points)${m.why.length ? `, driven by ${m.why[0]}` : ''}.`;

function fightLine(m) {
  const f = m.fight;
  if (!f || f.killer_win_before_kill == null) return '';
  const who = m.killer ? `${m.killer}` : 'The killer';
  if (f.killer_read === 'upset') {
    return ` ${who} won a fight they were at ${f.killer_win_at_contact}% to win at contact and ${f.killer_win_before_kill}% just before the kill: an upset, so ${m.victim} was favoured and lost.`;
  }
  if (f.victim_win_at_contact < 35) {
    return ` ${m.victim} was at ${f.victim_win_at_contact}% to win this fight when it opened and ${f.victim_win_before_kill}% just before the kill: behind from the start.`;
  }
  if (f.victim_win_before_kill < 35) {
    return ` ${m.victim} was at ${f.victim_win_at_contact}% when the fight opened but ${f.victim_win_before_kill}% just before the kill: it turned against them.`;
  }
  return ` The fight was ${f.killer_win_at_contact}% for ${who} at contact and ${f.killer_win_before_kill}% just before the kill.`;
}

function decidedAnswer(report, key) {
  const top = [...report.biggest_swings].sort((a, b) => Math.abs(b.swing_pp) - Math.abs(a.swing_pp)).slice(0, 3).sort((a, b) => parseSeconds(b.clock) - parseSeconds(a.clock));
  const lead = pick(key, [`${report.winner} won the round. Three moments moved it most.`, `The round went to ${report.winner}, and it turned on three moments.`]);
  return [lead, ...top.map((m, i) => `${i + 1}. ${swingLine(m)}${fightLine(m)}`)].join('\n');
}

function playersAnswer(report) {
  const best = report.players[0];
  const worst = report.players.at(-1);
  const line = (p) => `${p.kills} ${p.kills === 1 ? 'kill' : 'kills'} and ${p.deaths} ${p.deaths === 1 ? 'death' : 'deaths'}, ${signed(p.wpa_pp)} points of round win chance${p.avg_fight_win_pct != null ? `, in fights that averaged ${p.avg_fight_win_pct}% for them` : ''}`;
  return `${best.player} (${best.side}) had the best round: ${line(best)}.\n${worst.player} (${worst.side}) had the worst: ${line(worst)}.`;
}

/** The verdict on a death: the tool's own victim_read (roundValue.js victimRead). */
export const takeVerdict = (f) => victimRead(f.victim_win_at_contact);

function takeAnswer(m, momentRep) {
  const f = m.fight;
  const at = momentRep.open_fights.find((x) => x.a.startsWith(m.victim) || x.b.startsWith(m.victim));
  const seen = at
    ? ` At ${momentRep.clock}, ${at.a} was ${at.a_win_pct}% against ${at.b} at ${at.b_win_pct}%.`
    : ` At ${momentRep.clock} no fight involving ${m.victim} was open yet.`;
  const cost = `the death moved ${m.side} win chance ${signed(m.swing_pp)} points`;
  const turned = Math.abs(f.victim_win_at_contact - f.victim_win_before_kill) >= 20 ? ' The fight turned between those two readings.' : '';
  const verdict = {
    behind: `${m.victim} was behind from the start: ${f.victim_win_at_contact}% to win the fight when it opened and ${f.victim_win_before_kill}% before the kill, and ${cost}. Whether they chose it or were caught in it, the positions at that clock show.${turned}`,
    favoured: `No. ${m.victim} was the favourite at ${f.victim_win_at_contact}% when the fight opened and ${f.victim_win_before_kill}% before the kill. Losing that is variance, not a mistake, even though ${cost}.${turned}`,
    close: `Not clearly. The fight was close: ${m.victim} at ${f.victim_win_at_contact}% when it opened and ${f.victim_win_before_kill}% before the kill, and ${cost}.${turned}`
  }[takeVerdict(f)];
  return `${verdict}${seen}`;
}

/** The loser's two costliest flagged moments: what a good answer to "what went wrong" should find. */
const lostFlags = (report, loser) =>
  report.costliest_flags
    .filter((f) => f.side === loser && f.cost_pp < 0)
    .sort((a, b) => a.cost_pp - b.cost_pp)
    .slice(0, 2)
    .sort((a, b) => parseSeconds(b.clock) - parseSeconds(a.clock));

/** The two biggest swings against the loser: what the winner did that hurt most. */
const lostHits = (report, loser) => report.biggest_swings.filter((m) => m.side !== loser && m.swing_pp > 0).sort((a, b) => b.swing_pp - a.swing_pp).slice(0, 2);

function wrongAnswer(report, loser, key) {
  const flags = lostFlags(report, loser);
  const hits = lostHits(report, loser);
  if (!flags.length && !hits.length) return null;
  const parts = [pick(key, [`${loser} lost it, and the numbers show where.`, `${loser} lost the round. Here is where it went.`])];
  for (const m of hits) parts.push(`- ${swingLine(m)}${fightLine(m)}`);
  for (const f of flags) parts.push(`- ${f.clock}, ${f.player} (flagged ${f.rule}): ${f.side} win chance moved ${f.cost_pp} points over the next two seconds.`);
  return parts.join('\n');
}

// ---- traces ----------------------------------------------------------------

let callN = 0;
const call = (name, args) => ({ id: `call_${callN++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const tool = (c, result) => ({ role: 'tool', tool_call_id: c.id, content: fit(result) });

/** A question, the calls that answer it, and the answer, as one chat record. */
function trace(question, steps, answer) {
  callN = 0;
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: question }];
  for (const step of steps) {
    const calls = step.map(([name, args]) => call(name, args));
    messages.push({ role: 'assistant', content: '', tool_calls: calls });
    step.forEach(([, , result], i) => messages.push(tool(calls[i], result)));
  }
  messages.push({ role: 'assistant', content: answer });
  return { messages, tools: TOOLS };
}

// ---- the corpus ------------------------------------------------------------

const train = [];
const evals = [];
const counts = { rounds: 0, skipped: 0, decided: 0, players: 0, take: 0, wrong: 0 };
const maps = new Map();
let packagesSeen = new Set();

for await (const { pkg, entry, meta, track } of eachRound({ dir, limit })) {
  packagesSeen.add(pkg.name);
  let network;
  try {
    network = await prepareMap(meta.map, maps);
  } catch {
    counts.skipped++;
    continue;
  }
  const value = valueRound({ meta, track, network });
  if (!value) {
    counts.skipped++;
    continue;
  }
  counts.rounds++;
  const heldOut = hash(pkg.name) % 5 === 0;
  const out = heldOut ? evals : train;
  const file = entry.file;
  const label = `${value.summary.teams} on ${value.summary.map}, round ${value.summary.round}`;
  const report = roundValueReport(value);
  const priceCall = ['round_value', { round: file }, report];
  const keyOf = (kind) => `${file}:${kind}`;
  const add = (kind, question, steps, answer, truth) => {
    if (!answer) return;
    counts[kind]++;
    const rec = trace(question, steps, answer);
    out.push(heldOut ? { kind, question, demo: pkg.name, round: file, truth, reference: answer } : { kind: `value-${kind}`, ...rec });
  };

  const top3 = [...report.biggest_swings].sort((a, b) => Math.abs(b.swing_pp) - Math.abs(a.swing_pp)).slice(0, 3);
  add(
    'decided',
    pick(keyOf('q1'), [`Round ${file} (${label}): what decided it?`, `${label} (round file ${file}). Walk me through what decided the round.`]),
    [[priceCall]],
    decidedAnswer(report, keyOf('a1')),
    { swing_clocks: top3.map((m) => m.clock), winner: report.winner }
  );

  if (report.players.length >= 2) {
    add(
      'players',
      `Round ${file} (${label}): who had the best round and who the worst?`,
      [[priceCall]],
      playersAnswer(report),
      { best: report.players[0].player, worst: report.players.at(-1).player }
    );
  }

  // One death worth asking about: the biggest swing that came out of a priced fight.
  const asked = report.biggest_swings.filter((m) => m.event === 'kill' && m.fight?.victim_win_at_contact != null).sort((a, b) => Math.abs(b.swing_pp) - Math.abs(a.swing_pp))[0];
  if (asked) {
    const clock = clockLabel(parseSeconds(asked.clock) + 1);
    const momentRep = momentReport(value, parseSeconds(clock));
    const f = asked.fight;
    const verdict = takeVerdict(f);
    add(
      'take',
      `Round ${file} (${label}): was ${asked.victim}'s death at ${asked.clock} a bad take?`,
      [[priceCall], [['moment_value', { round: file, clock }, momentRep]]],
      takeAnswer(asked, momentRep),
      { victim: asked.victim, clock: asked.clock, verdict }
    );
  }

  const loser = value.summary.winner?.startsWith('CT') ? 'T' : value.summary.winner?.startsWith('T') ? 'CT' : null;
  if (loser) {
    const answer = wrongAnswer(report, loser, keyOf('a4'));
    add('wrong', `Round ${file} (${label}): what went wrong for ${loser}?`, [[priceCall]], answer, {
      side: loser,
      flag_clocks: lostFlags(report, loser).map((f) => f.clock),
      hit_clocks: lostHits(report, loser).map((m) => m.clock)
    });
  }
}

fs.mkdirSync(outDir, { recursive: true });
const write = (name, rows) => fs.writeFileSync(path.join(outDir, name), rows.map((x) => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''));
write('value-sft.jsonl', train);
write('value-eval.jsonl', evals);
console.log(`${packagesSeen.size} demos, ${counts.rounds} rounds priced (${counts.skipped} skipped): ${train.length} training traces, ${evals.length} held-out eval cases -> ${outDir}`);
console.log({ decided: counts.decided, players: counts.players, take: counts.take, wrong: counts.wrong });

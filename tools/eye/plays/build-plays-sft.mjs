#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tools/eye/plays/build-plays-sft.mjs
// The first lessons, before the eye has guessed anything: traces of reading a
// round's plays and judging a play, built from what the measurements say.
//
//   node --max-old-space-size=8192 tools/eye/plays/build-plays-sft.mjs [corpus flags] [--out DIR] [--reviews N]
//
// Two skills, the way the app asks them (the system prompt, the tool schemas
// and the tool results are the app's own):
//
//   plays    "what did each side do / summarise the round / what was default":
//            round_moves -> the eye's reading of the plays, sent as round_plays'
//            guess -> the checked plays -> the answer in simple terms
//   review   "was that a good play, how could it be better": round_plays ->
//            play_review with the eye's verdict as guess -> the answer: the
//            verdict, why in numbers from the similar rounds, the improvements
//
// Here every guess is the right one, so the trace teaches reading a round
// into plays and the answer that follows. Wrong guesses are the self-training
// loop's job (self-train.mjs), with a real model making real mistakes; this
// script adds a few as preference pairs (a correct guess preferred to a
// plausibly wrong one), never as examples to imitate.
//
//   out/plays-sft.jsonl    chat traces (messages + tools)
//   out/plays-dpo.jsonl    { prompt, chosen, rejected, tools }
//   out/plays-eval.jsonl   held-out matches (one in five): the question and the truth
// ---------------------------------------------------------------------------

import path from 'node:path';

import { SYSTEM_PROMPT } from '../../../src/replays/eye/eyeAgent.js';
import { TOOLS } from '../../../src/replays/eye/eyeTools.js';
import { MIN_SIMILAR } from '../../../src/replays/plays/playReview.js';
import { OUT_DIR, corpusOptions, flagOf, hash, heldOut, loadCorpus } from './corpus.mjs';
import { baselinesFor, fit, movesResult, playsMemo, playsResult, reviewResult, roundLabel, truthGuess, writeJsonl } from './common.mjs';
import { PLAYS_QUESTIONS, REVIEW_QUESTION, perturbGuess, playsAnswer, reviewAnswer, reviewable, wrongVerdict } from './answers.mjs';

const { flag } = flagOf();
const outDir = flag('--out', OUT_DIR);
const reviewsPerRound = Number(flag('--reviews', 2));
const pick = (key, options) => options[hash(key) % options.length];

// ---- traces -------------------------------------------------------------------

let callN = 0;
const call = (name, args) => ({ id: `call_${callN++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** System, question, then each step's calls and results. */
function opening(question) {
  callN = 0;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question }
  ];
}
function step(messages, calls) {
  const made = calls.map(([name, args]) => call(name, args));
  messages.push({ role: 'assistant', content: '', tool_calls: made });
  calls.forEach(([, , result], i) => messages.push({ role: 'tool', tool_call_id: made[i].id, content: fit(result) }));
  return made;
}

// ---- the corpus ---------------------------------------------------------------

const corpus = await loadCorpus(corpusOptions());
const baselines = await baselinesFor(corpus);
const playsOf = playsMemo();
const sft = [];
const dpo = [];
const evals = [];
const counts = { rounds: 0, plays: 0, review: 0, thin: 0, dpo: 0, eval: 0 };

for (const [map, indexes] of corpus) {
  const baseline = baselines.get(map);
  if (!baseline?.anchors?.sites) {
    console.log(`${map}: no bombsites learned (no plants in the corpus), skipped`);
    continue;
  }
  for (const index of indexes) {
    const plays = playsOf(index, baseline);
    if (!plays.length) continue;
    counts.rounds++;
    const label = `Round ${index.file} (${roundLabel(index)})`;
    const held = heldOut(index.file);
    const key = index.file;

    // Skill 1: what happened, default or play.
    const question = pick(`${key}:q`, PLAYS_QUESTIONS)(label);
    const guess = truthGuess(plays);
    if (held) {
      evals.push({ kind: 'plays', question, round: index.file, map, truth: { plays: guess } });
      counts.eval++;
    } else {
      const messages = opening(question);
      step(messages, [['round_moves', { round: index.file }, movesResult(index, baseline)]]);
      const prompt = messages.map((m) => ({ ...m }));
      const report = playsResult(index, baseline, plays, { guess });
      step(messages, [['round_plays', { round: index.file, guess }, report]]);
      messages.push({ role: 'assistant', content: playsAnswer(report, { key }) });
      sft.push({ kind: 'plays', messages, tools: TOOLS });
      counts.plays++;
      // A plausibly wrong reading of the same round, never imitated: only ever the rejected side.
      if (hash(`${key}:dpo`) % 3 === 0) {
        const wrong = perturbGuess(guess, plays, key);
        const chosen = [{ role: 'assistant', content: '', tool_calls: [call('round_plays', { round: index.file, guess })] }];
        const rejected = [{ role: 'assistant', content: '', tool_calls: [call('round_plays', { round: index.file, guess: wrong })] }];
        dpo.push({ kind: 'plays-guess', prompt, chosen, rejected, tools: TOOLS });
        counts.dpo++;
      }
    }

    // Skill 2: was it good, how could it be better.
    for (const play of reviewable(plays).slice(0, reviewsPerRound)) {
      const pool = indexes.filter((x) => x !== index);
      const truth = reviewResult(index, play, pool, baseline, playsOf);
      if (truth.similar.rounds < MIN_SIMILAR) counts.thin++;
      const q = REVIEW_QUESTION(label, play);
      if (held) {
        evals.push({ kind: 'review', question: q, round: index.file, map, play: play.id, truth: { verdict: truth.verdict, improve: truth.improve, trust: truth.similar.trust } });
        counts.eval++;
        continue;
      }
      const messages = opening(q);
      step(messages, [['round_plays', { round: index.file }, playsResult(index, baseline, plays)]]);
      const prompt = messages.map((m) => ({ ...m }));
      const review = reviewResult(index, play, pool, baseline, playsOf, { guess: { verdict: truth.verdict } });
      step(messages, [['play_review', { round: index.file, play: play.id, guess: { verdict: truth.verdict } }, review]]);
      messages.push({ role: 'assistant', content: reviewAnswer(review) });
      sft.push({ kind: 'review', messages, tools: TOOLS });
      counts.review++;
      if (hash(`${key}:${play.id}:dpo`) % 3 === 0) {
        const chosen = [{ role: 'assistant', content: '', tool_calls: [call('play_review', { round: index.file, play: play.id, guess: { verdict: truth.verdict } })] }];
        const rejected = [{ role: 'assistant', content: '', tool_calls: [call('play_review', { round: index.file, play: play.id, guess: { verdict: wrongVerdict(truth.verdict, key) } })] }];
        dpo.push({ kind: 'review-guess', prompt, chosen, rejected, tools: TOOLS });
        counts.dpo++;
      }
    }
  }
}

writeJsonl(path.join(outDir, 'plays-sft.jsonl'), sft);
writeJsonl(path.join(outDir, 'plays-dpo.jsonl'), dpo);
writeJsonl(path.join(outDir, 'plays-eval.jsonl'), evals);
console.log(`${counts.rounds} rounds: ${sft.length} training traces (${counts.plays} plays, ${counts.review} reviews, ${counts.thin} of the reviews thin), ${dpo.length} preference pairs, ${evals.length} held-out cases -> ${outDir}`);

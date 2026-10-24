#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tools/eye/build-sft.mjs
// The admin training export (/api/admin/labels/export) turned into fine-tune
// data for aim4 eye's model. See tools/eye/TRAINING.md for the whole loop.
//
//   node tools/eye/build-sft.mjs export.jsonl out/ [gold-pairs.jsonl]
//
// Writes, one JSON object per line, OpenAI chat format (what unsloth, axolotl,
// mlx-lm and most trainers read):
//
//   out/sft.jsonl   examples to learn from
//     eye-trace  "Good" answers: the whole turn, tool calls and results, with
//                the tool schemas, so the model learns which tool, with what
//                arguments, and how to answer from the result
//     round      round beats -> the admin's own description (stage 2), or the
//                bot's when the admin said it was right (stages 1, 2)
//     review     an antistrat point -> keep it (yes) or the admin's correction
//                (stage 4, no) — the judgement document reviews need
//     opinion    the facts behind an opinion -> the opinion (stage 5, yes)
//     rewrite    the generated sheet -> the coach's manual sheet for the same
//                team and map (tools/eye/gold-pairs.mjs), in the sheet's language
//   out/eval.jsonl  what went wrong, kept out of training to test against:
//                "Bad" eye answers with the admin's note, rejected opinions
//   out/dpo.jsonl   preference pairs from the grades: a question answered once
//                "Good" and once "Bad" becomes { prompt, chosen, rejected }, the
//                good turn preferred to the bad one (tools/eye/train reads it)
//
// The notes written under "Bad" answers also reach the eye before any
// fine-tune: admins' next answers carry them in the prompt (eyeAgent.js
// gradeLessonsNote), and tools/eye/plays/self-train.mjs --grades turns them
// into lessons the play tools attach.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

const [input, outDir = 'sft-out', pairsFile] = process.argv.slice(2);
if (!input) {
  console.error('usage: node tools/eye/build-sft.mjs <export.jsonl> [out-dir]');
  process.exit(1);
}

const ROUND_SYSTEM = 'You describe one Counter-Strike 2 round for a coach, from its beats: who was where, what utility went where, who died where, how it ended. Short, plain, only what the beats show.';
const REVIEW_SYSTEM = 'You review one point of an antistrat sheet. Answer "Keep." when it is right and useful, or say what is wrong and how to fix it.';
const REWRITE_SYSTEM =
  'You rewrite a generated antistrat sheet into the sheet a coach would hand their team: positions, pistols, pace, tells as "this -> that (a of b)", notes and preparation for our side, forces and anti-ecos, default utility, dangerous rounds, players, other statistics. Keep only what matters, say what to do about it, and use only numbers the generated sheet has.';
const OPINION_SYSTEM = 'You are given facts from an antistrat sheet. Say what follows from them for the team playing against this one, in one or two sentences.';

const chat = (system, user, assistant) => ({
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: user },
    { role: 'assistant', content: assistant }
  ]
});

const sft = [];
const evals = [];
/** Graded eye turns by question, for preference pairs. */
const byQuestion = new Map();
const questionKey = (q) => String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
const counts = {};
const count = (k) => (counts[k] = (counts[k] || 0) + 1);

for (const line of fs.readFileSync(input, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  if (!r.stage) continue; // the header line
  const yes = r.verdict === 'yes';
  const bot = r.bot || {};
  const s = r.subject || {};

  if (r.task === 'eye-trace' && Array.isArray(bot.messages) && s.question) {
    const k = questionKey(s.question);
    if (!byQuestion.has(k)) byQuestion.set(k, { yes: [], no: [] });
    byQuestion.get(k)[yes ? 'yes' : 'no'].push(r);
  }
  if (r.task === 'eye-trace') {
    if (yes && Array.isArray(bot.messages) && bot.messages.at(-1)?.role === 'assistant') {
      sft.push({ kind: 'eye-trace', messages: [{ role: 'system', content: bot.system || '' }, ...bot.messages], ...(bot.tools ? { tools: bot.tools } : {}) });
      count('eye-trace');
    } else if (!yes) {
      evals.push({ kind: 'eye-trace', question: s.question, model: s.model, bad_answer: bot.text, note: r.comment || '', messages: bot.messages });
      count('eval eye-trace');
    }
  } else if (r.task === 'round-describe') {
    const beats = JSON.stringify({ beats: bot.beats, facts: bot.facts });
    if (r.answer) sft.push({ kind: 'round', ...chat(ROUND_SYSTEM, beats, r.answer) });
    else if (yes) sft.push({ kind: 'round', ...chat(ROUND_SYSTEM, beats, bot.text) });
    else continue;
    count('round');
  } else if (r.task === 'antistrat-point') {
    const user = `${s.team} on ${s.map}, ${bot.side || ''} ${bot.section || ''} (${(s.files || []).length} rounds):\n${bot.text}`;
    if (yes) sft.push({ kind: 'review', ...chat(REVIEW_SYSTEM, user, 'Keep.') });
    else if (r.comment) sft.push({ kind: 'review', ...chat(REVIEW_SYSTEM, user, r.comment) });
    else continue;
    count('review');
  } else if (r.task === 'opinion') {
    const facts = (bot.because || []).map((f) => `- ${typeof f === 'string' ? f : f.text || JSON.stringify(f)}`).join('\n');
    if (yes && facts) {
      sft.push({ kind: 'opinion', ...chat(OPINION_SYSTEM, `${s.team} on ${s.map}:\n${facts}`, bot.text) });
      count('opinion');
    } else if (!yes) {
      evals.push({ kind: 'opinion', facts, rejected: bot.text, note: r.comment || '' });
      count('eval opinion');
    }
  }
}

if (pairsFile) {
  for (const line of fs.readFileSync(pairsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const p = JSON.parse(line);
    const lang = p.lang === 'ru' ? ' Write it in Russian.' : '';
    sft.push({ kind: 'rewrite', ...chat(REWRITE_SYSTEM + lang, `${p.team} on ${p.map}, ${p.demos} demos, ${p.rounds} rounds:\n${p.generated}`, p.manual) });
    count('rewrite');
  }
}

// A question graded both ways: the good turn preferred to the bad one, from the question on.
const dpo = [];
for (const { yes: goods, no: bads } of byQuestion.values()) {
  for (const good of goods) {
    for (const bad of bads) {
      const gm = good.bot.messages;
      const bm = bad.bot.messages;
      const gi = gm.findIndex((m) => m.role === 'user');
      const bi = bm.findIndex((m) => m.role === 'user');
      if (gi < 0 || bi < 0) continue;
      dpo.push({
        kind: 'eye-grade',
        prompt: [{ role: 'system', content: good.bot.system || '' }, ...gm.slice(0, gi + 1)],
        chosen: gm.slice(gi + 1),
        rejected: bm.slice(bi + 1),
        note: bad.comment || '',
        ...(good.bot.tools ? { tools: good.bot.tools } : {})
      });
      count('dpo eye-grade');
    }
  }
}

fs.mkdirSync(outDir, { recursive: true });
const write = (name, rows) => fs.writeFileSync(path.join(outDir, name), rows.map((x) => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''));
write('sft.jsonl', sft);
write('eval.jsonl', evals);
write('dpo.jsonl', dpo);
console.log(`${sft.length} training examples, ${evals.length} eval cases, ${dpo.length} preference pairs -> ${outDir}`);
console.log(counts);

// ---------------------------------------------------------------------------
// tools/eye/plays/answers.mjs
// The answers the eye is trained toward, and how its own answers are graded.
//
// Reference answers are written from the tool results alone (every number in
// them is in a result), in the plain words a coach uses. Grading is the same
// idea as valueScore.mjs: every number and clock grounded in a tool result,
// plus the check of the question: the plays named for "what happened", the
// verdict and the improvements for "was it good".
//
// Pure functions: no model, no data.
// ---------------------------------------------------------------------------

import { FAMILY, HIT_KINDS } from '../../../src/replays/plays/findPlays.js';
import { groundingOf, inventedClocks } from '../valueScore.mjs';
import { hash } from './corpus.mjs';

const pick = (key, options) => options[hash(key) % options.length];

// ---- the questions --------------------------------------------------------------

export const PLAYS_QUESTIONS = [
  (label) => `${label}: what did each side do? Which parts were default and which were plays?`,
  (label) => `Summarize ${label} in simple terms.`,
  (label) => `${label}: what was the play on each side, and what was just their default?`
];
export const REVIEW_QUESTION = (label, play) => `${label}: was ${play.side}'s ${play.label} at ${play.clock} a good play? How could it have been better?`;

/** The plays of a round worth a review: the T hit (or default), and one CT decision. */
export function reviewable(plays) {
  const t = plays.find((p) => p.side === 'T' && HIT_KINDS.has(p.kind)) || plays.find((p) => p.side === 'T' && p.kind === 'default');
  const ct = plays.find((p) => p.side === 'CT' && ['stack', 'rotate', 'retake', 'push'].includes(p.kind)) || plays.find((p) => p.side === 'CT' && p.kind === 'setup');
  return [t, ct].filter(Boolean);
}

// ---- what happened -----------------------------------------------------------

const KIND_WORDS = {
  default: ['default'],
  execute: ['execute'],
  split: ['split'],
  rush: ['rush'],
  contact: ['contact'],
  lurk: ['lurk'],
  rotate: ['rotat'],
  postplant: ['post-plant', 'postplant', 'after the plant'],
  save: ['save', 'saved'],
  setup: ['setup', 'set up'],
  stack: ['stack'],
  push: ['push'],
  aggression: ['push', 'aggress'],
  retake: ['retake', 'retook']
};
/** Kinds an answer about a round is expected to name. */
const NAMED = new Set(['default', 'execute', 'split', 'rush', 'contact', 'lurk', 'rotate', 'postplant', 'save', 'setup', 'stack', 'push', 'retake']);

/**
 * The answer to "what did each side do": the summary in simple terms, then
 * which parts were default and which were plays, each with how usual it is
 * and what it did to the win chance.
 *
 * @param {object} report  round_plays result
 * @param {{ key?: string, check?: object|null }} [opts]  check: when the guess was imperfect, one line on what it missed
 */
export function playsAnswer(report, { key = report.round, check = null } = {}) {
  const lines = [report.summary];
  const defaults = report.plays.filter((p) => p.default);
  const plays = report.plays.filter((p) => !p.default && p.kind !== 'opening' && p.kind !== 'aggression');
  if (defaults.length) {
    const parts = defaults.map((p) => {
      if (p.kind === 'default') {
        const unusual = p.shape_unusual_pct != null && p.shape_unusual_pct >= 80 ? `, a shape more unusual than ${p.shape_unusual_pct}% of rounds` : '';
        return `${p.side} played its default until ${p.outcome.to}${unusual}`;
      }
      return `${p.side}'s ${p.label.replace(/ \(A-mid-B\)$/, '')} is a common one${p.usual ? ` (${p.usual})` : ''}`;
    });
    lines.push(`${pick(`${key}:d`, ['Default:', 'What was default:'])} ${parts.join('; ')}.`);
  }
  if (plays.length) {
    const parts = plays.map((p) => {
      const win = p.outcome.win_before != null && p.outcome.win_after != null ? `, ${p.side} win chance ${p.outcome.win_before}% to ${p.outcome.win_after}%` : '';
      const usual = p.usual ? ` (${p.usual})` : '';
      return `${p.side} ${p.label} at ${p.clock}${usual}${win}`;
    });
    lines.push(`${pick(`${key}:p`, ['Plays:', 'The plays:'])} ${parts.join('; ')}.`);
  }
  if (check && (check.missed?.length || check.wrong?.length)) {
    const missed = check.missed.slice(0, 2).map((m) => `${m.side} ${m.label}`);
    const wrong = check.wrong.slice(0, 2).map((w) => `${w.guess.side} ${w.guess.kind}${w.guess.site ? ` ${w.guess.site}` : ''}`);
    const bits = [missed.length && `I missed ${missed.join(' and ')}`, wrong.length && `I wrongly read ${wrong.join(' and ')}`].filter(Boolean);
    lines.push(`${bits.join('; ')}.`);
  }
  return lines.join('\n');
}

/** Which of the round's plays an answer names, by kind words and site. */
export function playsNamed(answer, plays) {
  const text = String(answer).toLowerCase();
  const wanted = plays.filter((p) => NAMED.has(p.kind));
  const named = wanted.filter((p) => (KIND_WORDS[p.kind] || [p.kind]).some((w) => text.includes(w)));
  return { wanted: wanted.length, named: named.length, missing: wanted.filter((p) => !named.includes(p)).map((p) => p.label) };
}

/** Grade an answer to "what did each side do". */
export function gradePlays(answer, toolTexts, report, question = '') {
  const g = groundingOf(answer, toolTexts, question);
  const clocks = inventedClocks(answer, toolTexts, question);
  const n = playsNamed(answer, report.plays);
  const recall = n.wanted ? n.named / n.wanted : 1;
  const grounded = !g.ungrounded.length && !clocks.length;
  return { pass: grounded && recall >= 2 / 3 && String(answer).trim().length > 0, grounded, ungrounded: [...g.ungrounded, ...clocks], recall: Math.round(recall * 100), missing: n.missing };
}

// ---- was it good --------------------------------------------------------------

const VERDICT_LEAD = {
  good: ['Good play.', 'It was a good play.'],
  bad: ['Bad play.', 'It was a bad play.'],
  mixed: ['Mixed.', 'Neither clearly good nor clearly bad.']
};

/**
 * The answer to "was that play good, and how could it be better", from the
 * play_review result.
 */
export function reviewAnswer(review, { key = `${review.round}:${review.play?.id}` } = {}) {
  const lines = [];
  const reads = [];
  if (review.decision && review.decision !== 'unclear') reads.push(`the choice was ${review.decision}`);
  if (review.execution_read && review.execution_read !== 'unclear') reads.push(`it went ${review.execution_read}`);
  lines.push(`${pick(`${key}:v`, VERDICT_LEAD[review.verdict] || VERDICT_LEAD.mixed)}${reads.length ? ` For ${review.play.side}'s ${review.play.label} at ${review.play.from}, ${reads.join(', and ')}.` : ''}`);
  for (const w of review.why || []) lines.push(`- ${w}`);
  if (review.improve?.length) {
    lines.push(pick(`${key}:i`, ['How it could be better:', 'What would have helped:']));
    for (const i of review.improve.slice(0, 3)) lines.push(`- ${i}`);
  } else {
    lines.push('The similar rounds show no clear improvement over what was done.');
  }
  const s = review.similar;
  if (s) {
    const trust = s.trust === 'thin' ? 'too few to rely on' : s.trust === 'loose' ? 'only loosely alike, so take it as a lean' : s.trust === 'fair' ? 'a fair match' : 'a close match';
    lines.push(`Based on ${s.rounds} similar rounds (closest ${s.closest_pct ?? 0}%, median ${s.median_pct ?? 0}%): ${trust}.`);
  }
  if (review.guidelines) {
    const flags = review.guidelines.flags || [];
    lines.push(
      flags.length
        ? `Too few similar rounds to measure it, so these are the autocoach's rules, not measurements: ${flags.map((f) => `${f.player}: ${f.text}`).join('; ')}.`
        : 'Too few similar rounds to measure it, and the autocoach flagged nothing in this window.'
    );
  }
  return lines.join('\n');
}

/** Which verdict an answer gives, read off its first line. */
export function verdictOf(answer) {
  const first = String(answer).split('\n')[0].toLowerCase();
  const said = [];
  if (/\bgood (play|call|decision)|\bit was good\b|^good\b/.test(first)) said.push('good');
  if (/\bbad (play|call|decision)|\bit was bad\b|^bad\b|\bmistake\b/.test(first)) said.push('bad');
  if (/\bmixed\b|neither clearly|both good and bad|not clearly/.test(first)) said.push('mixed');
  return said.length === 1 ? said[0] : null;
}

/** Grade an answer to "was that play good". */
export function gradeReview(answer, toolTexts, review, question = '') {
  const g = groundingOf(answer, toolTexts, question);
  const clocks = inventedClocks(answer, toolTexts, question);
  const grounded = !g.ungrounded.length && !clocks.length;
  const verdict = verdictOf(answer);
  const verdictRight = verdict === review.verdict;
  // An improvement the review gave is named with one of its counts.
  const improveNumbers = (review.improve || []).flatMap((i) => i.match(/\d+ of \d+/g) || []);
  const improved = !improveNumbers.length || improveNumbers.some((n) => String(answer).includes(n));
  const trustSaid = !['thin', 'loose'].includes(review.similar?.trust) || /thin|few|loose|lean|not enough|little evidence/i.test(answer);
  return { pass: grounded && verdictRight && improved && trustSaid, grounded, ungrounded: [...g.ungrounded, ...clocks], verdict, verdictRight, improved, trustSaid };
}

// ---- guesses ------------------------------------------------------------------

/** A guess with one plausible mistake: what a model that half-reads a round sends. */
export function perturbGuess(guess, plays, key) {
  const g = guess.map((x) => ({ ...x }));
  if (!g.length) return [{ side: 'T', kind: 'execute', site: 'A', clock: '1:10' }];
  const i = hash(`${key}:i`) % g.length;
  const how = hash(`${key}:how`) % 4;
  const item = g[i];
  if (how === 0 && HIT_KINDS.has(item.kind)) {
    // The right idea, the wrong kind of hit: an execute read as a contact.
    const others = [...HIT_KINDS].filter((k) => k !== item.kind);
    item.kind = others[hash(`${key}:k`) % others.length];
  } else if (how === 1 && item.site) {
    item.site = item.site === 'A' ? 'B' : 'A';
  } else if (how === 2 && g.length > 1) {
    g.splice(i, 1);
  } else {
    // A play that was not there.
    const side = item.side;
    const absent = Object.keys(FAMILY).filter((k) => k !== 'opening' && k !== 'aggression' && !plays.some((p) => p.side === side && FAMILY[p.kind] === FAMILY[k]));
    if (absent.length) g.push({ side, kind: absent[hash(`${key}:a`) % absent.length], clock: '1:20' });
    else g.splice(i, 1);
  }
  return g;
}

/** A verdict that is not the review's. */
export const wrongVerdict = (verdict, key) => {
  const others = ['good', 'bad', 'mixed'].filter((v) => v !== verdict);
  return others[hash(key) % others.length];
};

// ---- grades -------------------------------------------------------------------

/**
 * "Bad" answers to a plays or review question, paired with the answer the
 * tools' own results support: the turn as it was, up to the answer, then the
 * reference answer preferred to the one that was graded bad.
 */
export function gradePairs(rows, { systemPrompt = '', tools = [] } = {}) {
  const pairs = [];
  for (const r of rows) {
    if (r.verdict !== 'no' || !Array.isArray(r.bot?.messages)) continue;
    const msgs = r.bot.messages;
    const last = msgs.at(-1);
    if (last?.role !== 'assistant' || !last.content) continue;
    const lastTool = [...msgs].reverse().find((m) => m.role === 'tool');
    const callOf = (m) => msgs.flatMap((x) => x.tool_calls || []).find((c) => c.id === m?.tool_call_id);
    const name = callOf(lastTool)?.function?.name;
    let result;
    try {
      result = JSON.parse(lastTool?.content || '');
    } catch {
      continue; // cut to fit the record: no reference can be written from half a result
    }
    const reference = name === 'play_review' && result.verdict ? reviewAnswer(result) : name === 'round_plays' && Array.isArray(result.plays) ? playsAnswer(result, { check: result.check }) : null;
    if (!reference) continue;
    pairs.push({
      kind: 'eye-grade-reference',
      prompt: [{ role: 'system', content: r.bot.system || systemPrompt }, ...msgs.slice(0, -1)],
      chosen: [{ role: 'assistant', content: reference }],
      rejected: [{ role: 'assistant', content: last.content }],
      note: r.comment || '',
      tools: r.bot.tools || tools
    });
  }
  return pairs;
}

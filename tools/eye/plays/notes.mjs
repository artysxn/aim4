// ---------------------------------------------------------------------------
// tools/eye/plays/notes.mjs
// What the eye keeps getting wrong, written down as lessons it reads again.
//
// The self-training loop (self-train.mjs) counts every guess against what the
// round showed: which kinds of play the eye reads as which, which it misses,
// which it sees where there were none, how far off its clocks are, and which
// verdicts it expects before the numbers come in. Here those counts become
// short lessons, each with the definition of what it confused (the same
// words round_plays answers with), and the corrections written under "Bad"
// answers join them. The app attaches the ones that fit a round to the play
// tools' results (/eye/play-notes.json), and the next training run includes
// them in its traces, so a lesson works before and after a fine-tune.
//
// Pure: counts in, lessons out.
// ---------------------------------------------------------------------------

import { DEFINITIONS, FAMILY, elapsedOf } from '../../../src/replays/plays/findPlays.js';
import { MAPS } from '../../../src/replays/shared/roundId.js';

export const NOTES_VERSION = 1;
/** A pattern needs this many rounds before it is a lesson. */
const MIN_ROUNDS = 4;
/** And has to be wrong at least this often. */
const WRONG_SHARE = 0.3;
/** Lessons kept in all. */
const MAX_LESSONS = 60;

const mapName = (code) => MAPS[code]?.name || code;
const sideWord = (side) => (side === 'CT' ? 'CT' : 'T');

export function emptyStats() {
  return { confusion: {}, missed: {}, extra: {}, clock: {}, verdicts: {} };
}

/**
 * Count one checked guess of a round's plays.
 * @param {object} stats   emptyStats()
 * @param {string} map
 * @param {object[]} plays  the round's plays
 * @param {object} check    checkGuess(guess, plays)
 */
export function countGuess(stats, map, plays, check) {
  const matched = new Map(check.right.map((r) => [r.play, r]));
  for (const p of plays) {
    if (p.kind === 'opening' || p.kind === 'aggression') continue;
    const key = `${map}|${p.side}|${p.kind}`;
    const c = (stats.confusion[key] ||= { n: 0, right: 0, said: {} });
    c.n += 1;
    const r = matched.get(p.id);
    if (r) {
      if (r.credit >= 1) c.right += 1;
      else c.said[r.guess.kind] = (c.said[r.guess.kind] || 0) + 1;
      const ge = elapsedOf(r.guess.clock);
      if (ge != null) {
        const k = (stats.clock[p.kind] ||= { n: 0, sum: 0 });
        k.n += 1;
        k.sum += Math.abs(ge - p.start);
      }
    } else {
      const m = (stats.missed[key] ||= { n: 0, missed: 0 });
      m.n += 1;
      m.missed += 1;
    }
  }
  for (const w of check.wrong) {
    const key = `${map}|${w.guess.side}|${w.guess.kind}`;
    stats.extra[key] = (stats.extra[key] || 0) + 1;
  }
}

/** Count one verdict guess against the review's. */
export function countVerdict(stats, map, kind, truth, said) {
  const key = `${map}|${kind}|${truth}`;
  const v = (stats.verdicts[key] ||= { n: 0, right: 0, said: {} });
  v.n += 1;
  if (said === truth) v.right += 1;
  else v.said[said || 'none'] = (v.said[said || 'none'] || 0) + 1;
}

/** Merge two stats (a run's into the kept ones). */
export function mergeStats(into, more) {
  for (const part of ['confusion', 'verdicts']) {
    for (const [k, v] of Object.entries(more[part] || {})) {
      const t = (into[part][k] ||= { n: 0, right: 0, said: {} });
      t.n += v.n;
      t.right += v.right;
      for (const [s, n] of Object.entries(v.said)) t.said[s] = (t.said[s] || 0) + n;
    }
  }
  for (const [k, v] of Object.entries(more.missed || {})) {
    const t = (into.missed[k] ||= { n: 0, missed: 0 });
    t.n += v.n;
    t.missed += v.missed;
  }
  for (const [k, v] of Object.entries(more.extra || {})) into.extra[k] = (into.extra[k] || 0) + v;
  for (const [k, v] of Object.entries(more.clock || {})) {
    const t = (into.clock[k] ||= { n: 0, sum: 0 });
    t.n += v.n;
    t.sum += v.sum;
  }
  return into;
}

const top = (said) => Object.entries(said).sort((a, b) => b[1] - a[1])[0] || null;

/**
 * Lessons from the counts, worst first, plus the graders' corrections.
 *
 * @param {object} stats
 * @param {{ graded?: Array<{ question?: string, comment: string }> }} [extra]
 * @returns {{ v: number, built_at: string, lessons: object[] }}
 */
export function buildLessons(stats, { graded = [] } = {}) {
  const lessons = [];
  const add = (l) => lessons.push(l);

  for (const [key, c] of Object.entries(stats.confusion)) {
    const [map, side, kind] = key.split('|');
    const t = top(c.said);
    if (c.n < MIN_ROUNDS || !t) continue;
    const share = t[1] / c.n;
    if (share < WRONG_SHARE) continue;
    add({
      map,
      side,
      kind,
      weight: t[1],
      text: `On ${mapName(map)} as ${sideWord(side)}, you read ${t[1]} of ${c.n} ${kind}s as a ${t[0]}. ${DEFINITIONS[kind] || ''}`.trim()
    });
  }
  for (const [key, m] of Object.entries(stats.missed)) {
    const [map, side, kind] = key.split('|');
    const n = stats.confusion[key]?.n || m.n;
    if (n < MIN_ROUNDS || m.missed / n < WRONG_SHARE) continue;
    add({ map, side, kind, weight: m.missed, text: `On ${mapName(map)}, you missed the ${sideWord(side)} ${kind} in ${m.missed} of ${n} rounds. ${DEFINITIONS[kind] || ''}`.trim() });
  }
  for (const [key, n] of Object.entries(stats.extra)) {
    const [map, side, kind] = key.split('|');
    if (n < MIN_ROUNDS || !DEFINITIONS[kind]) continue;
    // Only when the kind is not in the round: a guess that names a play of the right family is a confusion, counted above.
    add({ map, side, kind, weight: n, text: `On ${mapName(map)}, ${n} times you named a ${sideWord(side)} ${kind} that was not in the round. ${DEFINITIONS[kind]}` });
  }
  for (const [kind, k] of Object.entries(stats.clock)) {
    if (k.n < MIN_ROUNDS * 2) continue;
    const off = Math.round(k.sum / k.n);
    if (off < 10) continue;
    add({ kind, weight: k.n / 4, text: `Your clock for a ${kind} was off by ${off} s on average. ${DEFINITIONS[kind] || ''} Give the clock it starts at, read from the moves.`.trim() });
  }
  for (const [key, v] of Object.entries(stats.verdicts)) {
    const [map, kind, truth] = key.split('|');
    const t = top(v.said);
    if (v.n < MIN_ROUNDS || !t || t[1] / v.n < WRONG_SHARE) continue;
    const family = FAMILY[kind] === 'hit' ? `${kind} hits` : `${kind} plays`;
    add({
      map,
      kind,
      weight: t[1],
      text: `On ${mapName(map)}, you expected ${t[1]} of ${v.n} ${family} the similar rounds called ${truth} to be ${t[0]}. Judge a play by what similar rounds did from that moment and how it went, not by how the play looks.`
    });
  }
  for (const g of graded.slice(0, 20)) {
    if (!g?.comment) continue;
    const q = String(g.question || '').replace(/\s+/g, ' ').trim();
    add({ weight: 50, text: `A grader marked an answer wrong${q ? ` ("${q.length > 100 ? `${q.slice(0, 97)}...` : q}")` : ''}: ${String(g.comment).replace(/\s+/g, ' ').trim()}` });
  }
  lessons.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  return { v: NOTES_VERSION, built_at: new Date().toISOString(), lessons: lessons.slice(0, MAX_LESSONS) };
}

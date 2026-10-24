// ---------------------------------------------------------------------------
// replays/plays/playReview.js
// Was a play good or bad, and how could it have gone better: answered from
// the rounds most like it, not from a rule.
//
// The moment a play started is put to Similar Rounds (similar/roundSimilarity.js):
// the rounds on the map, in the same economy, whose players stood where these
// stood, holding what these held, having thrown what these threw. Then, over
// those rounds:
//
//   choices     what the same side did from that moment (an A execute, a B
//               contact, no hit...), how often, and how each went: rounds won
//               and the side's average win-chance change over the play
//   execution   this play's win-chance change against the rounds that made
//               the same choice: better or worse than they did with it
//   what helped among the rounds that made the same choice, the grenades
//               (kind and where they landed) and the timings that went with
//               more wins: "with a flash on B site 9 of 14 won, without it
//               6 of 16". Those this play lacked are the improvements
//   verdict     good, bad or mixed, from the choice against the alternatives
//               and the execution against the same choice
//
// The autocoach's rules are a last resort: they are attached only when there
// are too few similar rounds to say anything (`guidelines`), and marked as
// rules, not measurements.
//
// DOM-free: the desktop server runs it over the rounds a scan holds, the
// training tools over a corpus.
// ---------------------------------------------------------------------------

import { buildQuery, scoreRound } from '../similar/roundSimilarity.js';
import { FAMILY, HIT_KINDS, clockOf, findPlays } from './findPlays.js';
import { placeOf, winAt, wonBy } from './playMap.js';

/** Similar rounds kept: the closest, at most K_MAX, never under SIM_FLOOR percent. */
const K_MAX = 60;
const SIM_FLOOR = 15;
/** Below this many similar rounds the review says it is thin and the autocoach's rules come in. */
export const MIN_SIMILAR = 8;
/** A choice or an ingredient needs this many rounds on each side of a comparison. */
const MIN_GROUP = 3;
/** Utility landing within this many units counts as the same grenade across rounds. */
const NADE_RADIUS = 450;
/** Utility read from this long before a play starts to this long after; for a hit, around its entry. */
const UTIL_FROM = -15;
const UTIL_TO = 10;
const HIT_UTIL_FROM = -20;
const HIT_UTIL_TO = 5;
/** A difference in win rate smaller than this (points) is not worth saying. */
const WORTH_PP = 12;
/** A play that starts before this many seconds is compared at this many seconds (1:40). */
const SET_UP = 15;
/** Seconds a start has to differ by to count as earlier or later. */
const TIMING_APART = 8;

const NADE_NAME = { 1: 'smoke', 2: 'molotov', 3: 'flash', 4: 'HE' };
const pct = (a, n) => (n ? Math.round((a / n) * 100) : null);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const round0 = (x) => (x == null ? null : Math.round(x));

/** Two proportions, how far apart in standard errors (pooled). */
function zOf(a1, n1, a2, n2) {
  if (!n1 || !n2) return 0;
  const p = (a1 + a2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? (a1 / n1 - a2 / n2) / se : 0;
}
const confidenceOf = (z) => (Math.abs(z) >= 2 ? 'strong' : Math.abs(z) >= 1.5 ? 'fair' : 'weak');

// ---- choices ------------------------------------------------------------------

/**
 * What a round's side chose from the moment `e`, in the terms of the play's
 * family: the question a review answers is "they did X; what did similar
 * rounds do instead, and how did that go".
 */
export function choiceOf(plays, side, family, e) {
  const own = plays.filter((p) => p.side === side);
  const hit = own.find((p) => HIT_KINDS.has(p.kind));
  const near = (p, before = 5, after = 20) => p.start >= e - before && p.start <= e + after;
  switch (family) {
    case 'hit':
    case 'default':
      if (hit) return { key: `${hit.kind} ${hit.site}`, play: hit };
      return { key: own.some((p) => p.kind === 'save') ? 'no hit (saved)' : 'no hit', play: null };
    case 'lurk': {
      const lurk = own.find((p) => p.kind === 'lurk');
      return lurk ? { key: 'kept a lurk', play: lurk } : { key: 'no lurk', play: hit };
    }
    case 'rotate': {
      const rot = own.find((p) => p.kind === 'rotate' && near(p, 10, 25));
      return rot ? { key: `rotated to ${rot.to}`, play: rot } : { key: 'did not rotate', play: null };
    }
    case 'postplant': {
      const pp = own.find((p) => p.kind === 'postplant');
      if (!pp) return { key: 'no plant', play: null };
      const on = Number(/: (\d+) on the site/.exec(pp.label)?.[1] || 0);
      const off = Number(/(\d+) off it/.exec(pp.label)?.[1] || 0);
      return { key: on >= off ? 'held on the site' : 'held off the site', play: pp };
    }
    case 'save': {
      const save = own.find((p) => p.kind === 'save');
      return save ? { key: 'saved', play: save } : { key: 'played for the round', play: null };
    }
    case 'setup': {
      const stack = own.find((p) => p.kind === 'stack');
      if (stack) return { key: `stack ${stack.site}`, play: stack };
      const setup = own.find((p) => p.kind === 'setup');
      const m = /setup (\d)-(\d)-(\d)/.exec(setup?.label || '');
      if (!m) return { key: 'no setup read', play: null };
      const [a, , b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return { key: a >= 3 ? 'heavy A' : b >= 3 ? 'heavy B' : 'spread', play: setup };
    }
    case 'push': {
      const push = own.find((p) => (p.kind === 'push' || p.kind === 'aggression') && near(p, 10, 10));
      return push ? { key: push.kind === 'push' ? 'pushed together' : 'one player pushed', play: push } : { key: 'held back', play: null };
    }
    case 'retake': {
      const retake = own.find((p) => p.kind === 'retake');
      if (retake) return { key: /together/.test(retake.label) ? 'retook together' : 'retook one by one', play: retake };
      return { key: own.some((p) => p.kind === 'save') ? 'saved' : 'no retake', play: null };
    }
    case 'opening':
    default: {
      const first = plays.find((p) => p.kind === 'opening' && near(p, 10, 10));
      if (!first) return { key: 'no early kill', play: null };
      return { key: first.side === side ? 'won the opening' : 'lost the opening', play: first };
    }
  }
}

// ---- the review --------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.source    the round's index
 * @param {object} args.play      one of findPlays(source).plays
 * @param {object[]} args.pool    candidate indexes (the map's rounds; the gate keeps the right economy)
 * @param {object} args.baseline  the map's baseline
 * @param {(index: object) => object[]} [args.playsOf]  plays of a round (memoised by the caller)
 * @param {object[]} [args.coachFlags]  the autocoach's flags for the source round: { e, player, side, rule, text, cost_pp }
 * @param {{ verdict?: string, why?: string }|null} [args.guess]
 */
export function reviewPlay({ source, play, pool, baseline, playsOf = null, coachFlags = [], guess = null }) {
  const plays = playsOf || ((index) => findPlays(index, baseline).plays);
  const side = play.side;
  const family = FAMILY[play.kind] || 'opening';
  // The moment compared: when the play started, or for one that starts with the round (a default,
  // a setup) once the players have left spawn, when every round still looks the same.
  const e = play.start < SET_UP ? Math.min(Math.max(play.start, SET_UP), play.end) : play.start;
  const span = Math.max(10, Math.min(40, play.end - e));

  // 1. The rounds most like this one when the play started: both sides' buys first, this side's only if that is too few.
  let similar = [];
  let gate = 'both sides\' buys';
  for (const both of [true, false]) {
    const q = buildQuery(source, { tick: source.freezeEndTick + e * source.tickRate, side, both });
    const scored = [];
    for (const index of pool) {
      const r = scoreRound(q, index);
      if (r && r.similarity >= SIM_FLOOR) scored.push({ index, sim: r.similarity });
    }
    scored.sort((a, b) => b.sim - a.sim);
    similar = scored.slice(0, K_MAX);
    if (similar.length >= MIN_SIMILAR || !both) break;
    gate = `${side} buys only`;
  }

  const sourcePlays = plays(source);
  const sourceChoice = choiceOf(sourcePlays, side, family, e);
  const swingOf = (index, from) => {
    const before = winAt(index, from, side);
    const endE = (index.endTick - index.freezeEndTick) / index.tickRate;
    const after = from + span >= endE ? (wonBy(index, side) ? 100 : 0) : winAt(index, from + span, side);
    return before == null || after == null ? null : after - before;
  };
  const thisSwing = swingOf(source, e);
  const rows = similar.map(({ index, sim }) => {
    const ps = plays(index);
    const choice = choiceOf(ps, side, family, e);
    return { index, sim, choice, won: wonBy(index, side), swing: swingOf(index, e) };
  });

  // 2. Choices and how each went.
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.choice.key) || { choice: r.choice.key, rows: [] };
    g.rows.push(r);
    groups.set(r.choice.key, g);
  }
  const choices = [...groups.values()]
    .map((g) => {
      const won = g.rows.filter((r) => r.won).length;
      return {
        choice: g.choice,
        rounds: g.rows.length,
        won,
        win_pct: pct(won, g.rows.length),
        avg_swing_pp: round0(mean(g.rows.map((r) => r.swing).filter((x) => x != null))),
        ...(g.choice === sourceChoice.key ? { this_play: true } : {})
      };
    })
    .sort((a, b) => b.rounds - a.rounds);
  const wonAll = rows.filter((r) => r.won).length;
  const expected = { win_pct: pct(wonAll, rows.length), avg_swing_pp: round0(mean(rows.map((r) => r.swing).filter((x) => x != null))) };

  const same = rows.filter((r) => r.choice.key === sourceChoice.key);
  const mine = choices.find((c) => c.this_play) || null;
  let bestAlt = null;
  for (const c of choices) {
    if (c.this_play || c.rounds < MIN_GROUP + 2) continue;
    const z = mine ? zOf(c.won, c.rounds, mine.won, mine.rounds) : 0;
    if (!bestAlt || c.win_pct > bestAlt.win_pct) bestAlt = { ...c, z };
  }

  // 3. Execution: this play's swing among the rounds that chose the same.
  let execution = null;
  const sameSwings = same.map((r) => r.swing).filter((x) => x != null).sort((a, b) => a - b);
  if (thisSwing != null && sameSwings.length >= MIN_GROUP) {
    const below = sameSwings.filter((x) => x < thisSwing).length;
    const median = sameSwings[sameSwings.length >> 1];
    execution = {
      rounds: sameSwings.length,
      median_swing_pp: Math.round(median),
      better_than_pct: pct(below, sameSwings.length),
      read: thisSwing >= median + 10 ? 'went better than most rounds that did the same' : thisSwing <= median - 10 ? 'went worse than most rounds that did the same' : 'went about as the same choice usually goes'
    };
  }

  // 4. What went with winning among the rounds that made the same choice.
  const helped = ingredients({ source, sourcePlay: play, sourceChoice, same: same.length >= MIN_GROUP * 2 ? same : rows, side, baseline });
  const timing = timingOf({ sourceChoice, same, family });

  // 5. Verdict.
  const execGap = execution && thisSwing != null ? thisSwing - execution.median_swing_pp : thisSwing != null && expected.avg_swing_pp != null ? thisSwing - expected.avg_swing_pp : null;
  const decisionGap = bestAlt && mine ? bestAlt.win_pct - mine.win_pct : null;
  const altClearlyBetter = decisionGap != null && decisionGap >= 15 && bestAlt.z >= 1;
  const missing = helped.filter((h) => h.this_play === 'missing' && h.with.win_pct - h.without.win_pct >= WORTH_PP);
  let verdict = 'mixed';
  const why = [];
  if (execGap != null && execGap >= 10 && !altClearlyBetter) verdict = 'good';
  else if (execGap != null && execGap <= -10 && (altClearlyBetter || missing.length)) verdict = 'bad';
  else if (altClearlyBetter && (thisSwing ?? 0) <= 0) verdict = 'bad';
  else if (execGap == null && thisSwing != null) verdict = thisSwing >= 10 ? 'good' : thisSwing <= -10 ? 'bad' : 'mixed';
  if (thisSwing != null) why.push(`${side} win chance ${thisSwing >= 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(thisSwing))} points over the play${expected.avg_swing_pp != null ? ` (similar rounds: ${expected.avg_swing_pp >= 0 ? '+' : ''}${expected.avg_swing_pp} on average)` : ''}.`);
  if (mine) why.push(`Similar rounds that chose ${mine.choice} won ${mine.won} of ${mine.rounds} (${mine.win_pct}%).`);
  if (altClearlyBetter) why.push(`Those that chose ${bestAlt.choice} won ${bestAlt.won} of ${bestAlt.rounds} (${bestAlt.win_pct}%).`);
  if (execution) why.push(`It ${execution.read} (better than ${execution.better_than_pct}% of them).`);

  const improve = [];
  for (const h of missing.slice(0, 3)) improve.push(`Add ${h.what} ${h.when}: with it ${h.with.won} of ${h.with.rounds} won (${h.with.win_pct}%), without it ${h.without.won} of ${h.without.rounds} (${h.without.win_pct}%).`);
  for (const h of helped.filter((x) => x.this_play === 'had it' && x.without.win_pct - x.with.win_pct >= WORTH_PP).slice(0, 1)) {
    improve.push(`Rethink ${h.what}: rounds without it did better, ${h.without.won} of ${h.without.rounds} (${h.without.win_pct}%) against ${h.with.won} of ${h.with.rounds} (${h.with.win_pct}%).`);
  }
  if (timing?.better) improve.push(timing.better);
  if (altClearlyBetter) improve.push(`Consider ${bestAlt.choice} from here: ${bestAlt.won} of ${bestAlt.rounds} won (${bestAlt.win_pct}%) against ${mine.won} of ${mine.rounds} (${mine.win_pct}%) for ${mine.choice}.`);

  const thin = rows.length < MIN_SIMILAR;
  // The verdict in two parts: the choice against the alternatives, the execution against the same choice.
  const parts = {
    decision: !mine || !bestAlt ? 'unclear' : altClearlyBetter ? `worse than ${bestAlt.choice}` : mine.win_pct >= bestAlt.win_pct ? 'the best of the choices' : 'about as good as the alternatives',
    execution: execGap == null ? 'unclear' : execGap >= 10 ? 'better than usual' : execGap <= -10 ? 'worse than usual' : 'as usual'
  };
  const simValues = rows.map((r) => r.sim);
  const out = {
    play: { id: play.id, side, kind: play.kind, label: play.label, from: play.clock, to: clockOf(play.end) },
    this_play: {
      choice: sourceChoice.key,
      win_before: round0(winAt(source, e, side)),
      swing_pp: round0(thisSwing),
      round_won: wonBy(source, side)
    },
    similar: {
      rounds: rows.length,
      matched_on: `positions, weapons and utility at ${clockOf(e)}, ${gate}`,
      closest_pct: simValues.length ? Math.round(simValues[0]) : null,
      median_pct: simValues.length ? Math.round(simValues[simValues.length >> 1]) : null,
      trust: thin ? 'thin' : trustOf(simValues),
      examples: rows.slice(0, 3).map((r) => ({ round: r.index.file, similarity: Math.round(r.sim), choice: r.choice.key, won: r.won }))
    },
    choices: choices.slice(0, 6),
    expected,
    ...(execution ? { execution } : {}),
    what_helped: helped.slice(0, 5),
    ...(timing ? { timing: timing.table } : {}),
    verdict,
    decision: parts.decision,
    execution_read: parts.execution,
    // How far to trust the verdict: thin or loose similar rounds make it a lean, not a finding.
    confidence: thin ? 'low' : trustOf(simValues) === 'good' && rows.length >= 20 ? 'high' : 'medium',
    why,
    improve,
    how_to_read:
      'swing_pp is the side\'s round win chance change over the play (percentage points), the same window in every round. choices: what the same side did from this moment in the similar rounds and how it went. what_helped compares, among the rounds that made the same choice, those with a grenade landing in a place against those without; this_play says whether this round had it. trust: how close the similar rounds were (good, fair, loose) or thin (too few to rely on).'
  };
  if (thin || (!helped.length && !bestAlt)) {
    const flags = (coachFlags || []).filter((f) => (!f.side || f.side === side) && f.e >= play.start - 5 && f.e <= play.end + 2);
    out.guidelines = {
      note: 'Too few similar rounds to measure this play. These are the autocoach\'s rules, not measurements: use them as a guide only.',
      flags: flags.slice(0, 5).map((f) => ({ clock: clockOf(f.e), player: f.player, rule: f.rule, text: f.text, ...(f.cost_pp != null ? { cost_pp: f.cost_pp } : {}) }))
    };
  }
  if (guess?.verdict) {
    const said = String(guess.verdict).toLowerCase();
    out.your_guess = { said, numbers_say: verdict, right: said === verdict };
  }
  return out;
}

/** How close the similar rounds were, by their median similarity. */
function trustOf(simValues) {
  const median = simValues[simValues.length >> 1] || 0;
  return median >= 45 ? 'good' : median >= 25 ? 'fair' : 'loose';
}

/**
 * When a play's utility is read around: a hit's entry onto the site (its
 * grenades land just before it, whenever the walk up began), else its start.
 */
const anchorOf = (play) => play?.raw?.wave_at ?? play?.start ?? null;

/** Grenades of the side around a play: from UTIL_FROM to UTIL_TO seconds of its anchor. */
function nadesAround(index, side, at, hit) {
  const code = side === 'T' ? 1 : 2;
  const from = at + (hit ? HIT_UTIL_FROM : UTIL_FROM);
  const to = at + (hit ? HIT_UTIL_TO : UTIL_TO);
  return (index.nades || []).filter((n) => n.side === code && n.t >= from && n.t <= to).map((n) => ({ ...n, rel: n.t - at }));
}

function ingredients({ source, sourcePlay, sourceChoice, same, side, baseline }) {
  // Each round's grenades around its own play (its choice's play, or the moment).
  const hit = (p) => Boolean(p?.raw?.wave_at != null);
  const per = same.map((r) => ({ r, nades: nadesAround(r.index, side, anchorOf(r.choice.play) ?? sourcePlay.start, hit(r.choice.play)) }));
  const own = sourceChoice.play || sourcePlay;
  const sourceNades = nadesAround(source, side, anchorOf(own), hit(own));
  const entry = hit(own);
  // Clusters of the same kind landing in the same place, seeded by every grenade seen.
  const clusters = [];
  for (const n of [...sourceNades, ...per.flatMap((p) => p.nades)]) {
    let c = clusters.find((k) => k.kind === n.kind && Math.hypot(k.x - n.x, k.y - n.y) <= NADE_RADIUS);
    if (!c) {
      c = { kind: n.kind, x: n.x, y: n.y, sx: 0, sy: 0, n: 0, rel: [] };
      clusters.push(c);
    }
    c.sx += n.x;
    c.sy += n.y;
    c.n += 1;
    c.rel.push(n.rel);
  }
  const out = [];
  for (const c of clusters) {
    const cx = c.sx / c.n;
    const cy = c.sy / c.n;
    const has = (nades) => nades.some((n) => n.kind === c.kind && Math.hypot(n.x - cx, n.y - cy) <= NADE_RADIUS);
    const withR = per.filter((p) => has(p.nades)).map((p) => p.r);
    const withoutR = per.filter((p) => !has(p.nades)).map((p) => p.r);
    if (withR.length < MIN_GROUP || withoutR.length < MIN_GROUP) continue;
    const a1 = withR.filter((r) => r.won).length;
    const a2 = withoutR.filter((r) => r.won).length;
    const z = zOf(a1, withR.length, a2, withoutR.length);
    const diff = pct(a1, withR.length) - pct(a2, withoutR.length);
    if (Math.abs(diff) < WORTH_PP || Math.abs(z) < 1) continue;
    const rel = [...c.rel].sort((a, b) => a - b)[c.rel.length >> 1];
    const where = placeOf(baseline, cx, cy).name;
    out.push({
      what: `${c.kind === 4 ? 'an' : 'a'} ${NADE_NAME[c.kind]} landing ${/site$/.test(where) ? 'on' : 'at'} ${where}`,
      when: entry
        ? rel <= -2
          ? `about ${Math.round(-rel)} s before the players step on the site`
          : rel >= 2
            ? `about ${Math.round(rel)} s after they step on it`
            : 'as they step on the site'
        : rel <= -2
          ? `about ${Math.round(-rel)} s before the play starts`
          : rel >= 2
            ? `about ${Math.round(rel)} s into the play`
            : 'as the play starts',
      with: { rounds: withR.length, won: a1, win_pct: pct(a1, withR.length), avg_swing_pp: round0(mean(withR.map((r) => r.swing).filter((x) => x != null))) },
      without: { rounds: withoutR.length, won: a2, win_pct: pct(a2, withoutR.length), avg_swing_pp: round0(mean(withoutR.map((r) => r.swing).filter((x) => x != null))) },
      this_play: has(sourceNades) ? 'had it' : 'missing',
      confidence: confidenceOf(z)
    });
  }
  return out.sort((a, b) => Math.abs(b.with.win_pct - b.without.win_pct) - Math.abs(a.with.win_pct - a.without.win_pct));
}

/** Earlier, about the same, or later than this play started, among rounds that made the same choice. */
function timingOf({ sourceChoice, same, family }) {
  if (!['hit', 'default', 'rotate', 'retake', 'push'].includes(family) || !sourceChoice.play) return null;
  const at = sourceChoice.play.start;
  const bins = { earlier: [], same: [], later: [] };
  for (const r of same) {
    const s = r.choice.play?.start;
    if (s == null) continue;
    bins[s <= at - TIMING_APART ? 'earlier' : s >= at + TIMING_APART ? 'later' : 'same'].push(r);
  }
  if (bins.earlier.length + bins.same.length + bins.later.length < MIN_GROUP * 2) return null;
  const table = Object.fromEntries(
    Object.entries(bins).map(([k, rs]) => [k, { rounds: rs.length, won: rs.filter((r) => r.won).length, win_pct: pct(rs.filter((r) => r.won).length, rs.length) }])
  );
  table.this_play_started = clockOf(at);
  let better = null;
  const here = table.same;
  for (const k of ['later', 'earlier']) {
    const t = table[k];
    if (t.rounds < MIN_GROUP + 1 || here.rounds < MIN_GROUP) continue;
    if (t.win_pct - here.win_pct >= 15 && zOf(t.won, t.rounds, here.won, here.rounds) >= 1) {
      better = `Start ${k === 'later' ? 'later' : 'earlier'} (${TIMING_APART}+ s ${k === 'later' ? 'after' : 'before'} ${clockOf(at)}): ${t.won} of ${t.rounds} won (${t.win_pct}%) against ${here.won} of ${here.rounds} (${here.win_pct}%) at about this time.`;
      break;
    }
  }
  return { table, better };
}

// ---------------------------------------------------------------------------
// Player scout: the scan engine.
//
// The team report asks "what does this team do on this map". This one asks it
// of one body, and the answer is split into two halves that a coach uses
// differently:
//
//   default      the things he repeats. A grenade from the same spot at the
//                same moment, a walk to the same ground at the same moment,
//                round after round.
//   non-default  the rounds where he does something else. Those are the set
//                calls, and each one is written out the way a strategy is
//                written: him first, then the four bodies around him.
//
// What counts as repeating is the definition this report is built on:
//
//   An action repeats when the same action (the same grenade at the same
//   named spot, or arriving on the same named ground) happens within +/-5
//   seconds of the same clock in MORE THAN 20% of his rounds on that side.
//
// A side has SEVERAL defaults, not one. A team runs an A default and a B
// default in tandem, and the player has a different opening in each. So a
// default is a CORE of up to three of those actions that more than 20% of his
// rounds contain, and a round runs a default when it contains one, whatever
// else it also does. A round containing none is a non-default round, and those
// group by their whole opening: one group is one variation.
//
// Defaults overlap where he runs two in one round, and the same round is
// counted under both. It is two things he does, not half of each.
//
// Only the first OPENING_SECONDS decide it. A default is what he does off the
// buy: goes A, smokes at 1:38, and then the round happens. Reading past 1:35
// would call every round different, because after the first contact every
// round IS different.
//
// Buys are held at full buy vs full buy throughout, because that is the set
// the question is about: an eco is not a player choosing to do something
// different, it is a player with no choice. Every other buy still rides along
// in the heatmaps, which filter for themselves.
//
// Round loading, geometry and utility naming are the team report's
// (antistratScan.js `extractRounds`), so both reports read a round the same
// way and a fix to one is a fix to both.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { buyBucket } from '../shared/roundId.js';
import { roleForPlayer } from '../roles/computeRoles.js';
import { extractRounds, packPoints } from './antistratScan.js';

/** Two actions this far apart on the clock are the same action. */
export const TIMING_TOLERANCE_SECONDS = 5;
/** Above this share of rounds an action counts as one he repeats. */
export const RECURRING_MIN_SHARE = 0.2;
/**
 * How much of the round decides default vs non-default: 1:55 down to 1:35.
 *
 * The opening is the call. What happens after it is the round reacting to the
 * other five, and no two of those are ever the same.
 */
export const OPENING_SECONDS = 20;
/** The clock OPENING_SECONDS lands on, for the report to say out loud. */
export const OPENING_CLOCK = '1:35';
/** Ground held for fewer samples than this is transit, not a position. */
const MIN_HOLD_SAMPLES = 3;
/** A first run ending before this is the walk out of spawn, not a position. */
const SPAWN_SECONDS = 8;
/** Variations written per side. Anything past it is counted, never dropped silently. */
export const MAX_VARIATIONS = 8;
/** Actions named in one opening's label. */
const LABEL_ACTIONS = 3;
/** Rounds of an opening that must reach one site before it is named for it. */
const SITE_NAME_MIN_SHARE = 65;
/** Defaults written out as strategies per side. */
export const MAX_DEFAULTS = 4;
/** Actions in one default's core. Past three it stops being a call and starts being a round. */
const MAX_CORE = 3;
/** A grenade thrown in fewer rounds of a call than this is not part of it. */
const UTIL_MIN_SHARE = 25;
/** Grenade rows one call carries. Anything past it is counted, never dropped in silence. */
const UTIL_ROWS_MAX = 24;
/** Samples one player heatmap carries. */
const HEAT_POINT_CAP = 3000;
/** Throws one nade-path widget carries. */
const NADE_PATH_CAP = 600;

const NADE_KINDS = ['smokegrenade', 'molotov', 'flashbang', 'hegrenade'];

export const NADE_WORD = {
  smokegrenade: 'Smoke',
  molotov: 'Molo',
  flashbang: 'Flash',
  hegrenade: 'Nade'
};

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Elapsed seconds -> the round clock counting down from 1:55. */
export function clockAt(elapsed) {
  if (!Number.isFinite(elapsed)) return '';
  const left = Math.max(0, Math.round(ROUND_SECONDS - elapsed));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Everything one player did in one round that a strategy would bother naming.
 *
 * Two kinds only, because they are the two a call is made of: a grenade
 * leaving his hand, and him arriving somewhere and staying there. A body
 * clipping the corner of a zone on the way past is not an action, which is
 * what MIN_HOLD_SAMPLES is for.
 *
 * @param {object} r          a round from `extractRounds`
 * @param {string} playerId
 * @returns {Array<{kind: string, key: string, label: string, spot: string, type: string, t: number}>}
 */
export function playerActions(r, playerId) {
  const out = [];

  for (const n of r.nades || []) {
    if (n.player !== playerId) continue;
    const spot = n.name || n.zone || '';
    if (!spot) continue;
    const t = ROUND_SECONDS - n.clock;
    if (!Number.isFinite(t)) continue;
    out.push({
      kind: 'nade',
      key: `nade|${n.type}|${spot.toLowerCase()}`,
      label: `${NADE_WORD[n.type] || 'Nade'} ${spot}`,
      spot,
      type: n.type,
      t: Math.max(0, t)
    });
  }

  // Runs of named ground, from the 1s samples.
  const runs = [];
  let cur = null;
  for (const s of r.series || []) {
    const p = (s.pts || []).find((x) => x.id === playerId);
    const pos = p?.pos || '';
    if (cur && cur.pos === pos) {
      cur.samples += 1;
      cur.to = s.elapsed;
      continue;
    }
    if (cur) runs.push(cur);
    cur = pos ? { pos, from: s.elapsed, to: s.elapsed, samples: 1 } : null;
  }
  if (cur) runs.push(cur);

  const held = runs.filter((run) => run.samples >= MIN_HOLD_SAMPLES);
  // The ground he spawns on is the buy, not a call. It only stops being the
  // spawn once he is still standing there well into the round, which is what a
  // CT anchor who spawns on his site actually does.
  const first = held[0];
  const startAt = first && first.to < SPAWN_SECONDS ? 1 : 0;
  for (let i = startAt; i < held.length; i++) {
    const run = held[i];
    out.push({
      kind: 'go',
      key: `go|${run.pos.toLowerCase()}`,
      label: `Go ${run.pos}`,
      spot: run.pos,
      type: '',
      t: Math.max(0, run.from)
    });
  }

  return out.sort((a, b) => a.t - b.t);
}

/**
 * Group one key's timings into the moments it actually happens at.
 *
 * Greedy widest window first: the biggest cluster of timings inside a
 * 2 x tolerance span is taken, then the next biggest out of what is left. A
 * player who smokes the same spot early on some rounds and late on others has
 * two habits, not one habit with a wide error bar.
 *
 * @param {Array<{file: string, t: number}>} hits
 * @param {number} tolerance
 */
export function clusterTimings(hits, tolerance = TIMING_TOLERANCE_SECONDS) {
  const sorted = [...hits].sort((a, b) => a.t - b.t);
  const used = new Array(sorted.length).fill(false);
  const span = tolerance * 2;
  const out = [];
  for (;;) {
    let best = null;
    for (let i = 0; i < sorted.length; i++) {
      if (used[i]) continue;
      const members = [];
      for (let j = i; j < sorted.length && sorted[j].t - sorted[i].t <= span; j++) {
        if (!used[j]) members.push(j);
      }
      if (!best || members.length > best.length) best = members;
    }
    if (!best || !best.length) break;
    for (const i of best) used[i] = true;
    const times = best.map((i) => sorted[i].t);
    out.push({
      t: median(times),
      from: Math.min(...times),
      to: Math.max(...times),
      files: best.map((i) => sorted[i].file),
      rounds: best.length
    });
  }
  return out.sort((a, b) => b.rounds - a.rounds || a.t - b.t);
}

/**
 * The actions this player repeats, and at what moment.
 *
 * Read over the whole round, not just the opening: a smoke he throws at 1:20 in
 * half his rounds is a habit worth writing down even though it happens long
 * after the call was made.
 *
 * @param {Array<{file: string, actions: Array}>} rounds
 * @param {Map} index   from buildTimeIndex, over the same rounds
 * @param {number} minShare
 * @returns {Array<{key, kind, label, spot, type, t, clock, share, rounds, files}>}
 */
export function recurringActions(rounds, index, minShare = RECURRING_MIN_SHARE) {
  /** @type {Map<string, object>} */
  const sample = new Map();
  for (const r of rounds) {
    for (const a of r.actions) if (!sample.has(a.key)) sample.set(a.key, a);
  }
  const out = [];
  for (const [key, clusters] of index) {
    const a = sample.get(key);
    if (!a) continue;
    for (const c of clusters) {
      if (c.rounds / rounds.length <= minShare) continue;
      out.push({
        key,
        kind: a.kind,
        label: a.label,
        spot: a.spot,
        type: a.type,
        t: c.t,
        clock: clockAt(c.t),
        spread: Math.round(c.to - c.from),
        share: pct(c.rounds, rounds.length),
        rounds: c.rounds,
        files: c.files
      });
    }
  }
  return out.sort((a, b) => b.share - a.share || a.t - b.t);
}

/**
 * Every timing this player's actions land on, keyed by action.
 *
 * One clustering pass over the whole side, so "his A Lobby at 1:51" and "his A
 * Lobby at 1:33" are two different things everywhere downstream, and two
 * rounds three seconds apart are the same thing.
 *
 * @returns {Map<string, Array<{t: number, from: number, to: number, rounds: number, files: string[]}>>}
 */
export function buildTimeIndex(rounds, tolerance = TIMING_TOLERANCE_SECONDS) {
  /** @type {Map<string, Array<{file: string, t: number}>>} */
  const byKey = new Map();
  for (const r of rounds) {
    /** One hit per key per round: doing it twice is still one habit. */
    const seen = new Set();
    for (const a of r.actions) {
      if (seen.has(a.key)) continue;
      seen.add(a.key);
      if (!byKey.has(a.key)) byKey.set(a.key, []);
      byKey.get(a.key).push({ file: r.file, t: a.t });
    }
  }
  const out = new Map();
  for (const [key, hits] of byKey) out.set(key, clusterTimings(hits, tolerance));
  return out;
}

/** Which of an action's timings this one is, or -1 when the key is unknown. */
function bucketOf(index, key, t, tolerance = TIMING_TOLERANCE_SECONDS) {
  const clusters = index.get(key) || [];
  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < clusters.length; i++) {
    const gap = Math.abs(clusters[i].t - t);
    if (gap < bestGap && (gap <= tolerance || (t >= clusters[i].from && t <= clusters[i].to))) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * One round's opening, as the thing it can be compared by.
 *
 * Each action becomes "what, at which of its timings". Two rounds carrying the
 * same set ran the same call, whichever night they were played on.
 */
export function openingSignature(round, index, tolerance = TIMING_TOLERANCE_SECONDS) {
  const opening = round.actions.filter((a) => a.t <= OPENING_SECONDS);
  const ids = [];
  const seen = new Set();
  for (const a of opening) {
    const id = `${a.key}@${bucketOf(index, a.key, a.t, tolerance)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { opening, ids: ids.sort(), sig: [...ids].sort().join('+') };
}

/**
 * What the five of them throw on one call.
 *
 * Per body, per grenade, per landing: how often it happens across the rounds
 * of this call and when. Read over the whole round rather than the opening,
 * because a call is not finished when the opening is: the molotov that goes
 * down at 1:10 is as much part of an A default as the smoke at 1:38.
 *
 * One round counts once per landing however many times it is thrown into it.
 */
export function callUtility(rounds, minShare = UTIL_MIN_SHARE, cap = UTIL_ROWS_MAX) {
  /** @type {Map<string, { player: string, type: string, spot: string, files: Set<string>, times: number[] }>} */
  const bag = new Map();
  for (const r of rounds) {
    /** @type {Map<string, number[]>} */
    const perRound = new Map();
    for (const n of r.nades || []) {
      const spot = n.name || n.zone || '';
      if (!spot || !n.player) continue;
      const key = `${n.player}|${n.type}|${spot.toLowerCase()}`;
      if (!bag.has(key)) {
        bag.set(key, { player: n.player, type: n.type, spot, files: new Set(), times: [] });
      }
      bag.get(key).files.add(r.file);
      // The earliest of them is the throw the call is timed on.
      const t = ROUND_SECONDS - n.clock;
      if (!Number.isFinite(t)) continue;
      const cur = perRound.get(key);
      if (!cur || t < cur[0]) perRound.set(key, [t]);
    }
    for (const [key, [t]] of perRound) bag.get(key)?.times.push(t);
  }

  const rows = [...bag.values()]
    .map((rec) => ({
      player: rec.player,
      type: rec.type,
      spot: rec.spot,
      label: `${NADE_WORD[rec.type] || 'Nade'} ${rec.spot}`,
      share: pct(rec.files.size, rounds.length),
      rounds: rec.files.size,
      clock: clockAt(median(rec.times)),
      files: [...rec.files]
    }))
    .filter((row) => row.share >= minShare)
    .sort((a, b) => b.share - a.share || a.clock.localeCompare(b.clock));
  return { rows: rows.slice(0, cap), hidden: Math.max(0, rows.length - cap) };
}

/** Where the team's round ended up, over a set of rounds. */
function siteSplit(rounds) {
  let a = 0;
  let b = 0;
  for (const r of rounds) {
    if (r.hitSite === 'a') a++;
    else if (r.hitSite === 'b') b++;
  }
  const basis = a + b;
  if (!basis) return null;
  return { a: pct(a, basis), b: pct(b, basis), basis };
}

/**
 * Openings that recur, as the CORE of a round rather than the whole of it.
 *
 * A default is "goes A, smokes Jungle at 1:38, and then the round happens". The
 * ground he happens to cross on the way is not part of it, so matching the
 * whole opening as one signature splits a default the player runs every game
 * into a dozen groups of one. What recurs is a SUBSET, and that is what this
 * looks for: every combination of up to MAX_CORE actions that appears in more
 * than `minShare` of his rounds.
 *
 * Only maximal ones survive. If "A Lobby" always comes with "Jungle smoke",
 * the pair is the default and the single is not a separate one; a round with
 * the A Lobby half and not the smoke is him doing something else, which is
 * exactly what the variations are for.
 *
 * @param {Array<Set<string>>} roundIds  opening signature ids per round
 * @param {number} minCount
 */
export function frequentCores(roundIds, minCount, maxSize = MAX_CORE) {
  const supportOf = (set) => {
    let n = 0;
    for (const ids of roundIds) {
      if (set.every((id) => ids.has(id))) n++;
    }
    return n;
  };

  const counts = new Map();
  for (const ids of roundIds) {
    for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  }
  let level = [...counts.entries()]
    .filter(([, n]) => n >= minCount)
    .map(([id]) => [id])
    .sort();
  const kept = level.map((set) => ({ set, support: counts.get(set[0]) }));

  for (let size = 2; size <= maxSize && level.length > 1; size++) {
    /** @type {Map<string, string[]>} */
    const candidates = new Map();
    for (let i = 0; i < level.length; i++) {
      for (let j = i + 1; j < level.length; j++) {
        const union = [...new Set([...level[i], ...level[j]])].sort();
        if (union.length !== size) continue;
        candidates.set(union.join('+'), union);
      }
    }
    const next = [];
    for (const set of candidates.values()) {
      const support = supportOf(set);
      if (support < minCount) continue;
      next.push(set);
      kept.push({ set, support });
    }
    level = next;
  }

  // Maximal only: a core that is contained in a bigger core is that bigger
  // core seen from underneath, not a second default.
  return kept
    .filter(
      (a) => !kept.some((b) => b !== a && a.set.length < b.set.length && a.set.every((id) => b.set.includes(id)))
    )
    .sort((a, b) => b.set.length - a.set.length || b.support - a.support);
}

/**
 * Group his rounds by the opening they run.
 *
 * Every round goes to the fullest core it contains, so a round running the A
 * default lands under the A default even on the night he took an odd corner on
 * the way. A round containing no core at all is a variation, and those are
 * grouped by their whole opening: they are the rounds where he did something
 * else, and what that something was is the point.
 *
 * A round with nothing readable in its opening (no ticks, or ground the map has
 * no names painted on) is in neither list: it is reported as unread rather than
 * counted as a default he did not actually run.
 */
export function groupOpenings(rounds, index, minShare = RECURRING_MIN_SHARE) {
  const readable = [];
  const unread = [];
  for (const r of rounds) {
    const { opening, ids, sig } = openingSignature(r, index);
    if (!opening.length) unread.push(r);
    else readable.push({ ...r, opening, ids: new Set(ids), sig });
  }
  const basis = readable.length;
  const minCount = Math.floor(basis * minShare) + 1;
  const cores = basis ? frequentCores(readable.map((r) => r.ids), minCount) : [];

  // A default's rounds are every round that RUNS it, not only the ones where it
  // is the fullest match. Two of his defaults can share a round, and both are
  // things he does; splitting the round between them would report an opening he
  // runs in a third of his rounds as one he runs in a tenth.
  const defaults = cores.map((c) =>
    buildGroup(
      {
        key: `core:${c.set.join('+')}`,
        core: c.set,
        rounds: readable.filter((r) => c.set.every((id) => r.ids.has(id)))
      },
      basis
    )
  );

  // A variation is a round that runs none of them, and those group by their
  // whole opening: what he did instead is the point of the section.
  /** @type {Map<string, { key: string, core: null, rounds: object[] }>} */
  const groups = new Map();
  for (const r of readable) {
    if (cores.some((c) => c.set.every((id) => r.ids.has(id)))) continue;
    const key = `var:${r.sig}`;
    if (!groups.has(key)) groups.set(key, { key, core: null, rounds: [] });
    groups.get(key).rounds.push(r);
  }
  const variations = [...groups.values()].map((g) => buildGroup(g, basis));

  const covered = new Set(defaults.flatMap((g) => g.files));
  const bySize = (a, b) => b.count - a.count || b.winrate - a.winrate;
  defaults.sort(bySize);
  variations.sort(bySize);
  return {
    basis,
    unread,
    // Rounds running at least one default, counted once however many they run.
    defaultRounds: covered.size,
    defaultWins: readable.filter((r) => covered.has(r.file) && r.won).length,
    defaults,
    variations
  };
}

/**
 * One group's numbers and the round it is written from.
 *
 * A default is described by its core, because the core is the part every round
 * in the group shares. A variation is described by its whole opening, because
 * every round in it ran the same one.
 */
function buildGroup(g, basis) {
  /** Per action, when it happens inside this group. */
  const centre = new Map();
  const sample = new Map();
  for (const r of g.rounds) {
    for (const a of r.opening) {
      if (!centre.has(a.key)) centre.set(a.key, []);
      centre.get(a.key).push(a.t);
      if (!sample.has(a.key)) sample.set(a.key, a);
    }
  }
  const inCore = (key) => !g.core || g.core.some((id) => id.slice(0, id.lastIndexOf('@')) === key);
  const actions = [...sample.keys()]
    .filter(inCore)
    .map((key) => {
      const a = sample.get(key);
      const t = median(centre.get(key) || []);
      return { key, label: a.label, kind: a.kind, spot: a.spot, type: a.type, t, clock: clockAt(t) };
    })
    .sort((a, b) => a.t - b.t);

  // The round that runs it most typically, so the strategy written from it is
  // the call and not one odd night.
  const score = (r) => {
    let s = 0;
    for (const a of r.opening) {
      if (!inCore(a.key)) continue;
      const c = median(centre.get(a.key) || []);
      s += Math.abs(a.t - (c ?? a.t));
    }
    return s + r.opening.length / 100;
  };
  const example = [...g.rounds].sort(
    (a, b) => score(a) - score(b) || (b.won ? 1 : 0) - (a.won ? 1 : 0)
  )[0];

  const wins = g.rounds.filter((r) => r.won).length;
  return {
    sig: g.key,
    isDefault: Boolean(g.core),
    actions,
    label: actions
      .slice(0, LABEL_ACTIONS)
      .map((a) => `${a.label} ${a.clock}`)
      .join(', '),
    site: siteSplit(g.rounds),
    count: g.rounds.length,
    share: pct(g.rounds.length, basis),
    wins,
    winrate: pct(wins, g.rounds.length),
    files: g.rounds.map((r) => r.file),
    opponents: [...new Set(g.rounds.map((r) => r.opponent).filter(Boolean))],
    example: example?.file || '',
    exampleWon: Boolean(example?.won),
    // What all five throw on this call, across every round of it rather than
    // the one it is written from.
    utility: callUtility(g.rounds),
    // Every round-library call the team was tagged with in these rounds: his
    // opening seen from the team's end.
    teamCalls: teamCallCounts(g.rounds)
  };
}

/**
 * A default named the way a coach names it.
 *
 * "A default" when the rounds he opens this way go A, "B default" when they go
 * B, and nothing when they split evenly: a name that is wrong two times in five
 * is worse than no name.
 */
export function defaultName(group) {
  const site = group.site;
  if (!site || site.basis < 3) return '';
  if (site.a >= SITE_NAME_MIN_SHARE) return 'A default';
  if (site.b >= SITE_NAME_MIN_SHARE) return 'B default';
  return '';
}

/** Round-library call keys the team carried across a set of rounds. */
function teamCallCounts(rounds) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const r of rounds) {
    for (const tag of r.tags?.[r.side] || []) {
      if (!tag.k || tag.k === 'default') continue;
      counts.set(tag.k, (counts.get(tag.k) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Heatmaps and grenade paths
// ---------------------------------------------------------------------------

function playerMaps(rounds, playerId) {
  const heat = [];
  const paths = [];
  for (const r of rounds) {
    for (const s of r.series || []) {
      const p = (s.pts || []).find((x) => x.id === playerId);
      if (!p) continue;
      // Spawn noise is not a position. Everything from 7s on is.
      if (s.elapsed < 7) continue;
      heat.push({ x: p.x, y: p.y, t: s.elapsed, own: r.ownEcon, opp: r.oppEcon });
    }
    for (const n of r.nades || []) {
      if (n.player !== playerId) continue;
      if (paths.length >= NADE_PATH_CAP * 7) break;
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.at)) continue;
      paths.push(
        NADE_KINDS.indexOf(n.type),
        Math.round(Number.isFinite(n.fx) ? n.fx : n.x),
        Math.round(Number.isFinite(n.fy) ? n.fy : n.y),
        Math.round(n.x),
        Math.round(n.y),
        Math.round(n.at),
        r.ownEcon * 8 + r.oppEcon
      );
    }
  }
  return { heat: packPoints(heat, HEAT_POINT_CAP), paths };
}

// ---------------------------------------------------------------------------
// One side
// ---------------------------------------------------------------------------

function sideBlock({ rounds, playerId, side }) {
  const mine = rounds.filter((r) => r.side === side);
  if (!mine.length) return null;
  const full = mine.filter((r) => r.hasTicks && r.ownEcon === 4 && r.oppEcon === 4);

  const withActions = full.map((r) => ({
    file: r.file,
    won: r.won,
    opponent: r.opponent,
    side: r.side,
    hitSite: r.hitSite,
    tags: r.tags,
    // Every grenade the five of them threw, so a call can say what the other
    // four throw on it and not only what he does.
    nades: r.nades,
    actions: playerActions(r, playerId)
  }));

  const index = buildTimeIndex(withActions);
  const recurring = recurringActions(withActions, index);
  const { basis, unread, defaults, variations, defaultRounds, defaultWins } = groupOpenings(
    withActions,
    index
  );
  const { heat, paths } = playerMaps(mine, playerId);

  const named = defaults.slice(0, MAX_DEFAULTS).map((g) => ({ ...g, name: defaultName(g) }));
  const shownVariations = variations.slice(0, MAX_VARIATIONS);
  const restVariations = variations.slice(MAX_VARIATIONS);
  const sum = (list, pick) => list.reduce((n, g) => n + pick(g), 0);
  const variationRounds = sum(variations, (g) => g.count);

  const wins = mine.filter((r) => r.won).length;
  return {
    side,
    rounds: mine.length,
    files: mine.map((r) => r.file),
    wins,
    winrate: pct(wins, mine.length),
    fullRounds: full.length,
    basis,
    unread: unread.length,
    utility: recurring.filter((c) => c.kind === 'nade'),
    moves: recurring.filter((c) => c.kind === 'go'),
    defaults: {
      count: defaultRounds,
      share: pct(defaultRounds, basis),
      winrate: pct(defaultWins, defaultRounds),
      // Deduped: a round running two of his defaults is one round.
      files: [...new Set(defaults.flatMap((g) => g.files))],
      patterns: named,
      // A fifth default is vanishingly rare, but it is counted rather than
      // quietly dropped when it happens.
      hidden: defaults.length - named.length
    },
    nonDefaults: {
      count: variationRounds,
      share: pct(variationRounds, basis),
      winrate: pct(sum(variations, (g) => g.wins), variationRounds),
      files: variations.flatMap((g) => g.files)
    },
    variations: shownVariations,
    // The tail is listed rather than written out: every one of them still gets
    // its shape, its count, its winrate and its rounds.
    moreVariations: restVariations.map((g) => ({
      label: g.label,
      count: g.count,
      share: g.share,
      winrate: g.winrate,
      files: g.files,
      site: g.site
    })),
    heat,
    paths
  };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.payload    the pattern finder stats payload
 * @param {string} args.playerId
 * @param {string} args.mapCode
 * @param {string[]} args.demoIds  included matches
 * @param {(done: number, total: number) => void} [args.onProgress]
 */
export async function runPlayerScan({ payload, playerId, mapCode, demoIds, onProgress }) {
  const wanted = new Set(demoIds);
  const jobs = [];
  const includedDemos = [];
  /** Team short ids he played under, for analyzer deep links. */
  const focusIds = new Set();
  let playerName = '';
  const teamNames = new Map();

  for (const demo of payload?.demos || []) {
    if (!wanted.has(demo.id)) continue;
    const seat = (demo.players || []).find((p) => p.id === playerId);
    const teamIdx = seat?.team === 1 ? 1 : seat?.team === 2 ? 2 : 0;
    if (!teamIdx) continue;
    if (seat?.name) playerName = seat.name;
    includedDemos.push({ demo, teamIdx });
    const shortId = teamIdx === 1 ? demo.t1 : demo.t2;
    if (shortId) focusIds.add(shortId);
    const own = (teamIdx === 1 ? demo.name1 : demo.name2) || '';
    if (own) teamNames.set(own, (teamNames.get(own) || 0) + 1);
    const opponent = (teamIdx === 1 ? demo.name2 : demo.name1) || 'Unknown';

    let pistolAt = 0;
    let ourHalf = 0;
    let theirHalf = 0;
    const ordered = [...(demo.rounds || [])].sort((a, b) => (a.n || 0) - (b.n || 0));
    for (const row of ordered) {
      if (buyBucket(row.e1) === 0 && buyBucket(row.e2) === 0) {
        pistolAt = row.n;
        ourHalf = 0;
        theirHalf = 0;
      }
      const context = {
        inHalf: pistolAt ? row.n - pistolAt + 1 : 0,
        ourHalf,
        theirHalf
      };
      if (row.m === mapCode && row.f) jobs.push({ row, teamIdx, opponent, context });
      if (row.w === teamIdx) ourHalf++;
      else if (row.w) theirHalf++;
    }
  }
  if (!jobs.length) throw new Error('No rounds of that player on this map.');

  const { rounds, network } = await extractRounds({ jobs, mapCode, onProgress });
  if (!rounds.length) throw new Error('None of the selected rounds could be read.');

  // Names and roles for everyone who played beside him, so the strategies and
  // the utility tables can say "the AWPer" rather than a steam id.
  //
  // The role is the majority across the included demos, exactly as the Roles &
  // Positions editor resolves it. Taking the first one seen instead would let
  // the same player be a Mid in one table and a B Rotation in the next.
  /** @type {Map<string, Map<string, Map<string, number>>>} id -> side -> label -> votes */
  const roleVotes = new Map();
  /** @type {Record<string, { name: string, T: string, CT: string }>} */
  const mates = {};
  for (const { demo, teamIdx } of includedDemos) {
    for (const p of demo.players || []) {
      if (p.team !== teamIdx || !p.id) continue;
      const cur = mates[p.id] || { name: p.name || p.id, T: '', CT: '' };
      if (p.name) cur.name = p.name;
      mates[p.id] = cur;
      if (!roleVotes.has(p.id)) roleVotes.set(p.id, new Map([['T', new Map()], ['CT', new Map()]]));
      for (const side of ['T', 'CT']) {
        const role = roleForPlayer(demo.roles, mapCode, side, p.id);
        const label = typeof role === 'string' ? role : role?.label || role?.position || '';
        if (!label) continue;
        const bag = roleVotes.get(p.id).get(side);
        bag.set(label, (bag.get(label) || 0) + 1);
      }
    }
  }
  for (const [id, sides] of roleVotes) {
    for (const side of ['T', 'CT']) {
      mates[id][side] = [...sides.get(side).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    }
  }

  const teamName = [...teamNames.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  return {
    mapCode,
    playerId,
    playerName: playerName || playerId,
    teamName,
    rounds: rounds.length,
    ticked: rounds.filter((r) => r.hasTicks).length,
    zonesReady: Boolean(network?.positions?.length),
    focusIds: [...focusIds],
    // The header reads his role off the same table every other line does.
    roles: { T: mates[playerId]?.T || '', CT: mates[playerId]?.CT || '' },
    mates,
    tFullBuy: rounds.filter((r) => r.side === 'T' && r.ownEcon === 4).map((r) => r.file),
    ctFullBuy: rounds.filter((r) => r.side === 'CT' && r.ownEcon === 4).map((r) => r.file),
    sides: {
      T: sideBlock({ rounds, playerId, side: 'T' }),
      CT: sideBlock({ rounds, playerId, side: 'CT' })
    }
  };
}

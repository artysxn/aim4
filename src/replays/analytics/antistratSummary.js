// ---------------------------------------------------------------------------
// replays/analytics/antistratSummary.js
// Teams antistrat, summary mode: the prep sheet a coach writes by hand.
//
// The detailed report (antistratConfig.js) prints every number the scan has.
// This one keeps the handful a player needs before the match and says them
// the way a coach would: "Top Con flash: Always B (6 of 6)", rounds as their
// handful of variations ("4x Quick 4 mid fight into full freeze"), and a short
// paragraph per player. Notes are written in green, negative findings in red,
// which is how those sheets are written.
//
// It is printed, so nothing links anywhere, and it makes no calls of its own:
// it says what the team does and how often, and the analyst writes the plan.
//
// Same scan, same rounds (antistratScan.js `extract`), so every number here is
// one the detailed report also has. Only the selection and the words differ,
// and the words come from reportMessages.js, never from a model.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { phaseAtTick } from '../coach/roundPhases.js';
import { positionsAtPoint } from '../zones/pointInZone.js';
import { FORMATIONS, formatFormation, paceType } from './patternDefs.js';
import {
  BUY_CONTEXTS,
  TELL_MIN_ROUNDS,
  classifyPace,
  laneCountsAt,
  nadeLabel,
  paceSite,
  snapshotSample,
  typeLabels
} from './antistratScan.js';
import { demoTimestamp, tagTrigger } from '../shared/statsMath.js';
import {
  buildTimeIndex,
  playerActions,
  recurringActions
} from './playerScoutScan.js';
import { say } from './reportMessages.js';
import {
  capitalize,
  clockText,
  countWord,
  frequencyWord,
  joinList,
  nadeName,
  nadePlural,
  NADE_SLANG,
  noun,
  paragraph,
  percent,
  plural,
  sentence,
  withArticle
} from './reportProse.js';

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** @type {Array<{ key: string, group: string, label: string }>} */
export const SUMMARY_CATEGORIES = [
  { key: 'sideT', group: 'Sides', label: 'T side' },
  { key: 'sideCT', group: 'Sides', label: 'CT side' },
  { key: 'positions', group: 'Sections', label: 'Positions' },
  { key: 'pace', group: 'Sections', label: 'Pace and setups' },
  { key: 'tells', group: 'Sections', label: 'Tells' },
  { key: 'danger', group: 'Sections', label: 'Dangerous rounds and openings' },
  { key: 'force', group: 'Sections', label: 'Force buys' },
  { key: 'antiforce', group: 'Sections', label: 'Anti-ecos and antiforces' },
  { key: 'sites', group: 'Sections', label: 'Site rounds and retakes' },
  { key: 'pistols', group: 'Sections', label: 'Pistols' },
  { key: 'players', group: 'Sections', label: 'Players' }
];

export const SUMMARY_GROUPS = ['Sides', 'Sections'];

/** The analyst's notes. Reads on the dark page and on paper. */
export const NOTE_COLOR = '#6aa84f';
/** "No tells for first buy": a finding that something is missing. */
export const NEGATIVE_COLOR = '#e06666';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const FAST = ['rush', 'pop', 'contact'];
const PACE_WORD = {
  rush: 'rush',
  pop: 'pop',
  contact: 'contact',
  'full-exec': 'full exec',
  default: 'default',
  'slow-default': 'slow default',
  other: 'other'
};
const SIDE_OF = { T: 'T', CT: 'CT' };
/** Teammates within this of each other are together; past it a player is alone. */
const ALONE_UNITS = 600;
/** An opening this early on the clock (seconds left, 1:30) is an aggressive one. */
const AGGRESSIVE_CLOCK = 90;
/** The midround read for AWP spots and holds: 1:20 on the clock. */
const MIDROUND_ELAPSED = 35;

const median = (list) => {
  const s = list.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function bump(map, key, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}

function top(map) {
  let best = null;
  for (const [k, v] of map) if (!best || v > best[1]) best = [k, v];
  return best;
}

/** Words of a call label in the case a sentence wants: "B Split" -> "B split". */
export function callWords(label) {
  return String(label || '')
    .trim()
    .split(/\s+/)
    .map((w) => (/^[A-Z][A-Z0-9]{0,3}$/.test(w) || /^\d/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

/**
 * A call as a tell's answer: "All B hits" -> "B", "Mid take" -> "mid",
 * "A Pop" -> "A pop". The sheet says where the round goes, not what the
 * library calls it.
 */
export function shortCall(label) {
  const s = String(label || '').trim();
  let m = /^all ([ab]) hits$/i.exec(s);
  if (m) return m[1].toUpperCase();
  m = /^(.+?) take$/i.exec(s);
  if (m) return callWords(m[1]);
  if (/^default/i.test(s)) return 'default';
  return callWords(s);
}

/** "All B hits" -> "B hit", "B Split" -> "B split": a call inside a sentence. */
function callName(label) {
  const s = String(label || '').trim();
  const m = /^all ([ab]) hits$/i.exec(s);
  if (m) return `${m[1].toUpperCase()} hit`;
  return callWords(s);
}

/**
 * The lane a sheet would name: a site lane by its letter ("Con / A" -> "A",
 * "B / UG" -> "B"), anything else by its name ("Mid" -> "mid", "Long" -> "long").
 */
function laneWord(lane) {
  const short = String(lane?.short || '').trim();
  if (/^[AB]$/i.test(short)) return short.toUpperCase();
  const first = String(lane?.label || short).split('/')[0].trim();
  return /^[A-Z]$/.test(first) ? first : first.toLowerCase();
}

function zoneAt(x, y, network) {
  if (!network || !Number.isFinite(x) || !Number.isFinite(y)) return '';
  return positionsAtPoint(x, y, network).map((z) => z.name)[0] || '';
}

/** Which lane (notation index) a named position belongs to, or -1. */
function laneOfPos(pos, laneSets) {
  if (!laneSets || !pos) return -1;
  const key = String(pos).toLowerCase();
  return laneSets.findIndex((s) => s.has(key));
}

function siteLetter(site) {
  return site ? String(site).toUpperCase() : '';
}

/** Specific (named, not "default", not "All X hits") tags a side carried. */
function specificTags(r, side) {
  return (r.tags?.[side] || []).filter(
    (t) => t.k && t.k !== 'default' && !/^all-[ab]-hits$/.test(t.k) && !/afterplant|retake/.test(t.k)
  );
}

function namedTags(r, side) {
  return (r.tags?.[side] || []).filter((t) => t.k && t.k !== 'default');
}

/** Seconds since the round went live at which a grenade left the hand. */
const throwElapsed = (n) => (Number.isFinite(n.clock) ? ROUND_SECONDS - n.clock : n.at);

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

function positionsFor(ctx, side) {
  return ctx.mains.map((m) => ({ id: m.id, name: m.name, role: ctx.rolesOf(m.id, side) || '' }));
}

// ---------------------------------------------------------------------------
// Pace (T) and setups (CT)
// ---------------------------------------------------------------------------

/**
 * T pace rows with the notes a coach writes beside them.
 *
 * The notes follow one thread down the fast paces: the site they never go to
 * early. "They never rush A", then "Only 1 round early A", then "Still never
 * early A" once the same gap shows a second time.
 */
function paceFor(ctx) {
  const buys = ctx.rounds.filter((r) => r.side === 'T' && r.ownEcon >= 2 && r.hasTicks);
  const keys = ['rush', 'pop', 'contact', 'full-exec', 'default', 'slow-default', 'other'];
  const byPace = new Map(keys.map((k) => [k, []]));
  for (const r of buys) {
    const p = classifyPace(r) || 'other';
    (byPace.get(p) || byPace.get('other')).push(r);
  }
  const rows = keys.map((key) => {
    const list = byPace.get(key) || [];
    let a = 0;
    let b = 0;
    for (const r of list) {
      const s = paceSite(r);
      if (s === 'a') a++;
      else if (s === 'b') b++;
    }
    return {
      pace: key,
      label: paceType(key)?.label || 'Other',
      count: list.length,
      share: percent(list.length, buys.length),
      siteA: a,
      siteB: b,
      files: list.map((r) => r.file),
      note: ''
    };
  });

  const never = new Set();
  for (const row of rows) {
    const seed = `${ctx.seed}|pace|${row.pace}`;
    if (FAST.includes(row.pace) && row.count > 0) {
      const total = row.siteA + row.siteB;
      if (total < 2) continue;
      const minority = row.siteA <= row.siteB ? 'A' : 'B';
      const n = Math.min(row.siteA, row.siteB);
      if (n === 0) {
        row.note = say(never.has(minority) ? 'pace-never-again' : 'pace-never', seed, {
          verb: row.pace === 'rush' ? 'rush' : 'go early',
          site: minority
        });
        never.add(minority);
      } else if (n === 1) {
        row.note = say('pace-once', seed, { site: minority });
      } else if (percent(n, total) <= 25) {
        row.note = say('pace-rare', seed, { site: minority, n, total });
      }
    }
    if (row.pace === 'full-exec' && row.count >= 2) {
      const total = row.siteA + row.siteB;
      const lead = row.siteA >= row.siteB ? 'A' : 'B';
      const n = Math.max(row.siteA, row.siteB);
      const freq = frequencyWord(n, total);
      if (total >= 2 && freq) row.note = say('pace-exec-site', seed, { freq, site: lead });
    }
  }
  // Defaults are only worth a note when they are rare: under 40% of buys.
  const def = rows.find((r) => r.pace === 'default');
  const slow = rows.find((r) => r.pace === 'slow-default');
  const defaults = percent((def?.count || 0) + (slow?.count || 0), buys.length);
  if (slow && buys.length && defaults < 40) {
    slow.note = say('pace-defaults', `${ctx.seed}|defaults`, { share: defaults });
  }
  return { basis: buys.length, rows };
}

/**
 * CT setups: how many stand on A, on B and in between at the formation clock,
 * over the full buys. Five toward one site is written as the stack it is.
 */
function setupsFor(ctx) {
  const order = (FORMATIONS[ctx.mapCode]?.ct || []).map((c) => c.label);
  if (!order.length) return null;
  const set = ctx.rounds.filter((r) => r.side === 'CT' && r.ownEcon >= 4 && r.hasTicks);
  const byForm = new Map();
  for (const r of set) {
    const snap = snapshotSample(r, ctx.mapCode);
    if (!snap || !snap.pts.length) continue;
    const a = r.towardCount(snap, 'a', 0);
    const b = r.towardCount(snap, 'b', 0);
    const ee = Math.max(0, snap.pts.length - a - b);
    const form = order.map((slot) => (slot === 'A' ? a : slot === 'B' ? b : ee)).join('-');
    if (!byForm.has(form)) byForm.set(form, { rounds: [], a, b });
    byForm.get(form).rounds.push(r);
  }
  const basis = [...byForm.values()].reduce((n, g) => n + g.rounds.length, 0);
  const rows = [...byForm.entries()]
    .map(([form, g]) => {
      const wins = g.rounds.filter((r) => r.won).length;
      let note = '';
      if (g.a >= 3) note = `Stack A`;
      else if (g.b >= 3) note = `Stack B`;
      return {
        label: form,
        count: g.rounds.length,
        share: percent(g.rounds.length, basis),
        winrate: percent(wins, g.rounds.length),
        files: g.rounds.map((r) => r.file),
        note
      };
    })
    .sort((x, y) => y.count - x.count)
    .slice(0, 6);

  // The calls the round library names on CT, as a share of every CT round.
  const labels = typeLabels(ctx.mapCode, 'CT');
  const all = ctx.rounds.filter((r) => r.side === 'CT');
  const calls = new Map();
  for (const r of all) {
    for (const t of specificTags(r, 'CT')) {
      if (!calls.has(t.k)) calls.set(t.k, { rounds: [], times: [] });
      const c = calls.get(t.k);
      c.rounds.push(r);
      const at = tagTrigger(t);
      if (at !== null) c.times.push(at);
    }
  }
  const callRows = [...calls.entries()]
    .map(([key, c]) => ({
      label: labels.get(key) || key,
      count: c.rounds.length,
      share: percent(c.rounds.length, all.length),
      winrate: percent(c.rounds.filter((r) => r.won).length, c.rounds.length),
      clock: c.times.length ? clockText(ROUND_SECONDS - median(c.times)) : '',
      files: c.rounds.map((r) => r.file)
    }))
    .filter((c) => c.count >= 2)
    .sort((x, y) => y.count - x.count)
    .slice(0, 6);
  return { basis, order, rows, calls: callRows };
}

// ---------------------------------------------------------------------------
// Tells
// ---------------------------------------------------------------------------

/**
 * What one round "went", in the words a tell answers with: the round-library
 * calls it carried (the specific ones flagged ahead of "All B hits") and, on
 * T, the site it committed to.
 */
function roundOutcomes(r, side, labels) {
  const out = new Map();
  // On CT only the calls they chose count: "All B hits" on a CT round is the
  // other team's decision, and a flash thrown because of it says nothing.
  const tags = side === 'CT' ? specificTags(r, side) : namedTags(r, side);
  for (const t of tags) {
    const word = shortCall(labels.get(t.k) || t.k);
    if (!word || word === 'default' || /afterplant|retake/.test(t.k)) continue;
    const prev = out.get(word);
    out.set(word, { word, specific: Boolean(prev?.specific) || !/^all-[ab]-hits$/.test(t.k) });
  }
  if (side === 'T') {
    const site = paceSite(r);
    if (site && !out.has(site.toUpperCase())) {
      out.set(site.toUpperCase(), { word: site.toUpperCase(), specific: false });
    }
  }
  return out;
}

/** Points a tell's answer has to beat its own base rate by to say anything. */
const TELL_MIN_LIFT = 25;
const TELLS_PER_OUTCOME = 2;
/**
 * A tell is utility the other team SEES with time to act on it: landed at
 * least this many seconds before the round starts happening. A molotov on a
 * position five seconds after they walked out onto the site says nothing a
 * defender did not already know.
 */
const TELL_LEAD = 5;

/**
 * Seconds since the round went live at which it starts happening: the first
 * kill, two players on a site, or the plant, whichever comes first.
 */
function actionElapsed(r) {
  const times = [];
  if (Number.isFinite(r.firstKill?.clock)) times.push(ROUND_SECONDS - r.firstKill.clock);
  const entry = r.siteEntry?.(2);
  if (entry) times.push(ROUND_SECONDS - entry.clock);
  if (Number.isFinite(r.plantClock)) times.push(ROUND_SECONDS - r.plantClock);
  return times.length ? Math.min(...times) : null;
}

/** Named utility that was up early enough to read the round from. */
function earlyUtility(r) {
  const act = actionElapsed(r);
  return r.nades.filter((n) => nadeLabel(n) && (act === null || n.at <= act - TELL_LEAD));
}

/** Per round, the utility keys it showed early: file -> Set(key). */
function earlyKeys(set) {
  const out = new Map();
  for (const r of set) {
    const keys = new Set();
    for (const n of earlyUtility(r)) keys.add(`${nadeLabel(n)}\0${n.type}`);
    out.set(r.file, keys);
  }
  return out;
}

/**
 * Utility that gives the round away, read as "where does it go".
 *
 * Every grenade seen early enough in enough rounds, by name, with the answer
 * most of its rounds share. Ranked by how reliable the read is, and capped per
 * answer so the list covers B, A and mid rather than five ways of saying B.
 *
 * @param {object[]} set   rounds to read (one side)
 * @param {'T'|'CT'} side
 * @param {object} ctx
 * @param {{ minRounds?: number, minShare?: number, limit?: number }} [opts]
 */
export function tellsOver(set, side, ctx, { minRounds = TELL_MIN_ROUNDS, minShare = 80, limit = 5 } = {}) {
  const labels = typeLabels(ctx.mapCode, side);
  const outcomesOf = new Map(set.map((r) => [r.file, roundOutcomes(r, side, labels)]));
  /** name\0type -> { name, type, rounds: Map(file -> outcomes) } */
  const byKey = new Map();
  for (const r of set) {
    for (const n of earlyUtility(r)) {
      const label = nadeLabel(n);
      const key = `${label}\0${n.type}`;
      if (!byKey.has(key)) byKey.set(key, { name: label, type: n.type, rounds: new Map() });
      byKey.get(key).rounds.set(r.file, outcomesOf.get(r.file));
    }
  }
  // How often each answer happens anyway. A grenade thrown in every round of
  // a call that happens in 80% of rounds is that team's default, not a read.
  const base = new Map();
  for (const o of outcomesOf.values()) for (const x of o.values()) bump(base, x.word);
  const candidates = [];
  for (const rec of byKey.values()) {
    const n = rec.rounds.size;
    if (n < minRounds) continue;
    const tally = new Map();
    for (const [file, outcomes] of rec.rounds) {
      for (const o of outcomes.values()) {
        if (!tally.has(o.word)) tally.set(o.word, { hits: 0, files: [], specific: o.specific });
        const bag = tally.get(o.word);
        bag.hits++;
        bag.files.push(file);
        bag.specific = bag.specific || o.specific;
      }
    }
    const best = [...tally.entries()].sort(
      (a, b) => b[1].hits - a[1].hits || Number(b[1].specific) - Number(a[1].specific)
    )[0];
    if (!best) continue;
    const share = percent(best[1].hits, n);
    if (share < minShare) continue;
    if (share - percent(base.get(best[0]) || 0, set.length) < TELL_MIN_LIFT) continue;
    candidates.push({
      utility: nadeName(rec.name, rec.type),
      name: rec.name,
      type: rec.type,
      outcome: best[0],
      hits: best[1].hits,
      rounds: n,
      share,
      freq: frequencyWord(best[1].hits, n, minShare),
      files: [...rec.rounds.keys()],
      hitFiles: best[1].files
    });
  }
  candidates.sort((a, b) => b.share - a.share || b.rounds - a.rounds || a.utility.localeCompare(b.utility));
  const perOutcome = new Map();
  const out = [];
  for (const t of candidates) {
    const used = perOutcome.get(t.outcome) || 0;
    if (used >= TELLS_PER_OUTCOME) continue;
    perOutcome.set(t.outcome, used + 1);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The other half of a tell: utility they throw in most rounds, and where the
 * rounds WITHOUT it go. A window smoke in 70% of rounds is nothing; the 30%
 * that skip it going A eight times in ten is.
 */
function absenceTellsOver(set, side, ctx, { limit = 3 } = {}) {
  if (set.length < 8) return [];
  const labels = typeLabels(ctx.mapCode, side);
  const outcomesOf = new Map(set.map((r) => [r.file, roundOutcomes(r, side, labels)]));
  const keysOf = earlyKeys(set);
  const base = new Map();
  for (const o of outcomesOf.values()) for (const x of o.values()) bump(base, x.word);
  const usage = new Map();
  for (const keys of keysOf.values()) for (const k of keys) bump(usage, k);
  const out = [];
  for (const [key, used] of usage) {
    const usual = percent(used, set.length);
    if (usual < 50 || usual > 92) continue;
    const without = set.filter((r) => !keysOf.get(r.file).has(key));
    if (without.length < 4) continue;
    const tally = new Map();
    for (const r of without) for (const o of outcomesOf.get(r.file).values()) bump(tally, o.word);
    const best = top(tally);
    if (!best) continue;
    const share = percent(best[1], without.length);
    if (share < 75) continue;
    if (share - percent(base.get(best[0]) || 0, set.length) < TELL_MIN_LIFT) continue;
    const [name, type] = key.split('\0');
    out.push({
      utility: nadeName(name, type),
      usual,
      outcome: best[0],
      hits: best[1],
      rounds: without.length,
      share,
      freq: frequencyWord(best[1], without.length, 75)
    });
  }
  out.sort((a, b) => b.share - a.share || b.rounds - a.rounds);
  const seen = new Set();
  return out.filter((t) => (seen.has(t.outcome) ? false : seen.add(t.outcome))).slice(0, limit);
}

function tellsFor(ctx, side) {
  const set = ctx.rounds.filter((r) => r.side === side && r.ownEcon >= 2);
  const tells = tellsOver(set, side, ctx);
  const absent = absenceTellsOver(set, side, ctx);
  const first = set.filter((r) => BUY_CONTEXTS[0].test(r));
  let firstBuy = null;
  if (first.length >= 2) {
    const found = tellsOver(first, side, ctx, { minRounds: 3, minShare: 100, limit: 2 });
    firstBuy = { rounds: first.length, tells: found };
  }
  return { tells, absent, firstBuy };
}

// ---------------------------------------------------------------------------
// Rounds, grouped into variations
// ---------------------------------------------------------------------------

/**
 * The moment a round commits, in seconds since it went live: two players on a
 * site, the plant, or failing both the first kill. Utility thrown around it is
 * the call's utility; utility from the other end of the round is not.
 */
function commitElapsed(r) {
  const entry = r.siteEntry(2);
  if (entry) return ROUND_SECONDS - entry.clock;
  if (Number.isFinite(r.plantClock)) return ROUND_SECONDS - r.plantClock;
  if (Number.isFinite(r.firstKill?.clock)) return ROUND_SECONDS - r.firstKill.clock;
  return null;
}

/** Seconds before the commit that still count as the call's utility. */
const CALL_UTILITY_LEAD = 25;

/**
 * Named utility thrown in at least half of a group's rounds, in throw order.
 * Only what went in around the call: from CALL_UTILITY_LEAD seconds before it
 * commits to a few seconds after.
 */
function groupUtility(list, share = 0.5) {
  const bag = new Map();
  for (const r of list) {
    const seen = new Set();
    const commit = commitElapsed(r);
    for (const n of r.nades) {
      const label = nadeLabel(n);
      if (!label) continue;
      const t = throwElapsed(n);
      if (commit !== null && (t < commit - CALL_UTILITY_LEAD || t > commit + 5)) continue;
      const key = `${label}|${n.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!bag.has(key)) bag.set(key, { label, type: n.type, rounds: 0, times: [], lands: [] });
      const rec = bag.get(key);
      rec.rounds++;
      rec.times.push(t);
      rec.lands.push(n.at);
    }
  }
  const need = Math.max(1, Math.ceil(list.length * share));
  return [...bag.values()]
    .filter((u) => u.rounds >= need)
    .map((u) => ({ ...u, t: median(u.times), land: median(u.lands) }))
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

/** Per kind, how many spots one line names before it stops being a summary. */
const UTILITY_PER_KIND = { smokegrenade: 3, molotov: 3, flashbang: 2, hegrenade: 2 };

/** "smokes Top Con and B Site, molo Yekindar + Backsite, flash B Main". */
export function utilityWords(util) {
  const byType = { smokegrenade: [], molotov: [], flashbang: [], hegrenade: [] };
  for (const u of util) {
    const list = byType[u.type];
    if (list && list.length < UTILITY_PER_KIND[u.type]) list.push(u.label);
  }
  const parts = [];
  const smokes = byType.smokegrenade;
  if (smokes.length) parts.push(`${smokes.length > 1 ? 'smokes' : 'smoke'} ${joinList(smokes, '+')}`);
  if (byType.molotov.length) parts.push(`${NADE_SLANG.molotov} ${joinList(byType.molotov, '+')}`);
  const flashes = byType.flashbang;
  if (flashes.length) parts.push(`${flashes.length > 1 ? nadePlural('flashbang') : 'flash'} ${joinList(flashes, '+')}`);
  if (byType.hegrenade.length) parts.push(`${NADE_SLANG.hegrenade} ${joinList(byType.hegrenade, '+')}`);
  return joinList(parts);
}

function mostCommon(list, pick) {
  const counts = new Map();
  for (const x of list) bump(counts, pick(x));
  const best = top(counts);
  return best ? best[0] : '';
}

const paceGroup = (p) => (p === 'slow-default' ? 'default' : p || 'other');

/** CT formation at the snapshot, in the map's CT order ("2-1-2"). */
function ctCounts(r, ctx) {
  const order = (FORMATIONS[ctx.mapCode]?.ct || []).map((c) => c.label);
  const snap = snapshotSample(r, ctx.mapCode);
  if (!snap || !snap.pts.length || !order.length) return null;
  const a = r.towardCount(snap, 'a', 0);
  const b = r.towardCount(snap, 'b', 0);
  const ee = Math.max(0, snap.pts.length - a - b);
  return order.map((slot) => (slot === 'A' ? a : slot === 'B' ? b : ee));
}

/**
 * What a round looked like up to the moment it committed: pace, site, where
 * the players started, the utility, and when it went. Two rounds with the same
 * shape are the same round played twice.
 */
function shapeOf(r, ctx, side) {
  const commit = commitElapsed(r);
  const util = new Set();
  for (const n of r.nades) {
    const label = nadeLabel(n);
    if (!label || (n.type !== 'smokegrenade' && n.type !== 'molotov')) continue;
    if (commit !== null && n.at > commit + 3) continue;
    util.add(`${label}\0${n.type}`);
  }
  return {
    r,
    pace: side === 'T' ? paceGroup(classifyPace(r)) : 'ct',
    slow: side === 'T' && classifyPace(r) === 'slow-default',
    site: ((side === 'T' ? paceSite(r) : r.hitSite) || '').toUpperCase(),
    commit,
    util,
    counts: side === 'T' ? laneCountsAt(r, ctx.mapCode, ctx.laneSets) : ctCounts(r, ctx)
  };
}

/**
 * Same round or not: same pace, the same site for anything that commits early,
 * the players starting within a body of each other, the utility mostly the
 * same, and the timing within five seconds (fifteen for slower rounds).
 */
function sameShape(a, b) {
  if (a.pace !== b.pace) return false;
  const open = a.pace === 'default' || a.pace === 'other' || a.pace === 'ct';
  if (!open && a.site !== b.site) return false;
  if (a.counts && b.counts && a.counts.length === b.counts.length) {
    let d = 0;
    for (let i = 0; i < a.counts.length; i++) d += Math.abs(a.counts[i] - b.counts[i]);
    if (d > 2) return false;
  }
  if (Number.isFinite(a.commit) && Number.isFinite(b.commit) && Math.abs(a.commit - b.commit) > (open ? 15 : 5)) {
    return false;
  }
  // A slow round is its shape and its timing; its utility follows what the
  // CTs showed. A fast one is named by the utility it brings.
  if (open) return true;
  let inter = 0;
  for (const k of a.util) if (b.util.has(k)) inter++;
  const union = a.util.size + b.util.size - inter;
  if (union >= 3 && inter / union < 0.34) return false;
  return true;
}

function clusterRounds(rounds, ctx, side) {
  const shapes = rounds.map((r) => shapeOf(r, ctx, side));
  shapes.sort((x, y) => (x.commit ?? 999) - (y.commit ?? 999));
  const clusters = [];
  for (const s of shapes) {
    const home = clusters.find((c) => sameShape(c.seed, s));
    if (home) home.members.push(s);
    else clusters.push({ seed: s, members: [s] });
  }
  return clusters.sort((a, b) => b.members.length - a.members.length || (a.seed.commit ?? 999) - (b.seed.commit ?? 999));
}

/** "1x A, 2x B" over the sites a variation ended on. */
function siteSpread(members) {
  const sites = new Map();
  for (const m of members) bump(sites, m.site || 'mid');
  return [...sites.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([s, n]) => `${n}x ${s}`)
    .join(', ');
}

/** One variation in a sheet's words: "Full A execute with smokes X + Y". */
function variationWords(cluster, ctx, side) {
  const m = cluster.members;
  const rounds = m.map((s) => s.r);
  const pace = cluster.seed.pace;
  const site = mostCommon(m, (s) => s.site);
  const sites = new Set(m.map((s) => s.site).filter(Boolean));
  const form = mostCommon(m, (s) =>
    s.counts ? (side === 'T' ? formatFormation(ctx.mapCode, s.counts) : s.counts.join('-')) : ''
  );
  const commits = m.map((s) => s.commit).filter(Number.isFinite);
  const clock = commits.length ? clockText(ROUND_SECONDS - median(commits)) : '';
  // One or two pieces of utility say what the round is; the full list is
  // detail nobody reads off a printed sheet. Smokes first, a molotov only
  // when there are none.
  const common = groupUtility(rounds);
  const smokes = common.filter((u) => u.type === 'smokegrenade').slice(0, 2);
  const util = utilityWords(smokes.length ? smokes : common.filter((u) => u.type === 'molotov').slice(0, 1));
  let head;
  if (side === 'CT') {
    const labels = typeLabels(ctx.mapCode, 'CT');
    const call = mostCommon(m, (s) => specificTags(s.r, 'CT')[0]?.k || '');
    const early = m.filter((s) => s.r.firstKill && s.r.firstKill.clock >= AGGRESSIVE_CLOCK);
    const zone = mostCommon(early, (s) => s.r.firstKill.attackerOurs ? s.r.firstKill.attackerZone : s.r.firstKill.victimZone);
    head = form ? `${form} setup` : 'Setup';
    if (call && m.filter((s) => specificTags(s.r, 'CT')[0]?.k === call).length * 2 >= m.length) {
      head += `, ${callName(labels.get(call) || call)}`;
    }
    if (zone && early.length * 2 >= m.length) head += `, early fight ${zone}`;
    return sentence(util ? `${head} with ${util}` : head);
  }
  switch (pace) {
    case 'rush':
      head = `${site ? `${site} ` : ''}rush${form ? ` (${form})` : ''}`;
      break;
    case 'pop':
      head = `${site ? `${site} ` : ''}pop${clock ? ` around ${clock}` : ''}${form ? ` (${form})` : ''}`;
      break;
    case 'contact':
      head = `${form ? `${form} ` : ''}early fight${clock ? ` around ${clock}` : ''}`;
      break;
    case 'full-exec':
      head = `full ${site ? `${site} ` : ''}execute${clock ? ` around ${clock}` : ''}`;
      break;
    case 'default': {
      const slow = m.filter((s) => s.slow).length * 2 > m.length;
      head = `${slow ? 'slow ' : ''}default${form ? ` ${form}` : ''}`;
      break;
    }
    default:
      head = form || 'mixed round';
  }
  if (util) head += ` with ${util}`;
  const open = pace === 'default' || pace === 'other' || pace === 'contact';
  if (open && sites.size >= 2) head += `. Open ended (${siteSpread(m)})`;
  else if (open && site) head += ` into ${site}`;
  return sentence(capitalize(head));
}

/** Most this many variations by name, then one line for everything else. */
const VARIATIONS_SHOWN = 6;

/**
 * A set of rounds as its variations: the six played most, each with how many
 * times, and one line for the rest. Every line is one way the round is played,
 * not one round.
 */
function variationsFor(rounds, ctx, side, { min = 1 } = {}) {
  if (rounds.length < min) return null;
  const clusters = clusterRounds(rounds, ctx, side);
  const shown = clusters.slice(0, VARIATIONS_SHOWN);
  const rest = rounds.length - shown.reduce((n, c) => n + c.members.length, 0);
  const lines = shown.map((c) => `${c.members.length}x ${variationWords(c, ctx, side)}`);
  if (rest > 0) lines.push(`${rest}x Other variations`);
  return { rounds: rounds.length, lines, clusters };
}

// ---------------------------------------------------------------------------
// Dangerous rounds and openings
// ---------------------------------------------------------------------------

/** "VERY quick A pop" and the like: fast, won, and seen more than once. */
function dangerFor(ctx, side) {
  const lines = [];
  const buys = ctx.rounds.filter((r) => r.side === side && r.ownEcon >= 4 && r.hasTicks);
  if (side === 'T') {
    const clusters = clusterRounds(buys, ctx, 'T').filter(
      (c) => c.members.length >= 2 && ['rush', 'pop', 'contact', 'full-exec'].includes(c.seed.pace)
    );
    const ranked = clusters
      .map((c) => ({ c, wins: c.members.filter((s) => s.r.won).length }))
      .filter((x) => x.wins >= 2 && percent(x.wins, x.c.members.length) >= 60)
      .sort((a, b) => b.wins - a.wins)
      .slice(0, 3);
    for (const { c, wins } of ranked) {
      lines.push(`${variationWords(c, ctx, 'T')} Won ${wins} of ${c.members.length}.`);
    }
  } else {
    // CT danger is aggression: early fights away from the sites.
    const early = buys.filter(
      (r) =>
        r.firstKill &&
        r.firstKill.clock >= AGGRESSIVE_CLOCK &&
        (r.firstKill.attackerOurs || r.firstKill.victimOurs)
    );
    const byZone = new Map();
    for (const r of early) {
      const k = r.firstKill;
      const zone = k.attackerOurs ? k.attackerZone || k.victimZone : k.victimZone;
      if (!zone) continue;
      if (!byZone.has(zone)) byZone.set(zone, []);
      byZone.get(zone).push(r);
    }
    const zones = [...byZone.entries()].filter(([, l]) => l.length >= 3).sort((a, b) => b[1].length - a[1].length);
    for (const [zone, list] of zones.slice(0, 3)) {
      const won = list.filter((r) => r.firstKill.attackerOurs).length;
      const clock = clockText(median(list.map((r) => r.firstKill.clock)));
      lines.push(`Early fight ${zone} around ${clock}, ${list.length} times (won the duel ${won} times).`);
    }
    if (buys.length >= 8 && percent(early.length, buys.length) < 20) {
      lines.push('Passive early, the fighting comes in the midround.');
    }
  }
  // Who gets the first kill, and where. Only the players who carry a real
  // share of them: everyone gets one sometimes.
  const opens = buys.filter((r) => r.firstKill?.attackerOurs);
  const byPlayer = new Map();
  for (const r of opens) {
    if (!byPlayer.has(r.firstKill.attacker)) byPlayer.set(r.firstKill.attacker, []);
    byPlayer.get(r.firstKill.attacker).push(r);
  }
  const players = [...byPlayer.entries()]
    .filter(([, l]) => l.length >= 4 && percent(l.length, opens.length) >= 25)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2);
  for (const [id, list] of players) {
    const zone = mostCommon(list, (r) => r.firstKill.victimZone || '');
    const atZone = zone ? list.filter((r) => r.firstKill.victimZone === zone) : list;
    const clock = clockText(median(atZone.map((r) => r.firstKill.clock)));
    const name = ctx.nameOf.get(id) || id;
    lines.push(
      `${name} gets the first kill in ${list.length} rounds${
        zone ? `, ${atZone.length} of them ${zone} around ${clock}` : ` around ${clock}`
      }.`
    );
  }
  return { lines };
}

// ---------------------------------------------------------------------------
// Anti-ecos, antiforces, force buys and pistols
// ---------------------------------------------------------------------------

function antiforceFor(ctx, side) {
  const set = ctx.rounds.filter((r) => r.side === side && r.ownEcon >= 4 && r.oppEcon <= 3 && r.hasTicks);
  return variationsFor(set, ctx, side, { min: 2 });
}

function forceFor(ctx, side) {
  const set = ctx.rounds.filter(
    (r) => r.side === side && r.ownEcon >= 2 && r.ownEcon <= 3 && r.oppEcon >= 4 && r.hasTicks
  );
  return variationsFor(set, ctx, side, { min: 2 });
}

/**
 * Pistols as variations, then whether they ever ran the same one twice in a
 * row and which they ran last: the round a sheet most needs to be right.
 */
function pistolsFor(ctx, side) {
  const set = ctx.rounds.filter((r) => r.side === side && r.ownEcon === 0 && r.oppEcon === 0 && r.hasTicks);
  const out = variationsFor(set, ctx, side, { min: 2 });
  if (!out) return null;
  const when = new Map((ctx.includedDemos || []).map(({ demo }) => [demo.id, demoTimestamp(demo)]));
  const ordered = [...set].sort(
    (a, b) => (when.get(a.demoId) || 0) - (when.get(b.demoId) || 0) || (a.round || 0) - (b.round || 0)
  );
  const clusterOf = new Map();
  out.clusters.forEach((c, i) => c.members.forEach((s) => clusterOf.set(s.r.file, i)));
  let repeats = 0;
  for (let i = 1; i < ordered.length; i++) {
    if (clusterOf.get(ordered[i].file) === clusterOf.get(ordered[i - 1].file)) repeats++;
  }
  const notes = [];
  if (ordered.length >= 3) {
    const last = out.clusters[clusterOf.get(ordered[ordered.length - 1].file)];
    const lastWords = last ? variationWords(last, ctx, side).replace(/\.$/, '') : '';
    if (!repeats) notes.push(`They never ran the same pistol twice in a row.${lastWords ? ` Last one was: ${lastWords}.` : ''}`);
    else if (lastWords) notes.push(`Last one was: ${lastWords}.`);
  }
  return { ...out, notes };
}

// ---------------------------------------------------------------------------
// T site rounds: what the site players will be dealing with
// ---------------------------------------------------------------------------

function tSiteFor(ctx, site) {
  const letter = site.toUpperCase();
  const full = ctx.rounds.filter((r) => r.side === 'T' && r.ownEcon >= 4 && r.hasTicks);
  const toward = full.filter((r) => paceSite(r) === site);
  const bullets = [];
  if (toward.length < 3) return { site: letter, rounds: toward.length, bullets };

  // The utility that comes in, by how dependably.
  const all = groupUtility(toward, 0.25);
  const always = all.filter((u) => percent(u.rounds, toward.length) >= 75);
  const often = all.filter((u) => {
    const p = percent(u.rounds, toward.length);
    return p >= 40 && p < 75;
  });
  if (always.length) bullets.push(`Almost always ${utilityWords(always)}.`);
  if (often.length) bullets.push(`Often ${utilityWords(often)}.`);

  // Patience: when the smokes are up against when they walk in.
  const lands = [];
  const entries = [];
  for (const r of toward) {
    const entry = r.siteEntry(2);
    if (!entry || entry.site !== site) continue;
    entries.push({ r, entry });
    const enter = ROUND_SECONDS - entry.clock;
    const smokes = r.nades.filter(
      (n) => n.type === 'smokegrenade' && nadeLabel(n) && n.at <= enter && n.at >= enter - CALL_UTILITY_LEAD
    );
    if (smokes.length) lands.push(Math.min(...smokes.map((n) => n.at)));
  }
  if (entries.length >= 3 && lands.length >= 3) {
    const land = median(lands);
    const go = median(entries.map((e) => ROUND_SECONDS - e.entry.clock));
    if (land !== null && go !== null && go > land) {
      const wait = Math.round(go - land);
      bullets.push(
        `Smokes for the hit land around ${clockText(ROUND_SECONDS - land)}, they enter around ${clockText(ROUND_SECONDS - go)}${
          wait >= 10 ? ' (patient)' : wait <= 4 ? ' (straight in)' : ''
        }.`
      );
    }
  }

  // Where they come from: one entrance, or a split.
  const routes = new Map();
  let splits = 0;
  for (const { r, entry } of entries) {
    const before = r.sampleAt(entry.tick - 3 * r.tickRate);
    const after = r.sampleAt(entry.tick);
    if (!before || !after) continue;
    const onSite = new Set(after.pts.filter((p) => r.siteNear(p.x, p.y, 0) === site).map((p) => p.id));
    const from = before.pts.filter((p) => onSite.has(p.id)).map((p) => p.pos).filter(Boolean);
    const lanes = new Set(from.map((pos) => laneOfPos(pos, ctx.laneSets)).filter((l) => l >= 0));
    if (lanes.size >= 2) splits++;
    else bump(routes, mostCommon(from, (x) => x));
  }
  const route = top(routes);
  if (entries.length >= 4) {
    if (percent(splits, entries.length) >= 40) bullets.push(`Split in ${splits} of ${entries.length} entries.`);
    if (route && route[0] && percent(route[1], entries.length) >= 40) {
      bullets.push(`Mostly come in through ${route[0]} (${route[1]} of ${entries.length}).`);
    }
  }

  // Late finishes, and where they come from.
  const late = entries.filter(({ entry }) => entry.clock <= 40);
  if (late.length >= 2) {
    const zone = mostCommon(late, ({ r, entry }) => {
      const s = r.sampleAt(entry.tick - 3 * r.tickRate);
      return mostCommon((s?.pts || []).filter((p) => p.pos), (p) => p.pos);
    });
    bullets.push(`${late.length} late round finishes${zone ? `, usually from ${zone}` : ''}.`);
  }

  const wins = toward.filter((r) => r.won).length;
  bullets.push(`Win ${percent(wins, toward.length)}% of ${letter} rounds (${wins} of ${toward.length}).`);
  return { site: letter, rounds: toward.length, bullets };
}

// ---------------------------------------------------------------------------
// CT: against A, against B, retakes
// ---------------------------------------------------------------------------

/** Tick of the first fight on a site in a CT round, or null. */
function contactTick(r, site) {
  for (const k of r.kills) {
    if (k.x !== null && r.siteNear(k.x, k.y) === site) return k.tick;
  }
  return null;
}

function ctVsSiteFor(ctx, site) {
  const letter = site.toUpperCase();
  const set = ctx.rounds.filter(
    (r) => r.side === 'CT' && r.ownEcon >= 4 && r.oppEcon >= 4 && r.hasTicks && r.hitSite === site
  );
  const bullets = [];
  if (set.length < 3) return { site: letter, rounds: set.length, bullets };
  const wins = set.filter((r) => r.won).length;
  bullets.push(`Win ${percent(wins, set.length)}% against ${letter} hits (${wins} of ${set.length}).`);

  const there = [];
  const rotate = [];
  const util = new Map();
  for (const r of set) {
    const tick = contactTick(r, site);
    if (tick === null) continue;
    const s = r.sampleAt(tick);
    const n = r.towardCount(s, site, 0);
    there.push(n);
    for (const later of r.series) {
      if (later.tick <= tick) continue;
      if (r.towardCount(later, site, 0) > n) {
        rotate.push((later.tick - tick) / r.tickRate);
        break;
      }
    }
    const seen = new Set();
    for (const g of r.nades) {
      const label = nadeLabel(g);
      if (!label || seen.has(label)) continue;
      if (Math.abs(g.tick - tick) > 15 * r.tickRate) continue;
      if (r.siteNear(g.x, g.y) !== site) continue;
      seen.add(label);
      bump(util, `${label}\0${g.type}`);
    }
  }
  if (there.length >= 3) {
    const n = Math.round(median(there));
    bullets.push(`Usually ${n} on ${letter} when the hit comes.`);
  }
  if (rotate.length >= 3) {
    bullets.push(`First rotator usually arrives ${Math.round(median(rotate))} seconds after the first fight.`);
  }
  const used = [...util.entries()]
    .filter(([, c]) => percent(c, set.length) >= 40)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => {
      const [label, type] = k.split('\0');
      return { label, type };
    });
  if (used.length) bullets.push(`Usually answer it with ${utilityWords(used)}.`);
  return { site: letter, rounds: set.length, bullets };
}

function retakesFor(ctx) {
  const set = ctx.rounds.filter((r) => r.side === 'CT' && r.ownEcon >= 2 && r.hasTicks && r.plantTick != null);
  const bullets = [];
  for (const site of ['a', 'b']) {
    const list = set.filter((r) => (r.plantSite || r.hitSite) === site);
    if (list.length < 2) continue;
    const letter = site.toUpperCase();
    const wins = list.filter((r) => r.won).length;
    const alive = [];
    const waits = [];
    let saves = 0;
    for (const r of list) {
      const at = r.sampleAt(r.plantTick);
      if (at) alive.push(at.pts.length);
      // The retake starts with the first fight after the plant.
      const kill = r.kills.find((k) => k.tick > r.plantTick && (k.attackerOurs || k.victimOurs));
      if (kill) waits.push((kill.tick - r.plantTick) / r.tickRate);
      else if (!r.won) saves++;
    }
    const parts = [`Retake ${letter}: won ${wins} of ${list.length}`];
    if (alive.length >= 2) parts.push(`usually ${Math.round(median(alive))} alive at the plant`);
    const wait = waits.length >= 2 ? Math.round(median(waits)) : 0;
    if (wait >= 2) parts.push(`first fight about ${wait} seconds after it`);
    bullets.push(`${parts.join(', ')}.`);
    if (saves >= 2) bullets.push(`Saved instead of retaking ${letter} ${countWord(saves)}.`);
  }
  return { rounds: set.length, bullets };
}

/** Every opening kill one side's players made, with what a sheet says about it. */
export function openingsFor(ctx, side) {
  const mainIds = new Set(ctx.mains.map((m) => m.id));
  const rounds = ctx.rounds.filter((r) => r.side === side);
  const set = rounds.filter((r) => r.firstKill?.attackerOurs);
  const byPlayer = new Map();
  for (const r of set) {
    const k = r.firstKill;
    if (!mainIds.has(k.attacker)) continue;
    const pace = side === 'T' ? classifyPace(r) : '';
    const setCall =
      side === 'T'
        ? pace === 'rush' || pace === 'pop' || pace === 'contact' || pace === 'full-exec'
        : // Nearly every CT round carries some call, so on CT the word means nothing.
          false;
    const phase = phaseAtTick(k.tick, r.bounds);
    const site = r.siteNear(k.x, k.y) || (side === 'T' ? paceSite(r) : r.hitSite) || null;
    const roundSite = side === 'T' ? paceSite(r) : r.hitSite;
    if (!byPlayer.has(k.attacker)) byPlayer.set(k.attacker, []);
    byPlayer.get(k.attacker).push({
      file: r.file,
      zone: k.victimZone || zoneAt(k.x, k.y, ctx.network),
      clock: k.clock,
      phase,
      late: phase === 'late',
      setCall,
      site,
      roundSite,
      aggressive: k.clock >= AGGRESSIVE_CLOCK
    });
  }
  const total = set.length;
  const lines = [];
  for (const [id, kills] of byPlayer) {
    const name = ctx.nameOf.get(id) || id;
    const seed = `${ctx.seed}|open|${side}|${id}`;
    const zones = new Map();
    for (const k of kills) {
      if (!k.zone) continue;
      if (!zones.has(k.zone)) zones.set(k.zone, []);
      zones.get(k.zone).push(k);
    }
    // Averaged rather than the median: the detailed report's "usually" is an
    // average, and the two documents must not disagree about one clock.
    const zoneRows = [...zones.entries()]
      .map(([zone, list]) => ({
        zone,
        count: list.length,
        clock: clockText(list.reduce((n, k) => n + k.clock, 0) / list.length),
        first: Math.max(...list.map((k) => k.clock))
      }))
      .sort((a, b) => b.count - a.count || b.first - a.first || a.zone.localeCompare(b.zone));
    // `inner` goes inside the brackets after the count, `after` follows them.
    const line = { id, name, count: kills.length, files: kills.map((k) => k.file), inner: [], after: '', note: '' };
    const zoneText = (z) => `${z.zone} x${z.count} usually ${z.clock}`;

    const allLate = kills.every((k) => k.late);
    const allSet = kills.every((k) => k.setCall);
    const allLateOrSet = kills.every((k) => k.late || k.setCall);
    const aggressive = kills.filter((k) => k.aggressive);
    if (kills.length >= 3 && (allLate || allSet || allLateOrSet)) {
      line.after = say(allLate ? 'open-all-late' : allSet ? 'open-all-set' : 'open-all-late-set', seed);
    } else if (kills.length <= 3) {
      line.inner = zoneRows.map(zoneText);
    } else if (kills.length <= 5 && aggressive.length <= 1) {
      line.inner.push(
        aggressive.length
          ? say('open-only-aggressive', seed, { n: 1, zone: aggressive[0].zone || siteLetter(aggressive[0].site) })
          : say('open-no-aggressive', seed)
      );
    } else {
      // The ground that repeats, then a word on the rest. When nothing repeats
      // the first few are named as they came.
      const repeats = zoneRows.filter((z, i) => z.count >= 2 && (i === 0 || percent(z.count, kills.length) >= 25));
      const shown = repeats.length ? repeats.slice(0, 2) : zoneRows.slice(0, 3);
      line.inner = shown.map(zoneText);
      const shownZones = new Set(shown.map((z) => z.zone));
      const rest = kills.filter((k) => !shownZones.has(k.zone));
      // Ground they spend the early round on without ever opening there.
      if (kills.length >= 4) {
        const early = earlyHome(ctx, side, id);
        if (early && !kills.some((k) => k.zone === early && !k.late)) {
          line.inner.push(say('open-nothing-early', seed, { zone: early }));
        }
      }
      if (rest.length) line.inner.push(repeats.length ? restWords(rest, seed) : say('open-rest-spread', seed));
    }
    // A player carrying the openings, and carrying them towards one site.
    if (total >= 8 && percent(kills.length, total) >= 35) {
      const sites = new Map();
      for (const k of kills) bump(sites, siteLetter(k.site));
      const best = top(sites);
      if (best && best[0] && percent(best[1], kills.length) >= 55) {
        line.note = say('open-very-active', seed, { site: best[0] });
      }
    }
    lines.push(line);
  }
  lines.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total, lines };
}

/** "rest Con late for B calls", or "rest spread out" when nothing ties them. */
function restWords(rest, seed) {
  const zones = new Map();
  const sites = new Map();
  let late = 0;
  let early = 0;
  for (const k of rest) {
    bump(zones, k.zone);
    bump(sites, siteLetter(k.roundSite));
    if (k.late) late++;
    else if (k.phase === 'early') early++;
  }
  const words = [];
  const z = top(zones);
  if (z && z[0] && z[1] >= 2 && percent(z[1], rest.length) >= 50) words.push(z[0]);
  if (percent(late, rest.length) >= 60) words.push('late');
  else if (percent(early, rest.length) >= 60) words.push('early');
  const s = top(sites);
  if (s && s[0] && rest.length >= 2 && percent(s[1], rest.length) >= 60) words.push(`for ${s[0]} calls`);
  if (!words.length) return say('open-rest-spread', seed);
  return say('open-rest', seed, { what: words.join(' ') });
}

/**
 * Where a player spends the early round, by named ground, once out of spawn.
 * Only an answer when one place clearly dominates.
 */
function earlyHome(ctx, side, id) {
  const counts = new Map();
  let total = 0;
  for (const r of ctx.rounds) {
    if (r.side !== side || !r.hasTicks || r.ownEcon < 4) continue;
    for (const s of r.series) {
      if (s.elapsed < 8 || s.tick >= r.bounds.midStartTick) continue;
      const p = s.pts.find((x) => x.id === id);
      if (!p?.pos) continue;
      bump(counts, p.pos);
      total++;
    }
  }
  const best = top(counts);
  return best && percent(best[1], total) >= 25 ? best[0] : '';
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** Early duels a player has to take part in, as a share of the team's, to read as aggressive. */
const AGGRESSION_HIGH = 0.35;
const AGGRESSION_MID = 0.2;

/** The player's sample in one 1s slice, or null. */
function sampleOf(r, id, elapsed) {
  const s = r.sampleAt(r.t0 + elapsed * r.tickRate);
  return s?.pts.find((p) => p.id === id) || null;
}

/** Which site a lane stands for, when it stands for one ("B" -> 'b'). */
function laneSite(lane) {
  const short = String(lane?.short || '').trim();
  return /^[AB]$/i.test(short) ? short.toLowerCase() : null;
}

/**
 * One paragraph per player, built from what the rounds say about them. Every
 * sentence is optional: a fact the rounds do not support is left out rather
 * than written vaguely. No recommendations: the analyst writes those.
 */
export function playerFor(ctx, side, main, extras) {
  const id = main.id;
  const name = main.name;
  const role = ctx.rolesOf(id, side) || '';
  const seed = `${ctx.seed}|player|${side}|${id}`;
  const lanes = FORMATIONS[ctx.mapCode]?.t || [];
  const rounds = ctx.rounds.filter((r) => r.side === side && r.hasTicks);
  const full = rounds.filter((r) => r.ownEcon >= 4);
  if (!full.length) return null;

  // Where they are once out of spawn, by lane, and by ground in the midround.
  const laneEarly = new Map();
  const zoneEarly = new Map();
  const zoneMid = new Map();
  let earlyN = 0;
  let midN = 0;
  for (const r of full) {
    for (const s of r.series) {
      if (s.elapsed < 8) continue;
      const p = s.pts.find((x) => x.id === id);
      if (!p) continue;
      if (s.tick < r.bounds.midStartTick) {
        earlyN++;
        const lane = laneOfPos(p.pos, ctx.laneSets);
        if (lane >= 0) bump(laneEarly, lane);
        if (p.pos) bump(zoneEarly, p.pos);
      } else if (s.tick < r.bounds.lateStartTick) {
        midN++;
        if (p.pos) bump(zoneMid, p.pos);
      }
    }
  }
  // Lanes are the T notation's. A CT has no lane, only the ground they hold.
  const mainLane = side === 'T' ? top(laneEarly) : null;
  const lane = mainLane && lanes[mainLane[0]] ? lanes[mainLane[0]] : null;
  const laneName = lane ? laneWord(lane) : '';
  const laneShare = mainLane ? percent(mainLane[1], earlyN) : 0;
  // Their usual early ground, inside their lane when they have one.
  const homeZone =
    top(
      new Map(
        [...zoneEarly].filter(([pos]) => !mainLane || laneOfPos(pos, ctx.laneSets) === mainLane[0])
      )
    )?.[0] ||
    top(zoneEarly)?.[0] ||
    '';

  // Aggression: the share of the team's early opening duels they are in.
  const isEarly = (r) => r.firstKill && r.firstKill.clock >= AGGRESSIVE_CLOCK;
  const inDuel = (r) => r.firstKill && (r.firstKill.attacker === id || r.firstKill.victim === id);
  const earlyDuels = rounds.filter((r) => isEarly(r) && inDuel(r));
  const teamEarly = rounds.filter((r) => isEarly(r) && (r.firstKill.attackerOurs || r.firstKill.victimOurs));
  const opens = rounds.filter(inDuel);
  const share = teamEarly.length ? earlyDuels.length / teamEarly.length : 0;
  const aggrKey =
    share >= AGGRESSION_HIGH ? 'player-aggr-high' : share >= AGGRESSION_MID ? 'player-aggr-mid' : 'player-aggr-low';
  const earlyZone = mostCommon(earlyDuels, (r) => r.firstKill.victimZone || '');

  const awpRounds = full.filter((r) => r.series.some((s) => s.pts.some((p) => p.id === id && p.awp)));
  // A rifler who picks up a dropped AWP five times is not the AWPer.
  const isAwper = awpRounds.length >= 5 && percent(awpRounds.length, full.length) >= 35;

  const sentences = [];
  if (isAwper) {
    // Where the AWP sits in the midround, round by round.
    const spots = new Map();
    for (const r of awpRounds) {
      const p = sampleOf(r, id, MIDROUND_ELAPSED);
      const l = p ? laneOfPos(p.pos, ctx.laneSets) : -1;
      bump(spots, side === 'T' && l >= 0 && lanes[l] ? laneWord(lanes[l]) : p?.pos || '');
    }
    const ranked = [...spots.entries()].filter(([k]) => k).sort((a, b) => b[1] - a[1]);
    const busy = ranked.filter(([, n]) => n >= 2).length;
    sentences.push(say(busy >= 3 ? 'player-awp-dynamic' : 'player-awp-static', seed));
    const shown = ranked.slice(0, 3);
    const restN = ranked.slice(3).reduce((n, [, c]) => n + c, 0);
    const parts = shown.map(([where, n], i, arr) =>
      i === arr.length - 1 && arr.length > 2 && n >= 3 && !restN
        ? `rest (${plural(n, 'round')}) towards ${where}`
        : n === 1
          ? `once ${where}`
          : `${plural(n, 'round')} ${where}`
    );
    if (restN) parts.push(`rest (${plural(restN, 'round')}) spread out`);
    if (parts.length) sentences.push(capitalize(joinList(parts)));
  } else if (side === 'T' && laneName && laneShare >= 35) {
    sentences.push(say('player-plays', seed, { where: laneName }));
  } else if (role || homeZone) {
    // On T how aggressive someone is only gets a word when it is extreme
    // (below); on CT it is part of describing the position.
    const where = say('player-plays', seed, { where: role || homeZone });
    sentences.push(side === 'T' ? where : `${where}, ${say(aggrKey, seed)}`);
  }

  // T aggression, only when it stands out: opening duels taken on ground the
  // team had not reached, or had reached only seconds before.
  if (side === 'T') {
    let pushes = 0;
    const pushZones = new Map();
    for (const r of full) {
      const k = r.firstKill;
      if (!k || k.tick >= r.bounds.midStartTick) continue;
      if (k.attacker !== id && k.victim !== id) continue;
      const me = r.sampleAt(k.tick)?.pts.find((p) => p.id === id);
      const pos = me?.pos || (k.attacker === id ? k.attackerZone : k.victimZone) || '';
      if (!pos) continue;
      const first = r.firstVisit?.get(pos);
      if (first === undefined || k.tick - first <= 6 * r.tickRate) {
        pushes++;
        bump(pushZones, pos);
      }
    }
    if (pushes >= 5 && percent(pushes, full.length) >= 25) {
      const zone = top(pushZones)?.[0];
      sentences.push(
        `Very aggressive: in ${pushes} of ${full.length} rounds takes the opening duel pushing ${
          zone ? `into ${zone} ` : ''
        }before the team holds it`
      );
    }
  }

  // The first thing they do in most rounds, with how many are beside them.
  const withActions = full.map((r) => ({ file: r.file, won: r.won, actions: playerActions(r, id) }));
  const recurring = recurringActions(withActions, buildTimeIndex(withActions), 0.25).filter((a) =>
    a.kind === 'nade' ? a.t >= 8 : a.t >= 10
  );
  const firstHabit = [...recurring].sort((a, b) => a.t - b.t)[0];
  if (firstHabit) {
    const mates = [];
    for (const f of firstHabit.files.slice(0, 20)) {
      const r = full.find((x) => x.file === f);
      const s = r?.sampleAt(r.t0 + firstHabit.t * r.tickRate);
      const me = s?.pts.find((p) => p.id === id);
      if (!me) continue;
      mates.push(s.pts.filter((p) => p.id !== id && Math.hypot(p.x - me.x, p.y - me.y) <= ALONE_UNITS).length);
    }
    const near = Math.round(median(mates) ?? 0);
    const action =
      firstHabit.kind === 'nade'
        ? withArticle(nadeName(firstHabit.spot, firstHabit.type))
        : `getting to ${firstHabit.spot}`;
    sentences.push(
      say('player-first-timing', seed, {
        action,
        clock: firstHabit.clock,
        with: near >= 2 ? say('player-with-mates', seed, { n: near }) : near === 1 ? say('player-with-mate', seed) : ''
      })
    );
  }

  // How rarely the team commits to their lane: "at 1:20 only twice with 3+ mid".
  if (side === 'T' && lane && !laneSite(lane) && !isAwper) {
    let n = 0;
    for (const r of full) {
      const s = r.sampleAt(r.t0 + MIDROUND_ELAPSED * r.tickRate);
      if (!s) continue;
      const inLane = s.pts.filter((p) => laneOfPos(p.pos, ctx.laneSets) === mainLane[0]).length;
      if (inLane >= 3) n++;
    }
    if (n >= 1 && n <= 3) {
      sentences.push(
        say('player-team-lane', seed, {
          clock: clockText(ROUND_SECONDS - MIDROUND_ELAPSED),
          count: countWord(n),
          lane: laneName
        })
      );
    }
  }

  // When the fights come, in their lane if they have one.
  const fights = [];
  for (const r of rounds) {
    for (const k of r.kills) {
      if (k.attacker !== id && k.victim !== id) continue;
      const zone = zoneAt(k.x, k.y, ctx.network);
      fights.push({ clock: k.clock, zone, lane: laneOfPos(zone, ctx.laneSets) });
    }
  }
  const laneFights = mainLane ? fights.filter((f) => f.lane === mainLane[0]) : [];
  const inLane = laneFights.length >= 3 && Boolean(laneName);
  const fightSet = inLane ? laneFights : fights;
  if (fightSet.length >= 3) {
    const zone = mostCommon(fightSet, (f) => f.zone);
    const where = inLane ? `${laneSite(lane) ? 'on' : 'in'} ${laneName}` : zone ? `on ${zone}` : '';
    let line = say('player-active-around', seed, {
      where,
      clock: clockText(median(fightSet.map((f) => f.clock)))
    }).replace(/\s+around/, ' around');
    if (side !== 'T' && aggrKey === 'player-aggr-low' && laneEarly.size >= 2) {
      line = `${line}, ${say('player-otherwise-passive', seed)}`;
    }
    sentences.push(line);
  }
  if (side !== 'T' && earlyDuels.length >= 2 && earlyDuels.length <= 4 && earlyZone && aggrKey !== 'player-aggr-high') {
    sentences.push(say('player-early-peeks', seed, { zone: earlyZone }));
  }

  // The ground they hold in the midround and how long they stay on it.
  let holdZone = '';
  const hold = top(zoneMid);
  if (hold && midN && percent(hold[1], midN) >= 25) {
    holdZone = hold[0];
    const leaves = [];
    for (const r of full) {
      let last = null;
      for (const s of r.series) {
        const p = s.pts.find((x) => x.id === id);
        if (p?.pos === holdZone) last = s.elapsed;
      }
      if (last !== null) leaves.push(ROUND_SECONDS - last);
    }
    const holdClock = median(leaves);
    if (holdClock !== null && leaves.length >= 4) {
      sentences.push(say('player-holds', seed, { zone: holdZone, clock: clockText(holdClock) }));
    }
  }

  // Ground they hold early, and how rarely they are still on it at 1:30.
  let earlyHold = '';
  {
    const spots = new Map();
    for (const r of full) bump(spots, sampleOf(r, id, 15)?.pos || '');
    spots.delete('');
    const best = top(spots);
    if (best && full.length >= 6 && percent(best[1], full.length) >= 40 && best[0] !== holdZone) {
      earlyHold = best[0];
      const still = full.filter((r) => sampleOf(r, id, 25)?.pos === earlyHold).length;
      if (still >= 1 && percent(still, best[1]) <= 35) {
        sentences.push(say('player-late-hold', seed, { n: still, zone: earlyHold, clock: '1:30' }));
      }
    }
  }

  // Utility they throw round after round.
  const util = (extras?.utility || []).filter((u) => u.share >= 25);
  if (util.length) {
    sentences.push(
      say('player-utility', seed, {
        list: joinList(
          util.slice(0, 2).map((u) => `${withArticle(nadeName(u.name, u.type))} at ${u.clock} (${u.share}%)`)
        )
      })
    );
  }

  // T: do they leave their lane when the team commits to the other site?
  let leavesHome = false;
  let otherSite = '';
  if (side === 'T' && lane && laneSite(lane) && homeZone) {
    const home = laneSite(lane);
    otherSite = home === 'a' ? 'b' : 'a';
    const away = full.filter((r) => paceSite(r) === otherSite);
    if (away.length >= 3) {
      let joined = 0;
      for (const r of away) {
        const at = commitElapsed(r);
        const p = at !== null ? sampleOf(r, id, at + 5) : null;
        if (p && r.siteNear(p.x, p.y) === otherSite) joined++;
      }
      const joinShare = percent(joined, away.length);
      if (joinShare >= 70) {
        leavesHome = true;
        sentences.push(say('player-joins', seed, { lane: otherSite.toUpperCase(), share: joinShare }));
      } else if (joinShare <= 30) {
        sentences.push(say('player-stays', seed, { zone: homeZone, other: otherSite.toUpperCase() }));
      }
    }
  }

  if (!sentences.length) return null;
  return {
    id,
    name,
    role,
    text: paragraph(sentences, ctx.names),
    // The analyst writes the recommendations; the sheet only states facts.
    rec: ''
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Everything the summary prints, as data.
 *
 * @param {{
 *   extract: { rounds: object[], network: object|null, laneSets: object, nameOf: Map, mains: Array, rolesOf: Function, includedDemos?: Array },
 *   sections: object,
 *   mapCode: string,
 *   teamName: string
 * }} input
 */
export function buildSummaryReport({ extract, sections, mapCode, teamName }) {
  const ctx = {
    ...extract,
    mapCode,
    teamName,
    seed: `${teamName}|${mapCode}`,
    // Handles are written as their owners write them, sentence start or not.
    names: [...(extract.nameOf?.values?.() || [])]
  };
  const players = sections?.players || [];
  const out = { teamName, mapCode, sides: {} };
  for (const side of ['T', 'CT']) {
    const order = ['b', 'a'];
    const count = (s) =>
      ctx.rounds.filter((r) => r.side === side && (side === 'T' ? paceSite(r) : r.hitSite) === s).length;
    order.sort((x, y) => count(y) - count(x));
    out.sides[side] = {
      positions: positionsFor(ctx, side),
      pace: side === 'T' ? paceFor(ctx) : null,
      setups: side === 'CT' ? setupsFor(ctx) : null,
      tells: tellsFor(ctx, side),
      danger: dangerFor(ctx, side),
      antiforce: antiforceFor(ctx, side),
      force: forceFor(ctx, side),
      sites: order.map((s) => (side === 'T' ? tSiteFor(ctx, s) : ctVsSiteFor(ctx, s))),
      retakes: side === 'CT' ? retakesFor(ctx) : null,
      pistols: pistolsFor(ctx, side),
      players: ctx.mains
        .map((m) => {
          const scan = players.find((p) => p.name === m.name);
          return playerFor(ctx, side, m, { utility: scan?.sides?.[side]?.utility || [] });
        })
        .filter(Boolean)
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
//
// Printed, so nothing in it is a link: a round count is a number on paper.

const TITLE_STYLE = 'font-size: 25px';
const HEADING_STYLE = 'font-size: 19px';

export const note = (html) => `<span style="color: ${NOTE_COLOR}">${html}</span>`;
const negative = (html) => `<span style="color: ${NEGATIVE_COLOR}">${html}</span>`;
const li = (items) => (items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '');
/** The note column of a sheet, kept on the line it belongs to. */
const aside = (text, esc) => (text ? `&nbsp;&nbsp;&nbsp;${note(`*${esc(text)}`)}` : '');

function positionsHtml(esc, rows) {
  return li(rows.map((p) => `${esc(p.name)}: ${esc(p.role || 'Unknown')}`));
}

function paceHtml(esc, pace) {
  if (!pace?.basis) return '';
  return li(
    pace.rows.map((row) => {
      const sites =
        FAST.includes(row.pace) && row.siteA + row.siteB > 0
          ? `, ${row.siteB} towards B, ${row.siteA} towards A`
          : '';
      return `${esc(row.label)}: ${row.share}% (${row.count}${sites})${aside(row.note, esc)}`;
    })
  );
}

function setupsHtml(esc, setups) {
  if (!setups?.rows?.length) return '';
  return li(
    setups.rows.map((r) => `${esc(r.label)}: ${r.share}% (${r.count}, ${r.winrate}% won)${aside(r.note, esc)}`)
  );
}

function callsHtml(esc, setups) {
  if (!setups?.calls?.length) return '';
  return li(
    setups.calls.map(
      (c) => `${esc(c.label)}: ${c.share}% (${c.count}${c.clock ? `, usually ${esc(c.clock)}` : ''}, ${c.winrate}% won)`
    )
  );
}

function tellsHtml(esc, tells) {
  const rows = tells.tells.map(
    (t) => `${esc(capitalize(t.utility))}: ${note(esc(`${t.freq} ${t.outcome}`))} (${t.hits} of ${t.rounds})`
  );
  for (const t of tells.absent || []) {
    rows.push(
      `Without ${esc(t.utility)} (${100 - t.usual}% of rounds): ${note(esc(`${t.freq || 'Mostly'} ${t.outcome}`))} (${t.hits} of ${t.rounds})`
    );
  }
  if (tells.firstBuy) {
    if (tells.firstBuy.tells.length) {
      for (const t of tells.firstBuy.tells) {
        rows.push(`First buy, ${esc(t.utility)}: ${note(esc(`${t.freq} ${t.outcome}`))} (${t.hits} of ${t.rounds})`);
      }
    } else {
      rows.push(negative(esc(say('tells-none-first-buy', 'first'))));
    }
  }
  if (!rows.length) rows.push(negative(esc(say('tells-none', 'none'))));
  return li(rows);
}

const linesHtml = (esc, lines) => li((lines || []).map((l) => esc(l)));

function variationsHtml(esc, v) {
  if (!v?.lines?.length) return '';
  return `${linesHtml(esc, v.lines)}${(v.notes || []).map((n) => `<p>${note(`*${esc(n)}`)}</p>`).join('')}`;
}

function playersHtml(esc, list) {
  return list
    .map((p) => `<h3>${esc(p.name)}${p.role ? ` (${esc(p.role)})` : ''}</h3><p>${esc(p.text)}</p>`)
    .join('');
}

/**
 * @param {{
 *   teamName: string,
 *   mapCode: string,
 *   categories: string[],
 *   report: ReturnType<typeof buildSummaryReport>,
 *   results?: object
 * }} spec
 * @param {(s: string) => string} esc
 */
export function buildSummaryDocHtml(spec, esc) {
  const mapName = MAPS[spec.mapCode]?.name || spec.mapCode;
  const cats = new Set(spec.categories || []);
  const parts = [`<h1 style="${TITLE_STYLE}">${esc(spec.teamName)}: ${esc(mapName)}</h1>`];
  for (const side of ['T', 'CT']) {
    if (!cats.has(side === 'T' ? 'sideT' : 'sideCT')) continue;
    const bag = spec.report?.sides?.[side];
    if (!bag) continue;
    parts.push(`<h2 style="${HEADING_STYLE}">${esc(spec.teamName)} ${SIDE_OF[side]} SIDE</h2>`);
    const section = (key, title, html) => {
      if (!cats.has(key) || !html) return;
      parts.push(`<h3>${esc(`${side} ${title}`)}</h3>${html}`);
    };
    section('positions', 'Positions', positionsHtml(esc, bag.positions));
    if (side === 'T') section('pace', 'Pace', paceHtml(esc, bag.pace));
    else {
      section('pace', `Setups (${(bag.setups?.order || []).join(' - ')})`, setupsHtml(esc, bag.setups));
      section('pace', 'Calls', callsHtml(esc, bag.setups));
    }
    section('tells', 'Tells', tellsHtml(esc, bag.tells));
    if (side === 'T') section('force', 'Force buys', variationsHtml(esc, bag.force));
    section('danger', 'Dangerous rounds & openings', linesHtml(esc, bag.danger?.lines));
    section('antiforce', side === 'T' ? 'Antiforces' : 'Anti-ecos', variationsHtml(esc, bag.antiforce));
    if (side === 'CT') section('force', 'Force buys', variationsHtml(esc, bag.force));
    for (const s of bag.sites || []) {
      section('sites', side === 'T' ? `${s.site} Rounds` : `VS ${s.site} Rounds`, linesHtml(esc, s.bullets));
    }
    if (side === 'CT') section('sites', 'Retakes', linesHtml(esc, bag.retakes?.bullets));
    section('pistols', 'Pistols', variationsHtml(esc, bag.pistols));
    if (cats.has('players') && bag.players.length) parts.push(playersHtml(esc, bag.players));
  }
  return parts.join('');
}

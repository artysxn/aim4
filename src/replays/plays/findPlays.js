// ---------------------------------------------------------------------------
// replays/plays/findPlays.js
// What each side did in a round, as plays: which parts were a default and
// which were a play (a decision: a hit, a stack, a push, a rotation...), when,
// by whom, and what each did to the side's round win chance.
//
// The input is a Similar Rounds index (similar/roundSimilarity.js) and the
// map's baseline (plays/playMap.js). Every play is measured, not described:
// its kind comes from where the players went and what utility landed, its
// "usual" from how often the library's rounds ran the same kind, and its
// outcome from the round model's win series. The words a coach would use
// for each kind are in DEFINITIONS, and the same definitions are what the
// eye is told when it guesses a play wrong (tools/eye/plays/notes.mjs).
//
// T side
//   default     no commitment yet: players spread taking map control
//   execute     3+ players onto a site with 3+ grenades landing on it first
//   split       3+ players onto a site from 2+ lanes at once
//   rush        onto a site before 1:25
//   contact     2+ players onto a site with little utility
//   (fake)      2+ grenades on the other site first: the hit is "after a fake"
//   lurk        one player far from the hit, in the other half, while it goes
//   rotate      3+ players leave one site's ground for the other's
//   postplant   where the Ts hold after the plant: on the site or off it
//   save        the side keeps its guns instead of playing for the round
// CT side
//   setup       how the five stand at 1:40 (A-mid-B); default when common
//   stack       4+ on one site
//   push        2+ CTs into the Ts' ground early, together
//   aggression  one CT into the Ts' ground early
//   rotate      players leave their site for the other one before the plant
//   retake      CTs onto the planted site: together or one by one
// Both
//   opening     the first kill of the round
//
// DOM-free.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS } from '../viewer/roundClock.js';
import {
  ECON_WORD,
  econGroup,
  firstLiveRow,
  lastLiveRow,
  livePos,
  placeOf,
  playFrequency,
  rowAt,
  rowElapsed,
  shapeSurprise,
  sideAt,
  surprisePercentile,
  winAt,
  wonBy
} from './playMap.js';

/** Players reaching a site this close together are one wave. */
const WAVE_SECONDS = 12;
/** Grenades onto the site in this window before the wave are its execute utility. */
const UTIL_BEFORE = 15;
const UTIL_AFTER = 3;
/** Grenades within this many site radii of a site landed on it. */
const NEAR_SITE = 1.6;
/** Seconds back from stepping on a site that a player's lane is read at. */
const LANE_BACK = 6;
/** Two entries whose lanes start further apart than this came from different lanes. */
const LANE_APART = 900;
/** A hit on the site before this many seconds of the round is a rush (1:25). */
const RUSH_BY = 30;
/** A hit after this many seconds is late (0:35). */
const LATE_FROM = 80;
/** A default phase shorter than this is no default: the side went straight into a play. */
const DEFAULT_MIN = 25;
/** A lurker is at least this far from the hit when it goes in. */
const LURK_APART = 1400;
/** CT setup is read at this many seconds (1:40). */
const SETUP_AT = 15;
/** Players on one site's ground for a stack. */
const STACK_MIN = 4;
/** A setup run by fewer rounds than this share (percent) of the baseline is unusual, not a default. */
const DEFAULT_SHARE = 10;
/** CT aggression counts until this many seconds (1:05). */
const PUSH_UNTIL = 50;
/** A cell is the Ts' ground when this share of the players seen in it were Ts. */
const T_GROUND = 0.75;
/** Rotations and retake entries this close together are one play. */
const GROUP_SECONDS = 10;
const TOGETHER_SECONDS = 5;
/** A save is read over the end of the round, never further back than this. */
const SAVE_SECONDS = 25;

const NADE_NAME = { 1: 'smoke', 2: 'molotov', 3: 'flash', 4: 'HE' };
const NADE_PLURAL = { smoke: 'smokes', molotov: 'molotovs', flash: 'flashes', HE: 'HEs' };

/** The round clock at `elapsed` seconds, as "1:23". */
export function clockOf(elapsed) {
  const s = Math.max(0, Math.round(ROUND_SECONDS - elapsed));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "1:23" -> seconds since the round went live, or null. */
export function elapsedOf(clock) {
  const m = /^(\d+):(\d{1,2})(?:\.\d)?$/.exec(String(clock || '').trim());
  return m ? ROUND_SECONDS - (Number(m[1]) * 60 + Number(m[2])) : null;
}

/** What each kind of play is, in a coach's words: what the eye is told when it gets one wrong. */
export const DEFINITIONS = {
  default: 'A default is the time before any commitment: players spread over the map taking control, no group heading for a site. It ends when 3+ players commit to one site.',
  execute: 'An execute is 3+ players going onto a site through one lane after 3+ grenades (smokes, molotovs, flashes) landed on that site in the 15 seconds before.',
  split: 'A split is 3+ players stepping onto a site from two or more lanes within 12 seconds of each other. A lurker or a player holding mid does not make a split.',
  rush: 'A rush is players on a site before 1:25, whatever utility they used.',
  contact: 'A contact hit is 2+ players onto a site with fewer than 3 grenades landing on it first: they walk up and take the fight.',
  lurk: 'A lurk is one T far from the hit (1,400+ units, in the other part of the map) while the others go in.',
  rotate: 'A rotation is players leaving one site for the other: for T, 3+ players moving from one site\'s ground to the other\'s before the hit; for CT, players leaving their own site before the plant.',
  postplant: 'A post-plant is where the Ts hold after planting: on the site, or off it in crossfires from the lanes.',
  save: 'A save is a side keeping its guns: alive at the end without playing for the round (no plant for T, staying off the planted site for CT).',
  setup: 'A setup is how the five CTs stand at 1:40, counted A-mid-B (2-1-2). It is a default when many rounds use the same one.',
  stack: 'A stack is 4+ CTs on one site\'s ground.',
  push: 'A push is 2+ CTs going into the Ts\' ground together before 1:05.',
  aggression: 'Aggression is one CT going into the Ts\' ground before 1:05.',
  retake: 'A retake is CTs going onto the planted site after the plant: together (within 5 seconds) or one by one.',
  opening: 'The opening is the first kill of the round.'
};

/** Plays whose kind is a hit on a site. */
export const HIT_KINDS = new Set(['execute', 'split', 'rush', 'contact']);
/** The family a kind belongs to, for partial credit when a guess has the right idea. */
export const FAMILY = {
  execute: 'hit',
  split: 'hit',
  rush: 'hit',
  contact: 'hit',
  default: 'default',
  setup: 'setup',
  stack: 'setup',
  push: 'push',
  aggression: 'push',
  rotate: 'rotate',
  retake: 'retake',
  postplant: 'postplant',
  save: 'save',
  lurk: 'lurk',
  opening: 'opening'
};
/** Kinds every guess is expected to find; the opening and one CT's aggression are details. */
const MAJOR = new Set(['default', 'execute', 'split', 'rush', 'contact', 'lurk', 'rotate', 'postplant', 'save', 'setup', 'stack', 'push', 'retake']);
export const KINDS = Object.keys(DEFINITIONS);

const round1 = (n) => Math.round(n * 10) / 10;
const other = (side) => (side === 'T' ? 'CT' : 'T');
const countWord = (n, word, plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;

// ---- the round, read once ---------------------------------------------------

function readRound(index, baseline) {
  const r0 = firstLiveRow(index);
  const rEnd = lastLiveRow(index);
  const placeMemo = new Map();
  const place = (x, y, z) => {
    const key = `${Math.round(x / 50)},${Math.round(y / 50)},${Math.round(z / 100)}`;
    let p = placeMemo.get(key);
    if (!p) placeMemo.set(key, (p = placeOf(baseline, x, y, z)));
    return p;
  };
  const rows = [];
  for (let r = r0; r <= rEnd; r++) {
    const e = rowElapsed(index, r);
    const at = { r, e, T: [], CT: [] };
    for (const side of ['T', 'CT']) for (const p of sideAt(index, r, side)) at[side].push({ ...p, place: place(p.x, p.y, p.z) });
    rows.push(at);
  }
  const sites = baseline.anchors.sites || {};
  const plantSite = index.plant ? nearestSite(sites, index.plant.x, index.plant.y, index.plant.z) : null;
  const econ = { T: econGroup(index.teams.T?.econ), CT: econGroup(index.teams.CT?.econ) };
  const nameOf = (slot) => index.names?.[slot] || index.ids?.[slot] || `player ${slot}`;
  const endE = rows.length ? rows[rows.length - 1].e : 0;
  return { index, baseline, rows, place, sites, plantSite, econ, nameOf, endE, plantT: index.plant ? index.plant.t : null };
}

function nearestSite(sites, x, y, z = 0) {
  let best = null;
  let bestD = Infinity;
  for (const s of ['A', 'B']) {
    if (!sites[s]) continue;
    const d = Math.hypot(x - sites[s].x, y - sites[s].y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (!x && !y) return null;
  return best;
}

const rowOf = (R, e) => R.rows.find((row) => row.e >= e - 0.01) || R.rows[R.rows.length - 1];

/** Kills in a window, from a side's point of view. */
function killsIn(R, side, from, to) {
  const code = side === 'T' ? 1 : 2;
  let forSide = 0;
  let against = 0;
  for (const k of R.index.kills || []) {
    if (k.t < from || k.t > to) continue;
    if (R.index.slotSide[k.v] === code) against++;
    else forSide++;
  }
  return { kills_for: forSide, kills_against: against };
}

/** What a play did: the side's win chance across it, the kills in it, and the round. */
function outcome(R, side, from, to) {
  const before = winAt(R.index, from, side);
  const after = to >= R.endE ? (wonBy(R.index, side) ? 100 : 0) : winAt(R.index, to, side);
  return {
    from: clockOf(from),
    to: clockOf(to),
    win_before: before == null ? null : Math.round(before),
    win_after: after == null ? null : Math.round(after),
    swing_pp: before == null || after == null ? null : Math.round(after - before),
    ...killsIn(R, side, from, to),
    round_won: wonBy(R.index, side)
  };
}

function groundCounts(players) {
  const c = { A: 0, mid: 0, B: 0 };
  for (const p of players) c[p.place.ground] += 1;
  return c;
}

/** A CT reads by the site he is near (within CT_NEAR site radii), else mid: lanes lean toward a site for the Ts, not for them. */
const CT_NEAR = 2.2;
function ctZone(R, p) {
  let best = 'mid';
  let bestD = Infinity;
  for (const s of ['A', 'B']) {
    const site = R.sites[s];
    if (!site) continue;
    const d = Math.hypot(p.x - site.x, p.y - site.y);
    if (d <= site.r * CT_NEAR && d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

function ctCounts(R, players) {
  const c = { A: 0, mid: 0, B: 0 };
  for (const p of players) c[ctZone(R, p)] += 1;
  return c;
}

const shapeText = (c) => [c.A && `${c.A} A`, c.mid && `${c.mid} mid`, c.B && `${c.B} B`].filter(Boolean).join(', ') || 'nobody alive';

function nadesOf(R, side, from, to, near = null, site = null) {
  const code = side === 'T' ? 1 : 2;
  return (R.index.nades || []).filter((n) => {
    if (n.side !== code || n.t < from || n.t > to) return false;
    if (!site) return true;
    const s = R.sites[site];
    return s && Math.hypot(n.x - s.x, n.y - s.y) <= s.r * (near ?? NEAR_SITE);
  });
}

function utilityCount(nades) {
  const out = {};
  for (const n of nades) {
    const k = NADE_NAME[n.kind];
    if (k) out[k] = (out[k] || 0) + 1;
  }
  return out;
}

export const utilityText = (u) =>
  Object.entries(u)
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${n === 1 ? k : NADE_PLURAL[k]}`)
    .join(', ');

// ---- T side -----------------------------------------------------------------

/** When each T first stood on a site, and where he came from. */
function siteEntries(R, site, until) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < R.rows.length; i++) {
    const row = R.rows[i];
    if (row.e > until) break;
    for (const p of row.T) {
      if (seen.has(p.slot) || p.place.site !== site) continue;
      seen.add(p.slot);
      let from = null;
      for (let k = i - 1; k >= 0 && row.e - R.rows[k].e <= LANE_BACK + 0.1; k--) {
        const q = R.rows[k].T.find((x) => x.slot === p.slot);
        if (q && q.place.site !== site && !q.place.spawn) from = q;
      }
      out.push({ slot: p.slot, e: row.e, i, from });
    }
  }
  return out.sort((a, b) => a.e - b.e);
}

function waveOf(entries) {
  for (let i = 0; i + 1 < entries.length; i++) {
    if (entries[i + 1].e - entries[i].e <= WAVE_SECONDS) {
      const start = entries[i].e;
      return entries.filter((x) => x.e >= start && x.e <= start + WAVE_SECONDS);
    }
  }
  return null;
}

function lanesOf(R, wave) {
  const lanes = [];
  for (const w of wave) {
    if (!w.from) continue;
    const lane = lanes.find((l) => Math.hypot(l.x - w.from.x, l.y - w.from.y) <= LANE_APART);
    if (lane) lane.slots.push(w.slot);
    else lanes.push({ x: w.from.x, y: w.from.y, name: w.from.place.name, slots: [w.slot] });
  }
  return lanes;
}

/** When the wave's players committed: the start of each one's last unbroken stretch on that site's ground. */
function commitStart(R, wave, site) {
  let start = Infinity;
  for (const w of wave) {
    let k = w.i;
    let gap = 0;
    while (k > 0) {
      const q = R.rows[k - 1].T.find((x) => x.slot === w.slot);
      if (q && (q.place.ground === site || q.place.site === site)) {
        gap = 0;
      } else if (++gap > 1) break;
      k--;
    }
    start = Math.min(start, R.rows[Math.min(w.i, k + gap)].e);
  }
  return Math.max(0, Math.max(start, wave[0].e - 25));
}

/** A hit that never reached the site: 3+ Ts on its ground together and 2+ of them dead within 15 s. */
function failedHit(R, until) {
  for (const row of R.rows) {
    if (row.e > until) break;
    if (row.e < 10) continue;
    for (const site of ['A', 'B']) {
      const on = row.T.filter((p) => p.place.ground === site && !p.place.spawn);
      if (on.length < 3) continue;
      const slots = new Set(on.map((p) => p.slot));
      const died = (R.index.kills || []).filter((k) => slots.has(k.v) && k.t >= row.e && k.t <= row.e + 15);
      if (died.length >= 2) return { site, e: row.e, slots: [...slots], reached: false };
    }
  }
  return null;
}

function tHit(R) {
  const until = R.plantT != null ? R.plantT + 2 : R.endE;
  const bySite = {};
  for (const site of ['A', 'B']) {
    if (!R.sites[site]) continue;
    const entries = siteEntries(R, site, until);
    const wave = waveOf(entries) || (R.plantSite === site && entries.length ? entries.slice(0, 1) : null);
    if (wave) bySite[site] = { site, wave, entries };
  }
  let pick = R.plantSite && bySite[R.plantSite] ? bySite[R.plantSite] : null;
  if (!pick) {
    const all = Object.values(bySite).sort((a, b) => a.wave[0].e - b.wave[0].e);
    pick = all[0] || null;
  }
  if (!pick) {
    const failed = failedHit(R, until);
    if (!failed) return null;
    const wave = failed.slots.map((slot) => ({ slot, e: failed.e, i: R.rows.findIndex((r) => r.e >= failed.e), from: null }));
    return describeHit(R, failed.site, wave, failed.e, false);
  }
  return describeHit(R, pick.site, pick.wave, pick.wave[0].e, true);
}

function describeHit(R, site, wave, waveAt, reached) {
  const start = reached ? commitStart(R, wave, site) : Math.max(0, waveAt - 10);
  const util = nadesOf(R, 'T', waveAt - UTIL_BEFORE, waveAt + UTIL_AFTER, NEAR_SITE, site).filter((n) => n.kind !== 4);
  const otherSite = other2(site);
  const fakeNades = R.sites[otherSite] ? nadesOf(R, 'T', waveAt - 40, waveAt - 8, NEAR_SITE, otherSite) : [];
  const lanes = reached ? lanesOf(R, wave) : [];
  let kind;
  if (lanes.length >= 2 && wave.length >= 3) kind = 'split';
  else if (waveAt <= RUSH_BY) kind = 'rush';
  else if (util.length >= 3) kind = 'execute';
  else kind = 'contact';
  const fake = fakeNades.length >= 2;
  const late = waveAt >= LATE_FROM;
  const planted = R.plantSite === site && R.plantT != null;
  const end = planted && R.plantT <= waveAt + 30 ? R.plantT + 2 : Math.min(R.endE, waveAt + 15);
  const label = `${site} ${kind}${kind === 'split' ? ` (${lanes.map((l) => l.name).join(' + ')})` : ''}${fake ? ` after a fake ${otherSite}` : ''}${late ? ', late' : ''}${reached ? '' : ', stopped before the site'}`;
  const utility = utilityCount(nadesOf(R, 'T', start - 5, waveAt + UTIL_AFTER, NEAR_SITE, site));
  return {
    side: 'T',
    kind,
    site,
    label,
    start,
    end,
    wave_at: waveAt,
    reached,
    players: wave.map((w) => w.slot),
    lanes: lanes.map((l) => ({ from: l.name, players: l.slots })),
    utility,
    fake,
    late,
    planted,
    planted_at: planted ? R.plantT : null,
    key: `${kind} ${site}`
  };
}

const other2 = (site) => (site === 'A' ? 'B' : 'A');

function tPlays(R) {
  const plays = [];
  const hit = tHit(R);
  const defaultEnd = hit ? hit.start : R.plantT ?? R.endE;
  if (defaultEnd >= DEFAULT_MIN) {
    // The shape three quarters of the way in (at most 0:45 in): set up, not yet moving.
    const mid = rowOf(R, 0.75 * Math.min(defaultEnd, 45));
    const shape = groundCounts(mid.T);
    plays.push({ side: 'T', kind: 'default', label: `default (${shapeText(shape)} at ${clockOf(mid.e)})`, start: 0, end: defaultEnd, shape, players: mid.T.map((p) => p.slot), key: 'default' });
  }
  if (hit) {
    plays.push(hit);
    // Lurk: a T not in the wave, far from it when it goes in.
    const at = rowOf(R, hit.wave_at);
    const inWave = new Set(hit.players);
    const wave = at.T.filter((p) => inWave.has(p.slot));
    // A lurk is one or two players away from a team's hit, not three players who did not go.
    const away = at.T.filter((p) => !inWave.has(p.slot));
    if (wave.length >= 2 && hit.players.length >= 3 && away.length <= 2) {
      const cx = wave.reduce((s, p) => s + p.x, 0) / wave.length;
      const cy = wave.reduce((s, p) => s + p.y, 0) / wave.length;
      for (const p of at.T) {
        if (inWave.has(p.slot) || p.place.ground === hit.site || p.place.site) continue;
        if (Math.hypot(p.x - cx, p.y - cy) < LURK_APART) continue;
        // Two players holding together are a group, not two lurks.
        if (away.some((q) => q.slot !== p.slot && Math.hypot(q.x - p.x, q.y - p.y) < LANE_APART)) continue;
        const start = hit.start;
        plays.push({ side: 'T', kind: 'lurk', label: `${R.nameOf(p.slot)} lurks ${p.place.name}`, start, end: Math.min(R.endE, hit.wave_at + 10), players: [p.slot], where: p.place.name, key: 'lurk' });
      }
    }
    // Rotation: 3+ on the other site's ground, then 3+ on the hit's, inside 30 s.
    const fromSite = other2(hit.site);
    let lastAway = null;
    for (const row of R.rows) {
      if (row.e > hit.wave_at) break;
      // Leaving spawn is not a rotation: count players out of it, once the round has started moving.
      if (row.e < 12) continue;
      const c = groundCounts(row.T.filter((p) => !p.place.spawn));
      if (c[fromSite] >= 3) lastAway = row;
      else if (lastAway && c[hit.site] >= 3 && row.e - lastAway.e <= 30) {
        plays.push({ side: 'T', kind: 'rotate', label: `rotate from ${fromSite} to ${hit.site}`, start: lastAway.e, end: row.e + 5, from: fromSite, to: hit.site, players: row.T.filter((p) => p.place.ground === hit.site).map((p) => p.slot), key: 'rotate' });
        break;
      }
    }
  }
  if (R.plantT != null && R.plantSite) {
    const at = rowOf(R, R.plantT + 6);
    const on = at.T.filter((p) => p.place.site === R.plantSite).length;
    const off = at.T.length - on;
    plays.push({
      side: 'T',
      kind: 'postplant',
      label: `post-plant on ${R.plantSite}: ${on} on the site, ${off} off it`,
      start: R.plantT,
      end: R.endE,
      on_site: on,
      off_site: off,
      players: at.T.map((p) => p.slot),
      key: `postplant ${on >= off ? 'on site' : 'off site'}`
    });
  }
  const save = savePlay(R, 'T');
  if (save) plays.push(save);
  return plays;
}

// ---- CT side ----------------------------------------------------------------

function ctPlays(R, tHitPlay) {
  const plays = [];
  const limit = tHitPlay ? tHitPlay.start : R.plantT ?? R.endE;
  const at = rowOf(R, SETUP_AT);
  const shape = ctCounts(R, at.CT);
  const setupKey = `setup ${shape.A}-${shape.mid}-${shape.B}`;
  // A stack holds: STACK_MIN on one site in two readings in a row, once the CTs have set up.
  let stack = null;
  let prev = null;
  for (const row of R.rows) {
    if (row.e < 12 || row.e > Math.min(limit, 50)) continue;
    const c = ctCounts(R, row.CT);
    for (const site of ['A', 'B']) if (c[site] >= STACK_MIN && prev?.[site] >= STACK_MIN && !stack) stack = { site, row, n: c[site] };
    prev = c;
  }
  if (stack) {
    plays.push({ side: 'CT', kind: 'stack', site: stack.site, label: `stack ${stack.site} (${stack.n})`, start: stack.row.e, end: Math.min(R.endE, Math.max(stack.row.e + 15, limit)), players: stack.row.CT.filter((p) => ctZone(R, p) === stack.site).map((p) => p.slot), key: `stack ${stack.site}` });
  } else if (at.CT.length) {
    plays.push({ side: 'CT', kind: 'setup', label: `setup ${shape.A}-${shape.mid}-${shape.B} (A-mid-B)`, start: 0, end: Math.min(R.endE, Math.max(SETUP_AT + 10, Math.min(limit, 45))), shape, players: at.CT.map((p) => p.slot), key: setupKey });
  }

  // Aggression: CTs in the Ts' ground early. Grouped into a push when two go within 10 s.
  const cells = R.baseline.cells || {};
  const tTotal = Object.values(cells).reduce((s, c) => s + c[2], 0) || 1;
  const ctTotal = Object.values(cells).reduce((s, c) => s + c[3], 0) || 1;
  const a = R.baseline.anchors;
  const tGround = (p) => {
    // Only the Ts' half of the map: nearer their spawn than the CTs'.
    if (a.tSpawn && a.ctSpawn && Math.hypot(p.x - a.tSpawn[0], p.y - a.tSpawn[1]) >= Math.hypot(p.x - a.ctSpawn[0], p.y - a.ctSpawn[1])) return false;
    const c = cells[p.place.cell];
    if (c && c[2] + c[3] >= 8) {
      const t = c[2] / tTotal;
      const ct = c[3] / ctTotal;
      return t / (t + ct) >= T_GROUND;
    }
    if (!a.tSpawn || !a.ctSpawn) return false;
    return Math.hypot(p.x - a.tSpawn[0], p.y - a.tSpawn[1]) < 0.6 * Math.hypot(p.x - a.ctSpawn[0], p.y - a.ctSpawn[1]);
  };
  const forward = [];
  const seen = new Set();
  for (const row of R.rows) {
    if (row.e > Math.min(PUSH_UNTIL, limit)) break;
    for (const p of row.CT) {
      if (seen.has(p.slot) || p.place.site || !tGround(p)) continue;
      // Two rows in a row: a step round a corner is not a push.
      const next = R.rows[R.rows.indexOf(row) + 1]?.CT.find((q) => q.slot === p.slot);
      if (!next || !tGround(next)) continue;
      seen.add(p.slot);
      forward.push({ slot: p.slot, e: row.e, where: p.place.name });
    }
  }
  for (const group of groupBy(forward, GROUP_SECONDS)) {
    const start = group[0].e;
    if (group.length >= 2) {
      plays.push({ side: 'CT', kind: 'push', label: `push ${group[0].where} (${group.length})`, start, end: Math.min(R.endE, start + 10), players: group.map((g) => g.slot), where: group[0].where, key: 'push' });
    } else {
      plays.push({ side: 'CT', kind: 'aggression', label: `${R.nameOf(group[0].slot)} pushes ${group[0].where}`, start, end: Math.min(R.endE, start + 10), players: [group[0].slot], where: group[0].where, key: 'aggression' });
    }
  }

  // Rotations: a CT whose site at 1:40 was one site, later on the other's ground, before the plant (or just after).
  const home = new Map(at.CT.filter((p) => ctZone(R, p) !== 'mid').map((p) => [p.slot, ctZone(R, p)]));
  const rotations = [];
  const rotateUntil = R.plantT != null ? R.plantT + 5 : R.endE;
  for (const row of R.rows) {
    if (row.e <= SETUP_AT || row.e > rotateUntil) continue;
    for (const p of row.CT) {
      const h = home.get(p.slot);
      const z = ctZone(R, p);
      if (!h || z === h || z === 'mid') continue;
      home.delete(p.slot);
      rotations.push({ slot: p.slot, e: row.e, from: h, to: z });
    }
  }
  for (const group of groupBy(rotations, GROUP_SECONDS)) {
    const start = group[0].e;
    const wave = tHitPlay?.wave_at;
    const when = wave == null ? '' : start < wave ? ', before the hit' : ', after the hit';
    plays.push({
      side: 'CT',
      kind: 'rotate',
      label: `rotate ${group[0].from} to ${group[0].to} (${group.length})${when}`,
      start,
      end: Math.min(R.endE, start + 10),
      from: group[0].from,
      to: group[0].to,
      early: wave != null && start < wave,
      players: group.map((g) => g.slot),
      key: 'rotate'
    });
  }

  // Retake: CTs stepping onto the planted site after the plant.
  if (R.plantT != null && R.plantSite) {
    const entries = [];
    const there = new Set(rowOf(R, R.plantT).CT.filter((p) => p.place.site === R.plantSite).map((p) => p.slot));
    for (const row of R.rows) {
      if (row.e <= R.plantT) continue;
      for (const p of row.CT) {
        if (there.has(p.slot) || p.place.site !== R.plantSite) continue;
        there.add(p.slot);
        entries.push({ slot: p.slot, e: row.e });
      }
    }
    if (entries.length) {
      const together = entries.length >= 2 && entries[1].e - entries[0].e <= TOGETHER_SECONDS;
      const defused = R.index.defuse != null;
      plays.push({
        side: 'CT',
        kind: 'retake',
        site: R.plantSite,
        label: `retake ${R.plantSite} ${together ? 'together' : 'one by one'}${defused ? ', defused' : ''}`,
        start: Math.max(R.plantT, entries[0].e - 5),
        end: R.index.defuse ?? R.endE,
        together,
        players: entries.map((x) => x.slot),
        key: `retake ${together ? 'together' : 'one by one'}`
      });
    }
  }
  const save = savePlay(R, 'CT');
  if (save) plays.push(save);
  return plays;
}

function groupBy(list, seconds) {
  const out = [];
  for (const x of [...list].sort((a, b) => a.e - b.e)) {
    const last = out[out.length - 1];
    if (last && x.e - last[0].e <= seconds && last[0].from === x.from && last[0].to === x.to) last.push(x);
    else out.push([x]);
  }
  return out;
}

/** A side alive at the end of a round it lost, without playing for it. */
function savePlay(R, side) {
  if (wonBy(R.index, side) || !R.rows.length) return null;
  const last = R.rows[R.rows.length - 1];
  const alive = last[side];
  if (!alive.length) return null;
  if (side === 'T' && R.plantT != null) return null;
  if (side === 'CT' && (R.plantT == null || R.index.defuse != null)) return null;
  // Off the sites at the end (T), or off the planted site (CT).
  const away = alive.filter((p) => (side === 'T' ? !p.place.site : p.place.site !== R.plantSite));
  if (!away.length) return null;
  // From when the side's chance had gone (under 20%) for good, or the last 15 s.
  // From when the side's chance had gone (under 20%) for good, at most the last SAVE_SECONDS.
  let start = Math.max(0, R.endE - 15);
  for (let i = R.rows.length - 1; i >= 0 && R.rows[i].e >= R.endE - SAVE_SECONDS; i--) {
    const w = winAt(R.index, R.rows[i].e, side);
    if (w == null || w >= 20) break;
    start = R.rows[i].e;
  }
  return { side, kind: 'save', label: `save (${away.map((p) => R.nameOf(p.slot)).join(', ')})`, start, end: R.endE, players: away.map((p) => p.slot), key: 'save' };
}

function openingPlay(R) {
  const k = (R.index.kills || [])[0];
  if (!k || k.a < 0) return null;
  const killerSide = R.index.slotSide[k.a] === 1 ? 'T' : 'CT';
  const r = rowAt(R.index, k.t);
  const pos = livePos(R.index, Math.max(0, r - 1), k.v) || livePos(R.index, r, k.v);
  const where = pos ? R.place(pos.x, pos.y, pos.z).name : '';
  return {
    side: killerSide,
    kind: 'opening',
    label: `opening kill: ${R.nameOf(k.a)} on ${R.nameOf(k.v)}${where ? ` at ${where}` : ''}`,
    start: Math.max(0, k.t - 3),
    end: Math.min(R.endE, k.t + 2),
    players: [k.a],
    victim: k.v,
    where,
    key: 'opening'
  };
}

// ---- the round's plays ------------------------------------------------------

/**
 * Every play in a round, in clock order, each measured.
 *
 * @param {object} index     a Similar Rounds index (INDEX_VERSION 2+)
 * @param {object} baseline  the map's baseline (playMap.js learnBaseline)
 * @returns {{ plays: object[], econ: { T: string, CT: string }, plantSite: string|null }}
 */
export function findPlays(index, baseline) {
  if (!index || !baseline?.anchors) return { plays: [], econ: {}, plantSite: null };
  const R = readRound(index, baseline);
  if (!R.rows.length) return { plays: [], econ: R.econ, plantSite: null };
  const t = tPlays(R);
  const hit = t.find((p) => HIT_KINDS.has(p.kind)) || null;
  const ct = ctPlays(R, hit);
  const opening = openingPlay(R);
  const all = [...t, ...ct, ...(opening ? [opening] : [])].sort((a, b) => a.start - b.start || (a.side === 'T' ? -1 : 1));
  const n = { T: 0, CT: 0 };
  const plays = all.map((p) => finishPlay(R, p, `${p.side}${++n[p.side]}`));
  return { plays, econ: R.econ, plantSite: R.plantSite, R };
}

function finishPlay(R, p, id) {
  const freq = playFrequency(R.baseline, p.side, R.econ[p.side], p.key);
  let isDefault = false;
  let shapePct = null;
  if (p.kind === 'default') {
    // How far from the usual default the shape was, through the phase.
    const pcts = [];
    for (let at = 5; at <= p.end; at += 10) {
      if (at < p.start) continue;
      const row = rowOf(R, at);
      const s = shapeSurprise(R.baseline, R.index, row.r, 'T', R.econ.T);
      const pct = surprisePercentile(R.baseline, 'T', R.econ.T, row.e, s.mean);
      if (pct != null) pcts.push(pct);
    }
    shapePct = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
    isDefault = true;
  } else if (p.kind === 'setup') {
    isDefault = !freq || freq.pct >= DEFAULT_SHARE;
  }
  const out = {
    id,
    side: p.side,
    kind: p.kind,
    label: p.label,
    default: isDefault,
    start: round1(p.start),
    end: round1(Math.max(p.start, p.end)),
    clock: clockOf(p.start),
    players: (p.players || []).map((s) => R.nameOf(s)),
    outcome: outcome(R, p.side, p.start, Math.max(p.start, p.end))
  };
  if (p.site) out.site = p.site;
  if (p.wave_at != null && p.reached !== false) out.on_site_at = clockOf(p.wave_at);
  if (p.utility && Object.keys(p.utility).length) out.utility = p.utility;
  if (p.lanes?.length > 1) out.lanes = p.lanes.map((l) => ({ from: l.from, players: l.players.map((s) => R.nameOf(s)) }));
  if (p.fake) out.fake = true;
  if (p.reached === false) out.reached_site = false;
  if (p.planted) out.planted_at = clockOf(p.planted_at);
  if (p.where) out.where = p.where;
  if (p.kind === 'rotate') Object.assign(out, { from: p.from, to: p.to });
  if (shapePct != null) out.shape_unusual_pct = shapePct;
  if (freq && p.kind !== 'opening') out.usual = `${freq.pct}% of ${R.econ[p.side] ? ECON_WORD[R.econ[p.side]] : 'rounds'} on this map, ${freq.count} of ${freq.rounds}`;
  // Internals the review reads; dropped before the model sees a play.
  Object.defineProperty(out, 'raw', { value: { ...p }, enumerable: false });
  return out;
}

/** The plays of a round as baseline frequency keys (playMap.js learnBaseline playsOf). */
export function playKeys(index, baseline) {
  return findPlays(index, baseline).plays.filter((p) => p.kind !== 'opening').map((p) => ({ side: p.side, key: p.raw.key }));
}

// ---- in plain words ---------------------------------------------------------

/**
 * The round in simple terms: one line per side, then how it ended. Built from
 * the plays only, so every clock and count in it is in the plays.
 */
export function summarize(index, plays, { teamNames = true } = {}) {
  const lines = [];
  for (const side of ['T', 'CT']) {
    const team = index.teams?.[side]?.name;
    const econ = econGroup(index.teams?.[side]?.econ);
    const head = `${side}${teamNames && team ? ` (${team})` : ''}, ${ECON_WORD[econ]?.replace(/s$/, '').replace(/ and force buys$/, ' or force buy') || 'buy'}:`;
    const parts = [];
    for (const p of plays.filter((x) => x.side === side && x.kind !== 'opening')) parts.push(playSentence(p));
    lines.push(`${head} ${parts.length ? parts.join('; then ') : 'nothing the plays could read'}.`);
  }
  const opening = plays.find((p) => p.kind === 'opening');
  if (opening) lines.push(`Opening: ${opening.label.replace(/^opening kill: /, '')} at ${opening.clock}.`);
  const winner = index.winnerSide;
  if (winner) lines.push(`${winner} won the round${index.plant ? (index.defuse != null ? ' with the defuse' : winner === 'T' ? ' after the plant' : '') : ''}.`);
  return lines.join('\n');
}

function playSentence(p) {
  const kind = p.kind;
  const util = p.utility ? utilityText(p.utility) : '';
  if (kind === 'default') return `a default until ${clockOf(p.end)} (${p.label.replace(/^default \(|\)$/g, '')})`;
  if (HIT_KINDS.has(kind)) {
    const bits = [`${/^[AE]/.test(p.label) ? 'an' : 'a'} ${p.label} from ${p.clock}`];
    if (p.on_site_at) bits.push(`on the site at ${p.on_site_at}`);
    if (util) bits.push(`with ${util}`);
    if (p.planted_at) bits.push(`planted at ${p.planted_at}`);
    return bits.join(', ');
  }
  if (kind === 'setup') return `${p.label}${p.default ? ', a common one on this map' : ', an uncommon one on this map'}`;
  return `${p.label} at ${p.clock}`;
}

// ---- checking a guess -------------------------------------------------------

/**
 * Grade a guess of a round's plays against what the round shows.
 *
 * A guess is a list of { side, kind, site?, clock? }. A guess earns 1 for the
 * right kind (and site, when the play has one) within 15 s of the play's
 * start, 0.5 for the right family ("execute" for a contact hit), half again
 * when the clock is off by more than that. The score is F1 over the major
 * plays (an opening kill or one CT's aggression is not required).
 *
 * @returns {{ score: number, right: object[], wrong: object[], missed: object[] }}
 */
export function checkGuess(guess, plays) {
  const items = (Array.isArray(guess) ? guess : [])
    .map((g) => ({
      side: String(g?.side || '').toUpperCase() === 'CT' ? 'CT' : String(g?.side || '').toUpperCase() === 'T' ? 'T' : '',
      kind: String(g?.kind || '').toLowerCase().trim(),
      site: g?.site ? String(g.site).toUpperCase().trim() : '',
      clock: g?.clock ? String(g.clock) : ''
    }))
    .filter((g) => g.side && g.kind);
  const required = plays.filter((p) => MAJOR.has(p.kind));
  const taken = new Map();
  const right = [];
  const wrong = [];
  for (const g of items) {
    let best = null;
    for (const p of plays) {
      if (p.side !== g.side) continue;
      let credit = p.kind === g.kind ? 1 : FAMILY[p.kind] && FAMILY[p.kind] === FAMILY[g.kind] ? 0.5 : 0;
      if (!credit) continue;
      if (g.site && p.site && g.site !== p.site) continue;
      const ge = elapsedOf(g.clock);
      if (ge != null && Math.abs(ge - p.start) > 15 && !(ge >= p.start && ge <= p.end)) credit *= 0.5;
      // A play another guess already earned as much on is not this guess's to take.
      if ((taken.get(p.id) || 0) >= credit) continue;
      if (!best || credit > best.credit) best = { p, credit };
    }
    if (best && (taken.get(best.p.id) || 0) < best.credit) {
      taken.set(best.p.id, best.credit);
      right.push({ guess: g, play: best.p.id, label: best.p.label, credit: best.credit });
    } else {
      const sameSide = plays.filter((p) => p.side === g.side && MAJOR.has(p.kind)).map((p) => p.label);
      wrong.push({ guess: g, why: best ? 'already matched by another guess' : `no ${g.side} ${g.kind}${g.site ? ` on ${g.site}` : ''} in this round${sameSide.length ? ` (${g.side} played: ${sameSide.join('; ')})` : ''}` });
    }
  }
  const got = required.reduce((s, p) => s + (taken.get(p.id) || 0), 0);
  const recall = required.length ? got / required.length : 1;
  const credit = right.reduce((s, r) => s + r.credit, 0);
  const precision = items.length ? credit / items.length : required.length ? 0 : 1;
  const score = recall + precision ? Math.round(((2 * recall * precision) / (recall + precision)) * 100) : 0;
  const missed = required.filter((p) => !taken.get(p.id)).map((p) => ({ play: p.id, side: p.side, kind: p.kind, label: p.label, clock: p.clock }));
  return { score, right, wrong, missed };
}

/** A play as the model reads it: the internals dropped. */
export const publicPlay = (p) => JSON.parse(JSON.stringify(p));

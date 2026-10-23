// ---------------------------------------------------------------------------
// replays/similar/roundSimilarity.js
// Similar Rounds: how alike two rounds are at one moment on the clock.
//
// A round is reduced once to an index (positions every 100 ticks, weapons,
// utility, who died when, and how its win chance moved), and a question is
// asked of that index: "at 1:12, did this side stand where we stood, holding
// what we held, having thrown what we threw?" The index does not depend on
// the question, which is what lets the desktop app keep it and answer the
// next question, at another time or for the other side, without downloading
// the map again.
//
// Similarity is a percentage between the round on screen and one other
// round, so results read against each other: 80% is closer than 60%, and
// both say how close in the same units.
//
//   positions   each player's last ten seconds of movement, paired with the
//               closest player on the other round (an optimal assignment, so
//               two players in one spot cannot both claim the same match)
//   weapons     the pair counts for less when the guns differ (an AWP is not
//               a rifle; a rifle is closer to a scout than to a pistol)
//   utility     grenades of the same kind landing in the same place, at the
//               same time, over the last thirty seconds
//   drawing     strokes on the map: a path some player walked, or a spot a
//               player stood on at the time
//
// Dominance is how little the side's win chance fell during the round. Every
// drop counts against it and nothing else does: starting at 50%, dipping to
// 40% and winning is 90; starting at 5% and climbing to a win is 100.
//
// DOM-free: the desktop app's server scans with it (server/similar), and the
// tests drive it directly.
// ---------------------------------------------------------------------------

import { readHeader, readRecord } from '../shared/tickFormat.js';
import { buyBucket } from '../shared/roundId.js';
import { WEAPONS, weaponInfo } from '../shared/weaponTable.js';
import { roundWinAtTick } from '../rounds/roundWinAdapter.js';
import { phaseBounds } from '../coach/roundPhases.js';
import { timingFor } from '../viewer/roundClock.js';

/**
 * Ticks between rows of the index. The server keeps exactly one thinned pass
 * per round, the coarse `.c100.bin` the timeline reads first, and serves it
 * as a plain file read; any other stride is a full decode per round.
 */
export const SCAN_STRIDE = 100;

/** Bumped when the index layout changes, so a kept index is rebuilt. */
export const INDEX_VERSION = 1;

/**
 * Economy classes a scan stays inside. Full buy covers both stored digits
 * (4 and 5, with and without an AWP).
 */
export const ECON_CLASSES = ['pistol', 'eco', 'half', 'force', 'full'];
const ECON_LABELS = { pistol: 'Pistol', eco: 'Eco', half: 'Half buy', force: 'Force buy', full: 'Full buy' };

export function econClass(code) {
  return ECON_CLASSES[buyBucket(code)] || '';
}

export function econLabel(cls) {
  return ECON_LABELS[cls] || '';
}

/** The stored buy bucket for a class, for a filename query (0-4). */
export function econBucket(cls) {
  const i = ECON_CLASSES.indexOf(cls);
  return i < 0 ? null : i;
}

// ---- weapons ----------------------------------------------------------------

const W_NONE = 0;
const W_PISTOL = 1;
const W_SMG = 2;
const W_HEAVY = 3;
const W_RIFLE = 4;
const W_SCOUT = 5;
const W_AWP = 6;

/** Primary-ness, low to high: a player's class is the best gun he has. */
export function weaponClass(name) {
  const info = weaponInfo(name);
  // Unknown names fall back to a pistol's stats; grenades, the bomb and the
  // like are not guns at all.
  if (!WEAPONS[info.id]) return W_NONE;
  switch (info.category) {
    case 'pistol':
      return W_PISTOL;
    case 'smg':
      return W_SMG;
    case 'shotgun':
    case 'lmg':
      return W_HEAVY;
    case 'rifle':
      return W_RIFLE;
    case 'sniper':
      return info.id === 'ssg08' ? W_SCOUT : W_AWP;
    default:
      return W_NONE;
  }
}

/**
 * How alike two guns are, 0-1. Symmetric. An unknown gun on either side is
 * neutral rather than a mismatch: a stub round with no weapon data should
 * not lose to one that has it.
 */
const W_SIM = [
  //        none  P     S     H     R     Sc    A
  /*none*/ [1, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7],
  /* P  */ [0.7, 1, 0.6, 0.6, 0.35, 0.45, 0.25],
  /* S  */ [0.7, 0.6, 1, 0.8, 0.6, 0.5, 0.35],
  /* H  */ [0.7, 0.6, 0.8, 1, 0.55, 0.45, 0.35],
  /* R  */ [0.7, 0.35, 0.6, 0.55, 1, 0.7, 0.5],
  /* Sc */ [0.7, 0.45, 0.5, 0.45, 0.7, 1, 0.6],
  /* A  */ [0.7, 0.25, 0.35, 0.35, 0.5, 0.6, 1]
];

// ---- utility ----------------------------------------------------------------

const NADE_KIND = {
  smokegrenade: 1,
  smoke_grenade: 1,
  molotov: 2,
  incgrenade: 2,
  incendiary_grenade: 2,
  firebomb: 2,
  inferno: 2,
  flashbang: 3,
  hegrenade: 4,
  high_explosive_grenade: 4
};

function nadeKind(type) {
  const t = String(type || '')
    .toLowerCase()
    .replace(/^weapon_/, '');
  return NADE_KIND[t] || 0;
}

// ---- sides ------------------------------------------------------------------

const SIDE_CODE = { T: 1, CT: 2 };

function teamSides(meta) {
  const team1 = meta.team1Side === 'CT' ? 'CT' : 'T';
  return { 1: team1, 2: team1 === 'T' ? 'CT' : 'T' };
}

// ---- dominance --------------------------------------------------------------

/**
 * Total fall of a win-chance series, ignoring wobble smaller than `eps`
 * points. A slow bleed (the clock running down on a T side that is not
 * moving) is a real fall and adds up; noise that comes straight back does
 * not.
 *
 * @param {ArrayLike<number>} series  0-100, the side's own win chance
 * @returns {{ dominance: number, drop: number, start: number, end: number }}
 */
export function dominanceOf(series, eps = 1) {
  const n = series?.length || 0;
  if (!n) return { dominance: 0, drop: 0, start: 0, end: 0 };
  let anchor = series[0];
  let drop = 0;
  for (let i = 1; i < n; i++) {
    const v = series[i];
    if (v < anchor - eps) {
      drop += anchor - v;
      anchor = v;
    } else if (v > anchor + eps) {
      anchor = v;
    }
  }
  return {
    dominance: Math.max(0, Math.round(100 - drop)),
    drop: Math.round(drop),
    start: Math.round(series[0]),
    end: Math.round(series[n - 1])
  };
}

/**
 * The T side's win chance at every row from freeze end to the round's end,
 * then the result. Bodies, money, utility, the clock and the bomb: the round
 * model without map geometry, which needs nothing but what the index is
 * built from and is the same for every round it is asked about.
 */
function tWinSeries(meta, view, header, timing) {
  const bounds = phaseBounds(meta);
  const states = Array.from({ length: header.slots || 10 }, () => ({}));
  const out = [];
  for (let r = 0; r < header.tickCount; r++) {
    const tick = header.firstTick + r * header.stride;
    if (tick < timing.freezeEndTick) continue;
    if (tick >= timing.endTick) break;
    for (let s = 0; s < states.length; s++) readRecord(view, r, s, states[s]);
    const w = roundWinAtTick({ meta, states, tick, bounds });
    if (w && Number.isFinite(w.t)) out.push(w.t);
  }
  const winner = meta.winnerSide || teamSides(meta)[meta.winner === 2 ? 2 : 1];
  out.push(winner === 'T' ? 100 : 0);
  return out;
}

// ---- the index --------------------------------------------------------------

function asView(buffer) {
  if (buffer instanceof DataView) return buffer;
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * Everything a scan reads from one round, independent of what it asks.
 *
 * @param {object} meta     the round's meta (the `similar` projection is enough)
 * @param {ArrayBuffer|Uint8Array} ticks  a SCAN_STRIDE tick buffer
 * @param {string} [file]   the round file, when it differs from meta.id
 */
export function buildRoundIndex(meta, ticks, file = '') {
  if (!meta || !ticks) return null;
  const view = asView(ticks);
  const header = readHeader(view);
  const slots = Math.min(10, header.slots || 10);
  const rows = header.tickCount;
  const timing = timingFor(meta);
  const sides = teamSides(meta);

  const ids = new Array(slots).fill('');
  const slotSide = new Int8Array(slots);
  const slotOf = new Map();
  const teamOf = new Map();
  for (const p of meta.players || []) {
    if (!Number.isInteger(p.slot) || p.slot < 0 || p.slot >= slots) continue;
    ids[p.slot] = p.id;
    slotSide[p.slot] = SIDE_CODE[sides[p.team]] || 0;
    slotOf.set(p.id, p.slot);
    teamOf.set(p.id, p.team);
  }

  // Positions, life, and the best gun seen so far. A gun is "had" from the
  // round-start loadout or from being held at any row up to now, whichever
  // is better: the scan's 1.5 s rows miss most weapon switches, the loadout
  // misses pickups.
  const loadoutClass = new Uint8Array(slots);
  for (let s = 0; s < slots; s++) {
    for (const item of meta.stats?.[ids[s]]?.loadout || []) {
      loadoutClass[s] = Math.max(loadoutClass[s], weaponClass(item));
    }
  }
  const dictClass = (meta.weapons || []).map((w) => weaponClass(w));

  const px = new Int16Array(rows * slots);
  const py = new Int16Array(rows * slots);
  const pz = new Int16Array(rows * slots);
  const alive = new Uint8Array(rows * slots);
  const gun = new Uint8Array(rows * slots);
  const rec = {};
  const best = Uint8Array.from(loadoutClass);
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < slots; s++) {
      readRecord(view, r, s, rec);
      const i = r * slots + s;
      px[i] = Math.round(rec.x);
      py[i] = Math.round(rec.y);
      pz[i] = Math.round(rec.z);
      alive[i] = rec.alive ? 1 : 0;
      if (rec.alive) best[s] = Math.max(best[s], dictClass[rec.weapon] || 0);
      gun[i] = best[s];
    }
  }

  // Deaths at their exact tick: a row is 1.5 s, and a kill inside it decides
  // whether that player is still part of the picture at the asked moment.
  const death = new Int32Array(slots).fill(-1);
  for (const k of meta.events?.kills || []) {
    const s = slotOf.get(k.victim);
    if (s === undefined || death[s] >= 0) continue;
    death[s] = Number(k.tick) || 0;
  }

  const rate = timing.tickRate || 64;
  const nades = [];
  for (const g of meta.events?.grenades || []) {
    const kind = nadeKind(g.type);
    const team = teamOf.get(g.player);
    const at = g.at;
    if (!kind || !team || !at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
    const tick = Number(g.detonateTick ?? g.throwTick);
    if (!Number.isFinite(tick)) continue;
    nades.push({
      kind,
      side: SIDE_CODE[sides[team]],
      x: Math.round(at.x),
      y: Math.round(at.y),
      z: Math.round(at.z || 0),
      t: Math.round(((tick - timing.freezeEndTick) / rate) * 10) / 10
    });
  }

  const series = tWinSeries(meta, view, header, timing);
  const domT = dominanceOf(series);
  const domCt = dominanceOf(series.map((v) => 100 - v));

  const teamBySide = {};
  for (const team of [1, 2]) {
    const side = sides[team];
    const info = meta[`team${team}`] || {};
    teamBySide[side] = {
      id: String(info.id || ''),
      name: String(info.name || info.id || ''),
      econ: Number(meta[`econ${team}`])
    };
  }

  return {
    v: INDEX_VERSION,
    file: file || meta.id || '',
    map: meta.map || '',
    round: Number(meta.round) || 0,
    tickRate: rate,
    firstTick: header.firstTick,
    stride: Math.max(1, header.stride),
    rows,
    slots,
    freezeEndTick: timing.freezeEndTick,
    endTick: timing.endTick,
    winnerSide: meta.winnerSide || sides[meta.winner === 2 ? 2 : 1],
    teams: teamBySide,
    ids,
    slotSide,
    px,
    py,
    pz,
    alive,
    gun,
    death,
    nades,
    win: Uint8Array.from(series, (v) => Math.round(v)),
    dominance: { T: domT, CT: domCt }
  };
}

/** Rough resident size, for a cache budget. */
export function indexBytes(index) {
  if (!index) return 0;
  const typed = ['px', 'py', 'pz', 'alive', 'gun', 'death', 'slotSide', 'win'];
  let n = 512 + (index.nades?.length || 0) * 64;
  for (const k of typed) n += index[k]?.byteLength || 0;
  return n;
}

// ---- reading the index at a moment -----------------------------------------

function tickAt(index, elapsed) {
  return index.freezeEndTick + elapsed * index.tickRate;
}

/** Where a slot stood at a tick, between the two rows around it, or null. */
function positionAt(index, slot, tick) {
  if (index.death[slot] >= 0 && index.death[slot] <= tick) return null;
  const f = (tick - index.firstTick) / index.stride;
  const r0 = Math.max(0, Math.min(index.rows - 1, Math.floor(f)));
  const r1 = Math.min(index.rows - 1, r0 + 1);
  const a = Math.max(0, Math.min(1, f - r0));
  const i0 = r0 * index.slots + slot;
  const i1 = r1 * index.slots + slot;
  const ok0 = index.alive[i0] === 1;
  const ok1 = index.alive[i1] === 1;
  if (!ok0 && !ok1) return null;
  if (ok0 && ok1) {
    return {
      x: index.px[i0] + (index.px[i1] - index.px[i0]) * a,
      y: index.py[i0] + (index.py[i1] - index.py[i0]) * a,
      z: index.pz[i0] + (index.pz[i1] - index.pz[i0]) * a,
      gun: a < 0.5 ? index.gun[i0] : index.gun[i1]
    };
  }
  const i = ok0 ? i0 : i1;
  return { x: index.px[i], y: index.py[i], z: index.pz[i], gun: index.gun[i] };
}

/** Seconds back from the asked moment that a player's position is read at. */
const TRAJ_BACK = [10, 5, 0];
const TRAJ_WEIGHT = [0.2, 0.3, 0.5];

/** One side's living players at `elapsed`, each with where he came from. */
function sidePlayersAt(index, side, elapsed) {
  const code = SIDE_CODE[side];
  const now = tickAt(index, elapsed);
  const out = [];
  for (let s = 0; s < index.slots; s++) {
    if (index.slotSide[s] !== code) continue;
    const here = positionAt(index, s, now);
    if (!here) continue;
    const traj = TRAJ_BACK.map((back) => {
      if (!back) return here;
      return positionAt(index, s, tickAt(index, Math.max(0, elapsed - back))) || here;
    });
    out.push({ slot: s, gun: here.gun, traj });
  }
  return out.slice(0, 5);
}

/** Grenades a side threw that landed in the window before the moment. */
const UTIL_WINDOW = 30;

function sideNadesAt(index, side, elapsed) {
  const code = SIDE_CODE[side];
  return index.nades.filter((n) => n.side === code && n.t <= elapsed && n.t >= elapsed - UTIL_WINDOW);
}

// ---- matching ---------------------------------------------------------------

/** Players further apart than this have little to do with each other. */
const POS_SIGMA = 480;
const NADE_SIGMA = 350;
const NADE_TIME_SIGMA = 8;
const PATH_SIGMA = 260;
const SPOT_SIGMA = 320;

const gauss = (d, sigma) => Math.exp(-((d / sigma) * (d / sigma)));

function dist3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  // Floors on Nuke are 400 units apart at the same x/y.
  const dz = (a.z - b.z) * 1.5;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function pairScore(q, c) {
  let pos = 0;
  for (let k = 0; k < TRAJ_WEIGHT.length; k++) {
    pos += TRAJ_WEIGHT[k] * gauss(dist3(q.traj[k], c.traj[k]), POS_SIGMA);
  }
  const w = W_SIM[q.gun]?.[c.gun] ?? 0.7;
  return pos * (0.65 + 0.35 * w);
}

/**
 * Best total of a one-to-one pairing between two small sets (at most five
 * a side), by DP over which of `b` are taken. Unpaired members score zero.
 */
export function bestAssignment(scores, n, m) {
  if (!n || !m) return 0;
  const full = 1 << m;
  let prev = new Float64Array(full).fill(-1);
  prev[0] = 0;
  for (let i = 0; i < n; i++) {
    const next = Float64Array.from(prev);
    for (let mask = 0; mask < full; mask++) {
      const base = prev[mask];
      if (base < 0) continue;
      for (let j = 0; j < m; j++) {
        if (mask & (1 << j)) continue;
        const v = base + scores[i * m + j];
        const to = mask | (1 << j);
        if (v > next[to]) next[to] = v;
      }
    }
    prev = next;
  }
  let best = 0;
  for (let mask = 0; mask < full; mask++) if (prev[mask] > best) best = prev[mask];
  return best;
}

function positionScore(qs, cs) {
  if (!qs.length && !cs.length) return 1;
  if (!qs.length || !cs.length) return 0;
  const scores = new Float64Array(qs.length * cs.length);
  for (let i = 0; i < qs.length; i++) {
    for (let j = 0; j < cs.length; j++) scores[i * cs.length + j] = pairScore(qs[i], cs[j]);
  }
  return bestAssignment(scores, qs.length, cs.length) / Math.max(qs.length, cs.length);
}

/** Greedy pairing is plenty here: a side throws a handful per kind. */
function utilityScore(qn, cn) {
  if (!qn.length && !cn.length) return 1;
  if (!qn.length || !cn.length) return 0;
  const pairs = [];
  for (let i = 0; i < qn.length; i++) {
    for (let j = 0; j < cn.length; j++) {
      const a = qn[i];
      const b = cn[j];
      if (a.kind !== b.kind) continue;
      const s = gauss(Math.hypot(a.x - b.x, a.y - b.y), NADE_SIGMA) * gauss(a.t - b.t, NADE_TIME_SIGMA);
      if (s > 0.01) pairs.push([s, i, j]);
    }
  }
  pairs.sort((x, y) => y[0] - x[0]);
  const usedQ = new Uint8Array(qn.length);
  const usedC = new Uint8Array(cn.length);
  let total = 0;
  for (const [s, i, j] of pairs) {
    if (usedQ[i] || usedC[j]) continue;
    usedQ[i] = 1;
    usedC[j] = 1;
    total += s;
  }
  return total / Math.max(qn.length, cn.length);
}

// ---- drawing ----------------------------------------------------------------

/** A stroke shorter than this is a spot (stand here), not a path. */
const SPOT_LENGTH = 180;

/**
 * Resample a drawn stroke (world units) to evenly spaced points.
 * @param {Array<[number, number]>} pts
 */
function resample(pts, step = 80, max = 48) {
  const clean = (pts || [])
    .map((p) => [Number(p?.[0]), Number(p?.[1])])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (!clean.length) return { pts: [], length: 0 };
  let length = 0;
  for (let i = 1; i < clean.length; i++) {
    length += Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]);
  }
  if (length < step) return { pts: [clean[0], clean[clean.length - 1]], length };
  const n = Math.min(max, Math.max(2, Math.ceil(length / step) + 1));
  const want = length / (n - 1);
  const out = [clean[0]];
  let acc = 0;
  let next = want;
  for (let i = 1; i < clean.length && out.length < n - 1; i++) {
    const [ax, ay] = clean[i - 1];
    const [bx, by] = clean[i];
    const seg = Math.hypot(bx - ax, by - ay);
    while (seg > 0 && acc + seg >= next && out.length < n - 1) {
      const t = (next - acc) / seg;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      next += want;
    }
    acc += seg;
  }
  out.push(clean[clean.length - 1]);
  return { pts: out, length };
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** How closely the best-fitting player of a side walked a drawn path. */
function pathScore(index, side, pts) {
  const code = SIDE_CODE[side];
  const first = Math.max(0, Math.floor((index.freezeEndTick - index.firstTick) / index.stride));
  const last = Math.min(index.rows - 1, Math.ceil((index.endTick - index.firstTick) / index.stride));
  let best = 0;
  for (let s = 0; s < index.slots; s++) {
    if (index.slotSide[s] !== code) continue;
    let sum = 0;
    for (const [x, y] of pts) {
      let d = Infinity;
      let prev = -1;
      for (let r = first; r <= last; r++) {
        const i = r * index.slots + s;
        if (!index.alive[i]) {
          prev = -1;
          continue;
        }
        if (prev >= 0) {
          d = Math.min(d, segDist(x, y, index.px[prev], index.py[prev], index.px[i], index.py[i]));
        } else {
          d = Math.min(d, Math.hypot(x - index.px[i], y - index.py[i]));
        }
        prev = i;
      }
      sum += Number.isFinite(d) ? gauss(d, PATH_SIGMA) : 0;
    }
    best = Math.max(best, sum / pts.length);
  }
  return best;
}

/** A player of the side standing on a drawn spot at the moment. */
function spotScore(players, pt) {
  let best = 0;
  for (const p of players) {
    const here = p.traj[p.traj.length - 1];
    best = Math.max(best, gauss(Math.hypot(here.x - pt[0], here.y - pt[1]), SPOT_SIGMA));
  }
  return best;
}

// ---- the question -----------------------------------------------------------

/**
 * What a scan asks, read off the round on screen.
 *
 * @param {object} index           the source round's index
 * @param {object} opts
 * @param {number} opts.tick       the moment, as a demo tick of that round
 * @param {'T'|'CT'} opts.side     whose round this is (dominance, economy)
 * @param {boolean} [opts.both]    compare the other side too
 * @param {'round'|'drawing'|'both'} [opts.mode]
 * @param {Array<{ side?: string, pts: Array<[number, number]> }>} [opts.strokes]  world units
 * @param {string} [opts.team]     only rounds where this team sat where it sits now
 */
export function buildQuery(index, { tick, side = 'T', both = false, mode = 'round', strokes = [], team = '' } = {}) {
  const perspective = side === 'CT' ? 'CT' : 'T';
  const other = perspective === 'T' ? 'CT' : 'T';
  const elapsed = Math.max(0, (Number(tick) - index.freezeEndTick) / index.tickRate);
  const sides = both ? [perspective, other] : [perspective];

  const drawn = [];
  for (const s of strokes || []) {
    const strokeSide = s?.side === 'T' || s?.side === 'CT' ? s.side : perspective;
    const { pts, length } = resample(s?.pts);
    if (!pts.length) continue;
    if (length < SPOT_LENGTH) {
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      drawn.push({ side: strokeSide, kind: 'spot', pt: [cx, cy] });
    } else {
      drawn.push({ side: strokeSide, kind: 'path', pts });
    }
  }
  const useMode = drawn.length ? (mode === 'drawing' || mode === 'both' ? mode : 'round') : 'round';

  const players = {};
  const nades = {};
  const econ = {};
  for (const s of ['T', 'CT']) {
    players[s] = sidePlayersAt(index, s, elapsed);
    nades[s] = sideNadesAt(index, s, elapsed);
    econ[s] = econClass(index.teams[s]?.econ);
  }

  let teamSide = '';
  if (team) {
    if (index.teams.T?.id === team) teamSide = 'T';
    else if (index.teams.CT?.id === team) teamSide = 'CT';
  }

  return {
    file: index.file,
    map: index.map,
    elapsed,
    perspective,
    sides,
    mode: useMode,
    drawn,
    players,
    nades,
    econ,
    team: teamSide ? team : '',
    teamSide
  };
}

/**
 * Why a round is not a candidate at all, or '' when it is. The economy and
 * the clock are gates, not scores: a pistol round is never "a bit like" a
 * full buy, and a round that was over by 1:12 did not go through 1:12.
 */
export function gateReason(query, index) {
  if (!index) return 'unreadable';
  if (index.file === query.file) return 'self';
  if (query.map && index.map && index.map !== query.map) return 'map';
  for (const s of query.sides) {
    if (econClass(index.teams[s]?.econ) !== query.econ[s]) return 'economy';
  }
  if (query.team && index.teams[query.teamSide]?.id !== query.team) return 'team';
  if (tickAt(index, query.elapsed) > index.endTick) return 'ended';
  return '';
}

/**
 * One candidate against the question.
 * @returns {null | {
 *   file: string, similarity: number, tick: number,
 *   parts: { positions?: number, utility?: number, drawing?: number },
 *   dominance: number, drop: number, won: boolean,
 *   round: number, teams: object, winnerSide: string
 * }}
 */
export function scoreRound(query, index) {
  if (gateReason(query, index)) return null;
  const parts = {};
  let snapshot = null;
  if (query.mode !== 'drawing') {
    let pos = 0;
    let util = 0;
    for (const s of query.sides) {
      pos += positionScore(query.players[s], sidePlayersAt(index, s, query.elapsed));
      util += utilityScore(query.nades[s], sideNadesAt(index, s, query.elapsed));
    }
    pos /= query.sides.length;
    util /= query.sides.length;
    parts.positions = Math.round(pos * 100);
    parts.utility = Math.round(util * 100);
    snapshot = 0.7 * pos + 0.3 * util;
  }
  let drawing = null;
  if (query.mode !== 'round' && query.drawn.length) {
    let sum = 0;
    let players = null;
    for (const d of query.drawn) {
      if (d.kind === 'path') {
        sum += pathScore(index, d.side, d.pts);
      } else {
        players ||= { T: sidePlayersAt(index, 'T', query.elapsed), CT: sidePlayersAt(index, 'CT', query.elapsed) };
        sum += spotScore(players[d.side], d.pt);
      }
    }
    drawing = sum / query.drawn.length;
    parts.drawing = Math.round(drawing * 100);
  }
  const score =
    snapshot !== null && drawing !== null ? 0.5 * snapshot + 0.5 * drawing : (snapshot ?? drawing ?? 0);
  const dom = index.dominance[query.perspective];
  return {
    file: index.file,
    similarity: Math.round(score * 1000) / 10,
    tick: Math.round(tickAt(index, query.elapsed)),
    parts,
    dominance: dom.dominance,
    drop: dom.drop,
    won: index.winnerSide === query.perspective,
    round: index.round,
    teams: index.teams,
    winnerSide: index.winnerSide
  };
}


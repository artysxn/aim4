// ---------------------------------------------------------------------------
// replays/plays/playMap.js
// What a side usually does on a map: the baseline a play is measured against.
//
// "Default" is not a rule written down here. It is what the library's rounds
// did: for each map, side, economy and ten seconds of the clock, where the
// side's players stood, how unusual one round's shape is against that, and
// which plays (plays/findPlays.js) teams ran and how often. A round that looks
// like most rounds at that clock is playing a default; one that does what few
// rounds do is making a play, and the baseline says how few.
//
// It is learned from Similar Rounds indexes (similar/roundSimilarity.js), the
// stride-100 pass the desktop app already reads for a scan, so the same code
// learns from the sample demos, a whole library through the API, or the
// rounds one scan downloaded.
//
//   anchors   T and CT spawn (where each side stands at freeze end) and the two
//             bombsites (plant positions split in two; a painted zone network
//             names them when one is given, SITE_HINTS otherwise)
//   cells     the map cut into CELL-unit squares: how often each side stood
//             in each, and which site the Ts were heading for when they
//             stood there in the 20 s before a plant (a cell's lean)
//   occupancy where each side stands per economy and per BUCKET seconds
//   surprise  how unusual a side's shape is, as percentiles over the rounds
//   plays     how often each kind of play was run, per side and economy
//
// DOM-free: the desktop server, the eye's tools and tools/eye/plays all use it.
// ---------------------------------------------------------------------------

import { econClass } from '../similar/roundSimilarity.js';

export const BASELINE_VERSION = 1;
/** World units per side of a cell. A site is two to four cells across. */
export const CELL = 400;
/** Seconds per occupancy bucket, and how many buckets a round has (115 s live). */
export const BUCKET = 10;
export const BUCKETS = 12;
/** Economy groups: half and force buys are one group, they buy the same guns. */
export const ECON_GROUPS = ['pistol', 'eco', 'buy', 'full'];
/** Seconds before a plant in which the Ts' cells count toward that site's lean. */
const LEAN_SECONDS = 20;
/** Smoothing weights: an economy's occupancy backs off to the side's, then to every cell. */
const K_ECON = 20;
const K_SIDE = 20;
/** Site radius from its plants: their 90th percentile spread plus this pad, clamped. */
const SITE_PAD = 250;
const SITE_MIN_R = 450;
const SITE_MAX_R = 750;
/** A spawn reaches this far. */
const SPAWN_R = 650;

/**
 * Where bombsite A roughly is, per map, for when no zone network names the
 * sites. Only used to tell the two clusters of plants apart, so a few hundred
 * units off is fine. Nuke's sites share x/y and are told apart by height.
 */
export const SITE_HINTS = {
  ANC: { A: [-1413, 763] },
  ANU: { A: [1261, 1963] },
  CCH: { A: [-92, 1831] },
  DD2: { A: [1100, 2500] },
  INF: { A: [2000, 450] },
  MIR: { A: [-300, -2100] },
  NUK: { A: [650, -700, -415] }
};

export function econGroup(code) {
  const c = econClass(code);
  if (c === 'half' || c === 'force') return 'buy';
  return c || 'full';
}

export const ECON_WORD = { pistol: 'pistol rounds', eco: 'ecos', buy: 'half and force buys', full: 'full buys' };

const cellXY = (x, y) => [Math.floor(x / CELL), Math.floor(y / CELL)];
export const cellKey = (x, y) => {
  const [cx, cy] = cellXY(x, y);
  return `${cx},${cy}`;
};
const cellCenter = (key) => {
  const [cx, cy] = key.split(',').map(Number);
  return [(cx + 0.5) * CELL, (cy + 0.5) * CELL];
};

export const bucketOf = (elapsed) => Math.max(0, Math.min(BUCKETS - 1, Math.floor(elapsed / BUCKET)));

// ---- reading an index -------------------------------------------------------

export const SIDE_CODE = { T: 1, CT: 2 };

/** The first row at or after freeze end. */
export function firstLiveRow(index) {
  return Math.max(0, Math.ceil((index.freezeEndTick - index.firstTick) / index.stride));
}

/** Seconds since freeze end at a row. */
export function rowElapsed(index, r) {
  return (index.firstTick + r * index.stride - index.freezeEndTick) / index.tickRate;
}

/** The row at or just before `elapsed` seconds. */
export function rowAt(index, elapsed) {
  const r = Math.floor((index.freezeEndTick + elapsed * index.tickRate - index.firstTick) / index.stride);
  return Math.max(0, Math.min(index.rows - 1, r));
}

/** The last live row: the round's end, or the last row the buffer has. */
export function lastLiveRow(index) {
  return Math.max(0, Math.min(index.rows - 1, Math.floor((index.endTick - index.firstTick) / index.stride)));
}

/** A slot's position at a row, or null when it is dead there. */
export function livePos(index, r, s) {
  const i = r * index.slots + s;
  if (!index.alive[i]) return null;
  const tick = index.firstTick + r * index.stride;
  if (index.death[s] >= 0 && index.death[s] <= tick) return null;
  return { x: index.px[i], y: index.py[i], z: index.pz[i] };
}

/** Every living player of a side at a row: slot and position. */
export function sideAt(index, r, side) {
  const code = SIDE_CODE[side];
  const out = [];
  for (let s = 0; s < index.slots; s++) {
    if (index.slotSide[s] !== code) continue;
    const p = livePos(index, r, s);
    if (p) out.push({ slot: s, ...p });
  }
  return out;
}

/**
 * A side's round win chance (0-100) at `elapsed` seconds, from the index's
 * win series: the round model without geometry, one reading per row from
 * freeze end, then the result.
 */
export function winAt(index, elapsed, side) {
  const series = index.win;
  if (!series?.length) return null;
  const live = series.length - 1;
  const i = Math.max(0, Math.min(live - 1, rowAt(index, elapsed) - firstLiveRow(index)));
  const t = live > 0 ? series[i] : series[0];
  return side === 'CT' ? 100 - t : t;
}

/** Did a side win the round. */
export const wonBy = (index, side) => index.winnerSide === side;

// ---- sites ------------------------------------------------------------------

/** Two clusters of points (x, y, z), z weighted so Nuke's floors split. */
function twoClusters(points) {
  if (points.length < 2) return null;
  const d = (p, c) => Math.hypot(p[0] - c[0], p[1] - c[1], ((p[2] || 0) - (c[2] || 0)) * 3);
  let c = [points[0], points.reduce((best, p) => (d(p, points[0]) > d(best, points[0]) ? p : best), points[0])];
  let groups = [[], []];
  for (let it = 0; it < 25; it++) {
    groups = [[], []];
    for (const p of points) groups[d(p, c[0]) <= d(p, c[1]) ? 0 : 1].push(p);
    if (!groups[0].length || !groups[1].length) return null;
    c = groups.map((g) => [0, 1, 2].map((k) => g.reduce((s, p) => s + (p[k] || 0), 0) / g.length));
  }
  return groups.map((g, i) => ({ center: c[i], points: g }));
}

function siteOf(cluster) {
  const [x, y, z] = cluster.center;
  const dist = cluster.points.map((p) => Math.hypot(p[0] - x, p[1] - y)).sort((a, b) => a - b);
  const p90 = dist[Math.min(dist.length - 1, Math.floor(dist.length * 0.9))] || 0;
  return { x: Math.round(x), y: Math.round(y), z: Math.round(z), r: Math.round(Math.max(SITE_MIN_R, Math.min(SITE_MAX_R, p90 + SITE_PAD))), plants: cluster.points.length };
}

/**
 * Bombsites from plant positions. `named` (from a zone network) wins; else
 * the hint for the map says which cluster is A; else the one with the larger
 * x is called A and `guessed` says so.
 */
export function sitesFromPlants(map, plants, named = null) {
  if (named?.A && named?.B) {
    return {
      A: { x: Math.round(named.A.x), y: Math.round(named.A.y), z: 0, r: SITE_MIN_R + 100, plants: 0 },
      B: { x: Math.round(named.B.x), y: Math.round(named.B.y), z: 0, r: SITE_MIN_R + 100, plants: 0 },
      from: 'zones'
    };
  }
  if (!plants.length) return null;
  const hint = SITE_HINTS[map]?.A;
  const groups = twoClusters(plants);
  if (!groups || Math.hypot(groups[0].center[0] - groups[1].center[0], groups[0].center[1] - groups[1].center[1]) < SITE_MIN_R) {
    // Every plant on one site: that site is known, the other is not.
    const one = siteOf({ center: [0, 1, 2].map((k) => plants.reduce((sum, p) => sum + (p[k] || 0), 0) / plants.length), points: plants });
    const isA = hint ? Math.hypot(one.x - hint[0], one.y - hint[1]) < 1500 : true;
    return { [isA ? 'A' : 'B']: one, from: hint ? 'plants (one site only)' : 'plants (one site only), label guessed' };
  }
  const [s0, s1] = groups.map(siteOf);
  let aFirst;
  if (hint) {
    const d = (s) => Math.hypot(s.x - hint[0], s.y - hint[1], hint[2] != null ? (s.z - hint[2]) * 3 : 0);
    aFirst = d(s0) <= d(s1);
  } else {
    aFirst = s0.x >= s1.x;
  }
  return { A: aFirst ? s0 : s1, B: aFirst ? s1 : s0, from: hint ? 'plants' : 'plants, labels guessed' };
}

// ---- places -----------------------------------------------------------------

/**
 * Where a point is, in words, and which part of the map it belongs to:
 * ground A, B or mid (by the cell's lean, or by distance when the cell has
 * no plant history), on a site or in a spawn.
 *
 * @returns {{ ground: 'A'|'B'|'mid', site: 'A'|'B'|null, spawn: 'T'|'CT'|null, name: string, cell: string }}
 */
export function placeOf(baseline, x, y, z = 0) {
  const a = baseline.anchors;
  const key = cellKey(x, y);
  const info = baseline.cells?.[key];
  const sites = a.sites || {};
  const dSite = (s) => (sites[s] ? Math.hypot(x - sites[s].x, y - sites[s].y, baseline.map === 'NUK' ? (z - sites[s].z) * 2 : 0) : Infinity);
  const dA = dSite('A');
  const dB = dSite('B');
  const site = dA <= (sites.A?.r || 0) ? 'A' : dB <= (sites.B?.r || 0) ? 'B' : null;
  const dT = a.tSpawn ? Math.hypot(x - a.tSpawn[0], y - a.tSpawn[1]) : Infinity;
  const dCT = a.ctSpawn ? Math.hypot(x - a.ctSpawn[0], y - a.ctSpawn[1]) : Infinity;
  const spawn = !site && dT <= SPAWN_R ? 'T' : !site && dCT <= SPAWN_R ? 'CT' : null;
  const lean = leanOf(baseline, key, dA, dB);
  const ground = site || (lean >= 0.65 ? 'A' : lean <= 0.35 ? 'B' : 'mid');
  let name = info?.name || '';
  if (!name) {
    if (site) name = `${site} site`;
    else if (spawn) name = `${spawn} spawn`;
    else {
      // Which half of the map: nearer the Ts' spawn or the CTs'.
      const tSide = Number.isFinite(dT) && Number.isFinite(dCT) ? dCT / (dT + dCT) : 0.5;
      if (ground === 'mid') name = tSide > 0.58 ? 'mid, T side' : tSide < 0.42 ? 'mid, CT side' : 'mid';
      else name = tSide > 0.5 ? `${ground} main` : `${ground}, CT side`;
    }
  }
  return { ground, site, spawn, name, cell: key };
}

/** How much a cell belongs to A (1) rather than B (0). */
function leanOf(baseline, key, dA, dB) {
  const prior = Number.isFinite(dA) && Number.isFinite(dB) ? dB / (dA + dB) : 0.5;
  const info = baseline.cells?.[key];
  if (!info) return prior;
  const [ta, tb] = info;
  // Five rounds of evidence weigh as much as the distance does.
  return (ta + 5 * prior) / (ta + tb + 5);
}

// ---- occupancy --------------------------------------------------------------

/** P(a player of `side` stands in this cell | economy, bucket), smoothed. */
export function cellProb(baseline, side, econ, bucket, key) {
  const occ = baseline.occupancy;
  const nCells = Math.max(50, Object.keys(baseline.cells || {}).length);
  const all = occ[`${side}|all`]?.[bucket];
  const pAll = all ? ((all.c[key] || 0) + K_SIDE / nCells) / (all.n + K_SIDE) : 1 / nCells;
  const e = occ[`${side}|${econ}`]?.[bucket];
  return e ? ((e.c[key] || 0) + K_ECON * pAll) / (e.n + K_ECON) : pAll;
}

/** How unusual one player's spot is, in bits: -log2 of its probability. */
export function spotSurprise(baseline, side, econ, elapsed, x, y) {
  return -Math.log2(cellProb(baseline, side, econ, bucketOf(elapsed), cellKey(x, y)));
}

/** A side's shape at a row: the mean surprise of its players, and each player's. */
export function shapeSurprise(baseline, index, r, side, econ) {
  const e = rowElapsed(index, r);
  const players = sideAt(index, r, side).map((p) => ({ slot: p.slot, bits: spotSurprise(baseline, side, econ, e, p.x, p.y) }));
  const mean = players.length ? players.reduce((s, p) => s + p.bits, 0) / players.length : 0;
  return { mean, players };
}

/**
 * Where a shape sits among the baseline's rounds at the same clock: the share
 * of rounds that were less unusual (0-100). 90 means only one round in ten
 * was further from the default.
 */
export function surprisePercentile(baseline, side, econ, elapsed, bits) {
  const s = baseline.surprise?.[`${side}|${econ}`]?.[bucketOf(elapsed)] || baseline.surprise?.[`${side}|all`]?.[bucketOf(elapsed)];
  if (!s?.length) return null;
  let below = 0;
  while (below < s.length && s[below] < bits) below++;
  return Math.round((below / s.length) * 100);
}

/** A kind of play, how often it happens on this map (side and economy), or null. */
export function playFrequency(baseline, side, econ, key) {
  const k = baseline.plays?.[`${side}|${econ}`];
  if (!k?.rounds) return null;
  return { pct: Math.round(((k.kinds[key] || 0) / k.rounds) * 100), rounds: k.rounds, count: k.kinds[key] || 0 };
}

// ---- learning ---------------------------------------------------------------

/** Percentile cut points kept per bucket: enough to read any round's place among them. */
const SURPRISE_CUTS = 20;

function cuts(values) {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < SURPRISE_CUTS; i++) out.push(Math.round(sorted[Math.floor((i / SURPRISE_CUTS) * sorted.length)] * 100) / 100);
  return out;
}

/**
 * Learn a map's baseline from many rounds. Two passes: the first learns the
 * anchors, cells and occupancy; the second reads each round against them
 * (how unusual its shapes were, which plays it ran).
 *
 * @param {string} map
 * @param {object} opts
 * @param {(fn: (index: object) => void) => Promise<void>|void} opts.each
 *   calls fn with every round index of the map, once per pass
 * @param {(index: object, baseline: object) => Array<{ side: string, key: string }>} [opts.playsOf]
 *   the plays of one round as frequency keys (findPlays.js playKeys)
 * @param {{ A: {x:number,y:number}, B: {x:number,y:number} }|null} [opts.namedSites]
 * @param {((x: number, y: number) => string)|null} [opts.namer]  a callout for a point
 */
export async function learnBaseline(map, { each, playsOf = null, namedSites = null, namer = null }) {
  const plants = [];
  const leanRows = [];
  const spawn = { T: [0, 0, 0], CT: [0, 0, 0] };
  const occupancy = {};
  const cellCount = new Map();
  const rounds = { T: {}, CT: {} };
  let total = 0;

  const bump = (key, bucket, cell) => {
    const row = (occupancy[key] ||= Array.from({ length: BUCKETS }, () => ({ n: 0, c: {} })))[bucket];
    row.n += 1;
    row.c[cell] = (row.c[cell] || 0) + 1;
  };

  await each((index) => {
    if (!index || index.map !== map) return;
    total += 1;
    const r0 = firstLiveRow(index);
    const rEnd = lastLiveRow(index);
    const plantT = index.plant ? index.plant.t : Infinity;
    if (index.plant && (index.plant.x || index.plant.y)) {
      plants.push([index.plant.x, index.plant.y, 0]);
      // The plant's z is the planter's at that row.
      const pr = rowAt(index, index.plant.t);
      const planter = index.plant.slot >= 0 ? livePos(index, pr, index.plant.slot) : null;
      if (planter) plants[plants.length - 1][2] = planter.z;
    }
    for (const side of ['T', 'CT']) {
      const g = econGroup(index.teams[side]?.econ);
      rounds[side][g] = (rounds[side][g] || 0) + 1;
      for (const p of sideAt(index, r0, side)) {
        spawn[side][0] += p.x;
        spawn[side][1] += p.y;
        spawn[side][2] += 1;
      }
    }
    const before = [];
    for (let r = r0; r <= rEnd; r++) {
      const e = rowElapsed(index, r);
      if (e >= plantT) break;
      const b = bucketOf(e);
      for (const side of ['T', 'CT']) {
        const g = econGroup(index.teams[side]?.econ);
        for (const p of sideAt(index, r, side)) {
          const key = cellKey(p.x, p.y);
          bump(`${side}|${g}`, b, key);
          bump(`${side}|all`, b, key);
          const c = cellCount.get(key) || [0, 0];
          c[side === 'T' ? 0 : 1] += 1;
          cellCount.set(key, c);
          if (side === 'T' && e >= plantT - LEAN_SECONDS) before.push(key);
        }
      }
    }
    if (index.plant && before.length) leanRows.push({ plant: plants[plants.length - 1], cells: before });
  });

  const anchors = {
    tSpawn: spawn.T[2] ? [Math.round(spawn.T[0] / spawn.T[2]), Math.round(spawn.T[1] / spawn.T[2])] : null,
    ctSpawn: spawn.CT[2] ? [Math.round(spawn.CT[0] / spawn.CT[2]), Math.round(spawn.CT[1] / spawn.CT[2])] : null,
    sites: null,
    sitesFrom: ''
  };
  const sites = sitesFromPlants(map, plants, namedSites);
  if (sites) {
    anchors.sites = Object.fromEntries(['A', 'B'].filter((k) => sites[k]).map((k) => [k, sites[k]]));
    anchors.sitesFrom = sites.from;
  }

  // Cells: [Ts here before an A plant, before a B plant, T presence, CT presence].
  const cells = {};
  for (const [key, [t, ct]] of cellCount) cells[key] = [0, 0, t, ct];
  if (anchors.sites) {
    const { A, B } = anchors.sites;
    const to = (s, x, y, z) => (s ? Math.hypot(x - s.x, y - s.y, (z - s.z) * 3) : Infinity);
    for (const row of leanRows) {
      const [x, y, z] = row.plant;
      const k = to(A, x, y, z) <= to(B, x, y, z) ? 0 : 1;
      for (const key of new Set(row.cells)) if (cells[key]) cells[key][k] += 1;
    }
  }
  if (namer) {
    for (const key of Object.keys(cells)) {
      const [x, y] = cellCenter(key);
      const name = namer(x, y);
      if (name) cells[key].push(name);
    }
  }
  // A cell's name rides as its fifth entry; placeOf reads it as info.name.
  for (const key of Object.keys(cells)) {
    const c = cells[key];
    if (c.length === 5) Object.defineProperty(c, 'name', { value: c[4], enumerable: false });
  }

  const baseline = { v: BASELINE_VERSION, map, cell: CELL, bucket: BUCKET, rounds: total, sideRounds: rounds, anchors, cells, occupancy, surprise: {}, plays: {} };

  // Second pass: each round against what the first learned.
  const shapes = {};
  const plays = {};
  await each((index) => {
    if (!index || index.map !== map) return;
    const r0 = firstLiveRow(index);
    const rEnd = lastLiveRow(index);
    const plantT = index.plant ? index.plant.t : Infinity;
    for (const side of ['T', 'CT']) {
      const g = econGroup(index.teams[side]?.econ);
      for (const key of [`${side}|${g}`, `${side}|all`]) {
        const rows = (shapes[key] ||= Array.from({ length: BUCKETS }, () => []));
        // One reading per bucket per round, at its middle row, so long rounds do not weigh more.
        const seen = new Set();
        for (let r = r0; r <= rEnd; r++) {
          const e = rowElapsed(index, r);
          if (e >= plantT) break;
          const b = bucketOf(e);
          if (seen.has(b) || e < b * BUCKET + BUCKET / 2 - 1) continue;
          seen.add(b);
          const s = shapeSurprise(baseline, index, r, side, g);
          if (s.players.length) rows[b].push(s.mean);
        }
      }
    }
    if (playsOf) {
      const counted = new Set();
      for (const p of playsOf(index, baseline)) {
        const g = econGroup(index.teams[p.side]?.econ);
        const k = (plays[`${p.side}|${g}`] ||= { rounds: 0, kinds: {} });
        const id = `${p.side}|${g}|${p.key}`;
        if (counted.has(id)) continue;
        counted.add(id);
        k.kinds[p.key] = (k.kinds[p.key] || 0) + 1;
      }
      for (const side of ['T', 'CT']) {
        const g = econGroup(index.teams[side]?.econ);
        (plays[`${side}|${g}`] ||= { rounds: 0, kinds: {} }).rounds += 1;
      }
    }
  });
  for (const [key, rows] of Object.entries(shapes)) baseline.surprise[key] = rows.map(cuts);
  baseline.plays = plays;
  return baseline;
}

/** A baseline as JSON, cell names kept. */
export function baselineJson(baseline) {
  const cells = {};
  for (const [key, c] of Object.entries(baseline.cells)) cells[key] = c.name ? [...c.slice(0, 4), c.name] : c.slice(0, 4);
  return JSON.stringify({ ...baseline, cells });
}

/** A baseline read back from JSON. */
export function parseBaseline(text) {
  const b = typeof text === 'string' ? JSON.parse(text) : text;
  if (!b || b.v !== BASELINE_VERSION) return null;
  for (const c of Object.values(b.cells || {})) {
    if (c.length === 5) Object.defineProperty(c, 'name', { value: c[4], enumerable: false });
  }
  return b;
}

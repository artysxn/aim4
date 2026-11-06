// ---------------------------------------------------------------------------
// server/insights/reaction.js
// How these markets usually move, learned from Polymarket's own prices.
//
// No outside model of who should win. Instead: for every finished tracked
// match we have the price path (Data API history, 5-minute buckets, plus the
// recorder's ticks once it has run). From those paths:
//
//   reaction table   after the price moved by M over the last 5 minutes, at
//                    price level L, before or during the match, what did it do
//                    over the next 5 / 15 / 30 minutes (mean, spread, count)
//   volatility       how far a price at level L usually wanders in 5 minutes,
//                    before and during the match: sizes targets and stops
//   score reaction   (from recorded ticks) after a round or map changes the
//                    score, how much of the first minute's move is still
//                    there ten minutes later: below 1 means the market
//                    overreacts and the move can be faded
//
// Tables are shrunk toward zero with few samples, so a cell seen 3 times
// cannot drive a trade. Pure functions plus one fitted-table holder.
// ---------------------------------------------------------------------------

export const HORIZONS = [5, 15, 30];
const MIN = 60e3;
const SHRINK_K = 40;

export const levelBucket = (p) => Math.min(4, Math.max(0, Math.floor(p * 5))); // 0-20, 20-40, ...
export const MOVE_EDGES = [-0.08, -0.03, 0.03, 0.08];
export function moveBucket(d) {
  let i = 0;
  while (i < MOVE_EDGES.length && d > MOVE_EDGES[i]) i++;
  return i; // 0 big drop, 1 drop, 2 flat, 3 rise, 4 big rise
}
export const MOVE_LABELS = ['fell 8c+', 'fell 3-8c', 'flat', 'rose 3-8c', 'rose 8c+'];
const key = (phase, lv, mv) => `${phase}|${lv}|${mv}`;

/** Price at time t on a sorted [[t, p]] path (last point at or before t). */
export function priceAt(path, t) {
  let lo = 0;
  let hi = path.length - 1;
  if (!path.length || t < path[0][0]) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (path[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return path[lo][1];
}

/**
 * Samples from one price path: every `stepMs`, the state (phase, level, last
 * 5-minute move) and the moves that followed. Both outcomes are used (the
 * second is the mirror image), so the table is symmetric by construction.
 * @param {{ path: Array<[number, number]>, start: number }} match
 */
export function samplesOf(match, stepMs = 5 * MIN) {
  const out = [];
  const path = match.path;
  if (!path || path.length < 4) return out;
  const t0 = path[0][0] + 5 * MIN;
  const t1 = path[path.length - 1][0];
  for (let t = t0; t <= t1; t += stepMs) {
    const p = priceAt(path, t);
    const p5 = priceAt(path, t - 5 * MIN);
    if (p === null || p5 === null || p <= 0.02 || p >= 0.98) continue;
    const phase = match.start && t < match.start ? 'pre' : 'live';
    const fut = HORIZONS.map((h) => {
      const q = t + h * MIN <= t1 ? priceAt(path, t + h * MIN) : null;
      return q === null ? null : q - p;
    });
    for (const sgn of [1, -1]) {
      const pp = sgn === 1 ? p : 1 - p;
      out.push({ t, phase, p: pp, move: sgn * (p - p5), fut: fut.map((f) => (f === null ? null : sgn * f)) });
    }
  }
  return out;
}

/** Fit the reaction and volatility tables from samples. */
export function fitTables(samples) {
  const cells = new Map();
  const vol = new Map();
  for (const s of samples) {
    const lv = levelBucket(s.p);
    const k = key(s.phase, lv, moveBucket(s.move));
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { n: HORIZONS.map(() => 0), sum: HORIZONS.map(() => 0), sq: HORIZONS.map(() => 0) }));
    s.fut.forEach((f, i) => {
      if (f === null) return;
      c.n[i]++;
      c.sum[i] += f;
      c.sq[i] += f * f;
    });
    const vk = `${s.phase}|${lv}`;
    let v = vol.get(vk);
    if (!v) vol.set(vk, (v = { n: 0, sq: 0, abs: [] }));
    if (s.fut[0] !== null) {
      v.n++;
      v.sq += s.fut[0] * s.fut[0];
      if (v.abs.length < 4000) v.abs.push(Math.abs(s.fut[0]));
    }
  }
  const reaction = {};
  for (const [k, c] of cells) {
    reaction[k] = HORIZONS.map((_, i) => {
      const n = c.n[i];
      const mean = n ? c.sum[i] / n : 0;
      const sd = n > 1 ? Math.sqrt(Math.max(0, c.sq[i] / n - mean * mean)) : null;
      return { n, mean, sd, shrunk: n ? (mean * n) / (n + SHRINK_K) : 0 };
    });
  }
  const volatility = {};
  for (const [k, v] of vol) {
    v.abs.sort((a, b) => a - b);
    volatility[k] = { n: v.n, sd5: v.n ? Math.sqrt(v.sq / v.n) : null, p75: v.abs[Math.floor(v.abs.length * 0.75)] ?? null, p90: v.abs[Math.floor(v.abs.length * 0.9)] ?? null };
  }
  return { reaction, volatility, samples: samples.length };
}

/**
 * Walk-forward check: fit on the earlier matches, score on the later ones.
 * Reports how well the predicted 30-minute move lines up with what happened,
 * and what trading every prediction above a cost would have made.
 */
export function walkForward(matches, { split = 0.75, cost = 0.025 } = {}) {
  const sorted = matches.filter((m) => m.path?.length > 3).sort((a, b) => (a.start || 0) - (b.start || 0));
  const cut = Math.floor(sorted.length * split);
  const train = sorted.slice(0, cut).flatMap((m) => samplesOf(m));
  const test = sorted.slice(cut).flatMap((m) => samplesOf(m, 15 * MIN));
  const fit = fitTables(train);
  let n = 0;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  let trades = 0;
  let pnl = 0;
  let wins = 0;
  for (const s of test) {
    const y = s.fut[2];
    if (y === null) continue;
    const pred = predict(fit, s.phase, s.p, s.move)[2].shrunk;
    n++;
    sxy += pred * y;
    sxx += pred * pred;
    syy += y * y;
    if (Math.abs(pred) > cost) {
      trades++;
      const r = Math.sign(pred) * y - cost;
      pnl += r;
      if (r > 0) wins++;
    }
  }
  return {
    trainMatches: cut,
    testMatches: sorted.length - cut,
    testSamples: n,
    corr: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null,
    trades,
    winRate: trades ? wins / trades : null,
    avgPnl: trades ? pnl / trades : null,
    cost
  };
}

/** Table lookup with an empty fallback. */
export function predict(tables, phase, p, move) {
  const cell = tables?.reaction?.[key(phase, levelBucket(p), moveBucket(move))];
  return cell || HORIZONS.map(() => ({ n: 0, mean: 0, sd: null, shrunk: 0 }));
}

export function volOf(tables, phase, p) {
  return tables?.volatility?.[`${phase}|${levelBucket(p)}`] || { n: 0, sd5: null, p75: null, p90: null };
}

/**
 * Score reactions from recorded ticks: for each score change, the mid move
 * in the first minute and after ten. Returns the share of the first move that
 * held (beta, by least squares) for live matches.
 * @param {Array<{ events: Array<{t:number, mid:number|null, score?:string}> }>} recs
 */
export function fitScoreReaction(episodes) {
  let sxy = 0;
  let sxx = 0;
  let n = 0;
  for (const e of episodes) {
    if (!Number.isFinite(e.first) || !Number.isFinite(e.later) || Math.abs(e.first) < 0.01) continue;
    sxy += e.first * e.later;
    sxx += e.first * e.first;
    n++;
  }
  return { n, beta: sxx ? sxy / sxx : 1 };
}

/**
 * Episodes from one replayed recording: [{ first, later }] per score change,
 * using the mid path of one token. `mids` is a sorted [[t, mid]] path.
 */
export function scoreEpisodes(mids, scoreTimes) {
  const out = [];
  for (const t of scoreTimes) {
    const p0 = priceAt(mids, t - 2000);
    const p1 = priceAt(mids, t + 60e3);
    const p10 = priceAt(mids, t + 10 * 60e3);
    if (p0 === null || p1 === null || p10 === null) continue;
    out.push({ first: p1 - p0, later: p10 - p0 });
  }
  return out;
}

/** The tables in use; learn.js replaces them after each fit. */
let current = { reaction: {}, volatility: {}, scoreReaction: { n: 0, beta: 1 }, fittedAt: 0 };
export const tables = () => current;
export function setTables(t) {
  current = { ...current, ...t };
}

// ---------------------------------------------------------------------------
// server/insights/learn.js
// The system getting better on its own, once a night (04:00 UTC) or on demand.
//
//   1 histories      Polymarket price paths of finished tracked matches,
//                    cached on disk (5-minute buckets around each match)
//   2 reaction       reaction and volatility tables refitted on all of it,
//                    after a walk-forward check (fit on older matches, score
//                    on newer ones) that is kept in the report
//   3 score fades    from recorded ticks: how much of a post-score jump holds
//   4 weights        analyst weights refitted against what prices did 30 min
//                    after each decision; adopted only if they beat both the
//                    current weights and "no change" on later, unseen decisions
//   5 whale reasons  points per signal reason from settled whale bets
//   6 champions      a challenger variant that beat its champion over enough
//                    settled bets (bootstrap, 95%) takes over; a champion
//                    losing with 95% confidence loses its real-money permission
//   7 allocation     Thompson sampling: each strategy's share of the stake
//                    follows how likely it is to be the best one right now
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import * as pm from './polymarket.js';
import * as db from './db.js';
import { col, touch, logLine, insightsDir } from './store.js';
import { fitTables, walkForward, samplesOf, setTables, tables, fitScoreReaction, scoreEpisodes } from './reaction.js';
import { ANALYST_KEYS, getWeights, setWeights } from './analysts.js';
import { setLearnedPoints } from './signals.js';
import { STRATEGY_DEFS, strategies } from './brain.js';
import { listRecordings, readRecording } from './recorder.js';
import { replayMids } from './backtest.js';

const HOUR = 3600e3;
export const learnStatus = { running: false, lastRun: 0, lastReport: null, error: '', step: '' };

function historyDir() {
  return path.join(insightsDir(), 'history');
}

/** Price paths of finished, tracked matches, fetched once and cached. */
export async function loadHistories({ fetchLimit = 400 } = {}) {
  fs.mkdirSync(historyDir(), { recursive: true });
  const out = [];
  let fetched = 0;
  for (const ev of Object.values(col('events'))) {
    if (!ev.settledAt || !ev.start) continue;
    const m = ev.markets.find((x) => x.kind === 'match');
    if (!m) continue;
    const file = path.join(historyDir(), `${m.conditionId}.json`);
    let pathPts = null;
    try {
      pathPts = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      if (fetched >= fetchLimit) continue;
      fetched++;
      try {
        const body = await pm.priceHistory({ token_id: m.tokens[0], start: Math.floor((ev.start - 24 * HOUR) / 1000), end: Math.floor(Math.min(Date.now(), ev.start + 8 * HOUR) / 1000), bucket_seconds: 300, limit: 2000 });
        pathPts = (body?.data || []).map((p) => [p.timestamp * 1000, Number(p.price)]).filter(([, p]) => p > 0 && p < 1);
        fs.writeFileSync(file, JSON.stringify(pathPts));
      } catch {
        continue;
      }
    }
    if (pathPts?.length > 3) out.push({ id: ev.id, start: ev.start, path: pathPts });
  }
  return { matches: out, fetched };
}

// ---- ridge regression (few features, closed form) -------------------------------------

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function ridge(X, y, lambda = 1, prior = null) {
  const k = X[0]?.length || 0;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let p = 0; p < k; p++) {
      b[p] += X[i][p] * y[i];
      for (let q = 0; q < k; q++) A[p][q] += X[i][p] * X[i][q];
    }
  }
  // Shrink toward the prior weights rather than toward zero.
  for (let p = 0; p < k; p++) {
    A[p][p] += lambda;
    b[p] += lambda * (prior ? prior[p] : 0);
  }
  return solve(A, b);
}

const mse = (X, y, w) => X.reduce((s, x, i) => s + (x.reduce((a, v, j) => a + v * w[j], 0) - y[i]) ** 2, 0) / Math.max(1, X.length);

/** Analyst weights against the 30-minute move, walk-forward. */
export function fitWeights(rows) {
  const usable = rows.filter((r) => Array.isArray(r.analysts) && Number.isFinite(r.m30) && Number.isFinite(r.p_market) && r.side === 'BUY');
  const X = [];
  const y = [];
  for (const r of usable) {
    const by = Object.fromEntries(r.analysts.map((a) => [a.key, a]));
    X.push(ANALYST_KEYS.map((k) => (by[k] ? by[k].shift * by[k].conf : 0)));
    y.push(r.m30 - r.p_market);
  }
  const cut = Math.floor(X.length * 0.75);
  const cur = ANALYST_KEYS.map((k) => getWeights()[k] ?? 1);
  if (cut < 150) return { adopted: false, reason: `Only ${X.length} decisions with a 30-minute follow-up; need 200`, n: X.length };
  const w = ridge(X.slice(0, cut), y.slice(0, cut), 5, cur);
  if (!w) return { adopted: false, reason: 'Could not fit', n: X.length };
  const Xt = X.slice(cut);
  const yt = y.slice(cut);
  const test = { fitted: mse(Xt, yt, w), current: mse(Xt, yt, cur), none: mse(Xt, yt, cur.map(() => 0)) };
  const better = test.fitted < test.current && test.fitted < test.none;
  const full = better ? ridge(X, y, 5, cur) : null;
  return {
    adopted: Boolean(better && full),
    n: X.length,
    test,
    weights: Object.fromEntries(ANALYST_KEYS.map((k, i) => [k, Math.round(((better && full ? full : cur)[i]) * 1000) / 1000])),
    reason: better ? 'Beat current weights and no-change on later decisions' : 'Did not beat the current weights on later decisions'
  };
}

/** Points per whale-signal reason from settled bets, checked on later bets. */
export function fitReasonPoints() {
  const flags = new Map(col('flags').filter((f) => f.kind === 'entry').map((f) => [f.id, f]));
  const rows = [];
  for (const w of Object.values(col('wallets'))) {
    for (const e of w.entries) {
      if (e.result !== 'won' && e.result !== 'lost') continue;
      const f = flags.get(e.flagId);
      if (f) rows.push({ at: e.at, won: e.result === 'won', price: e.price, reasons: f.reasons.map((r) => r.key) });
    }
  }
  rows.sort((a, b) => a.at - b.at);
  const cut = Math.floor(rows.length * 0.7);
  const tally = (set) => {
    const m = new Map();
    for (const r of set) {
      for (const k of r.reasons) {
        const t = m.get(k) || { n: 0, wins: 0, price: 0 };
        t.n++;
        t.price += r.price;
        if (r.won) t.wins++;
        m.set(k, t);
      }
    }
    return m;
  };
  const train = tally(rows.slice(0, cut));
  const test = tally(rows.slice(cut));
  const points = {};
  const detail = [];
  for (const [k, t] of train) {
    if (k === 'size') continue;
    const edge = (t.wins + 2) / (t.n + 4) - t.price / t.n;
    const tt = test.get(k);
    const testEdge = tt ? tt.wins / tt.n - tt.price / tt.n : null;
    const holds = tt && tt.n >= 15 && Math.sign(testEdge) === Math.sign(edge);
    if (t.n >= 40 && holds) points[k] = Math.round(Math.max(-20, Math.min(25, edge * 60)));
    detail.push({ key: k, n: t.n, edge, testN: tt?.n || 0, testEdge, used: k in points });
  }
  return { points, detail, settled: rows.length };
}

// ---- champion / challenger ---------------------------------------------------------------

function returnsOf(variant, since) {
  return col('bets')
    .filter((b) => b.variant === variant && b.settledAt && b.settledAt >= since && b.cost > 0 && ['won', 'lost', 'sold', 'void'].includes(b.status))
    .sort((a, b) => a.settledAt - b.settledAt)
    .map((b) => ((b.payout || 0) - b.cost) / b.cost);
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** P(mean(a) > mean(b)) by bootstrap. */
export function probBetter(a, b, iters = 2000, rnd = Math.random) {
  if (!a.length || !b.length) return 0.5;
  let wins = 0;
  for (let i = 0; i < iters; i++) {
    let sa = 0;
    let sb = 0;
    for (let j = 0; j < a.length; j++) sa += a[Math.floor(rnd() * a.length)];
    for (let j = 0; j < b.length; j++) sb += b[Math.floor(rnd() * b.length)];
    if (sa / a.length > sb / b.length) wins++;
  }
  return wins / iters;
}

export function reviewChampions() {
  const s = col('settings');
  const st = strategies();
  const since = Date.now() - 60 * 86400e3;
  const out = [];
  for (const [key, def] of Object.entries(STRATEGY_DEFS)) {
    const champ = st[key].champion;
    const cr = returnsOf(champ, since);
    const row = { strategy: key, champion: champ, n: cr.length, mean: mean(cr), challengers: [] };
    let best = null;
    for (const v of Object.keys(def.variants)) {
      if (v === champ) continue;
      const r = returnsOf(v, since);
      const p = probBetter(r, cr);
      row.challengers.push({ variant: v, n: r.length, mean: mean(r), pBetter: p });
      if (r.length >= 30 && cr.length >= 30 && p >= 0.95 && mean(r) > 0 && (!best || p > best.p)) best = { v, p, n: r.length, m: mean(r) };
    }
    if (best) {
      const realOn = st[key].realAllowed && s.mode === 'real';
      if (realOn && !s.autoPromoteReal) {
        st[key].pendingPromotion = { variant: best.v, at: Date.now(), pBetter: best.p, n: best.n, mean: best.m };
        row.action = `Ready to promote ${best.v} (needs your approval for real money)`;
      } else if (s.autoPromote) {
        st[key].history = [...(st[key].history || []), { at: Date.now(), from: champ, to: best.v, pBetter: best.p }].slice(-20);
        st[key].champion = best.v;
        st[key].pendingPromotion = null;
        row.action = `Promoted ${best.v} over ${champ}`;
        logLine('info', `${key}: ${best.v} promoted over ${champ} (P better ${(best.p * 100).toFixed(0)}%, ${best.n} bets)`);
      }
    }
    // A champion that is losing with confidence stops trading real money.
    const recent = cr.slice(-40);
    if (recent.length >= 30 && probBetter(recent.map(() => 0), recent) >= 0.95 && st[key].realAllowed) {
      st[key].realAllowed = false;
      row.action = `${champ} lost with 95% confidence over its last ${recent.length} bets: real money switched off for ${key}`;
      logLine('error', row.action);
    }
    out.push(row);
  }
  touch('strategies');
  return out;
}

/** Thompson sampling over strategies: share of draws in which each one is the best. */
export function allocate(rnd = Math.random) {
  const st = strategies();
  const keys = Object.keys(STRATEGY_DEFS).filter((k) => st[k].enabled);
  if (!keys.length) return {};
  const since = Date.now() - 60 * 86400e3;
  const post = keys.map((k) => {
    const r = returnsOf(st[k].champion, since);
    const n0 = 10;
    const n = r.length;
    const m = (r.reduce((s, x) => s + x, 0) + 0 * n0) / (n + n0);
    const v = r.length > 1 ? r.reduce((s, x) => s + (x - mean(r)) ** 2, 0) / (r.length - 1) : 0.5;
    return { k, m, sd: Math.sqrt((v + 0.25) / (n + n0)) };
  });
  const wins = Object.fromEntries(keys.map((k) => [k, 0]));
  const draws = 4000;
  const gauss = () => {
    const u = 1 - rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  for (let i = 0; i < draws; i++) {
    let best = null;
    let bestV = -Infinity;
    for (const p of post) {
      const x = p.m + p.sd * gauss();
      if (x > bestV) {
        bestV = x;
        best = p.k;
      }
    }
    wins[best]++;
  }
  const floor = 0.1;
  const raw = keys.map((k) => Math.max(floor, wins[k] / draws));
  const sum = raw.reduce((s, x) => s + x, 0);
  const alloc = {};
  keys.forEach((k, i) => {
    alloc[k] = raw[i] / sum;
    st[k].allocation = alloc[k];
  });
  for (const k of Object.keys(STRATEGY_DEFS)) if (!keys.includes(k)) st[k].allocation = 0;
  touch('strategies');
  return { alloc, posterior: post };
}

// ---- the run -------------------------------------------------------------------------------

export async function runTraining() {
  if (learnStatus.running) return learnStatus.lastReport;
  learnStatus.running = true;
  learnStatus.error = '';
  const report = { at: Date.now() };
  try {
    learnStatus.step = 'Price histories';
    const { matches, fetched } = await loadHistories();
    report.histories = { matches: matches.length, fetched };

    learnStatus.step = 'Reaction tables';
    const wf = walkForward(matches);
    const fit = fitTables(matches.flatMap((m) => samplesOf(m)));
    setTables({ reaction: fit.reaction, volatility: fit.volatility, fittedAt: Date.now() });
    report.reaction = { walkForward: wf, samples: fit.samples, cells: Object.keys(fit.reaction).length };
    db.saveModel('reaction', { reaction: fit.reaction, volatility: fit.volatility, walkForward: wf }, true);

    learnStatus.step = 'Score reactions';
    const episodes = [];
    for (const rec of listRecordings().slice(-400)) {
      const lines = await readRecording(rec.file).catch(() => []);
      const scoreTimes = lines.filter((l) => l.k === 's').map((l) => l.t);
      if (!scoreTimes.length) continue;
      const tokens = [...new Set(lines.filter((l) => l.a).map((l) => l.a))];
      for (const tok of tokens.slice(0, 2)) episodes.push(...scoreEpisodes(replayMids(lines, tok), scoreTimes));
    }
    const sr = fitScoreReaction(episodes);
    setTables({ scoreReaction: sr });
    report.scoreReaction = sr;
    db.saveModel('scoreReaction', sr, true);

    learnStatus.step = 'Analyst weights';
    const wfit = fitWeights(db.trainingRows(Date.now() - 90 * 86400e3));
    if (wfit.adopted) setWeights(wfit.weights);
    report.weights = wfit;
    db.saveModel('weights', { weights: wfit.weights, test: wfit.test, n: wfit.n, reason: wfit.reason }, wfit.adopted);

    learnStatus.step = 'Whale reasons';
    const rp = fitReasonPoints();
    setLearnedPoints(rp.points);
    report.reasons = rp;
    db.saveModel('reasons', rp, true);

    learnStatus.step = 'Champions';
    report.champions = reviewChampions();
    learnStatus.step = 'Allocation';
    report.allocation = allocate();
    db.saveModel('report', report, true);
    learnStatus.lastReport = report;
    learnStatus.lastRun = Date.now();
    logLine('info', `Training done: ${matches.length} matches, reaction corr ${wf.corr === null ? '-' : wf.corr.toFixed(3)}, weights ${wfit.adopted ? 'updated' : 'kept'}`);
  } catch (err) {
    learnStatus.error = err.message;
    logLine('error', `training: ${err.message}`);
  } finally {
    learnStatus.running = false;
    learnStatus.step = '';
  }
  return report;
}

/** Load the adopted models from the database into memory (at boot). */
export function restoreModels() {
  const r = db.latestModel('reaction');
  if (r) setTables({ reaction: r.reaction, volatility: r.volatility, fittedAt: r.at });
  const sr = db.latestModel('scoreReaction');
  if (sr) setTables({ scoreReaction: { n: sr.n, beta: sr.beta } });
  const w = db.latestModel('weights');
  if (w?.weights) setWeights(w.weights);
  const rp = db.latestModel('reasons');
  if (rp?.points) setLearnedPoints(rp.points);
  learnStatus.lastReport = db.latestModel('report', false);
  learnStatus.lastRun = learnStatus.lastReport?.at || 0;
}

/** Nightly at 04:00 UTC, plus a first run soon after boot when nothing was ever fitted. */
export function scheduleTraining({ firstRun = true } = {}) {
  const plan = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    const t = setTimeout(async () => {
      await runTraining();
      plan();
    }, next.getTime() - now.getTime());
    t.unref?.();
  };
  plan();
  if (firstRun && !tables().fittedAt) {
    const t = setTimeout(() => runTraining(), 5 * 60e3);
    t.unref?.();
  }
}

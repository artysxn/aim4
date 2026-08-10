#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Fit Rating 3.0 against HLTV's published ratings.
//
// The candidate parameters are pushed through the SAME functions the site runs
// (src/replays/shared/rating3.js), over rows shaped exactly like the stats
// index writes them. Training and production therefore cannot drift: if the
// fit is good here, the number on the site is the number fitted here.
//
// Swing is an input, not something this fits. The ground-truth file carries
// HLTV's swing so the rest of the formula can be judged against their
// published ratings; the site feeds its own swing at runtime.
//
// The optimizer is the one the duel and round models settled on: Adam on
// numeric gradients, a coordinate polish sweep that only ever keeps an
// improvement, and annealed mutation that grows while progress stalls.
//
// Usage:
//   node scripts/rating3-train.mjs --generations 0     score the shipped params
//   node scripts/rating3-train.mjs --generations 70
//   node scripts/rating3-train.mjs --generations 40 --holdout-demo <name>
//   node scripts/rating3-train.mjs --generations 70 --write
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listSamplePackages, loadPackage } from './lib/sampledemoPackages.mjs';
import { packageRows } from './lib/rating3Rows.mjs';
import {
  RATING3_PARAMS,
  addRating3Round,
  emptyRating3,
  rating3Breakdown,
  rating3RoundContext,
  rating3RoundFacts
} from '../src/replays/shared/rating3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRUTH = path.join(__dirname, 'rating3-groundtruth.json');
const MODULE = path.join(__dirname, '../src/replays/shared/rating3.js');

const arg = (name, fb) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fb;
};
const GENERATIONS = Number(arg('--generations', 70));
const SEED = Number(arg('--seed', 12345));
const ADAM_STEPS = Number(arg('--adam-steps', 30));
const POP = Number(arg('--pop', 14));
const HOLD_DEMO = arg('--holdout-demo', '');
const WRITE = process.argv.includes('--write');

/** Search bounds. Keys must match RATING3_PARAMS exactly. */
const SPEC = [
  { key: 'ecoA', min: 0.2, max: 4.0 },
  { key: 'ecoB', min: -0.5, max: 0.8 },
  { key: 'decoA', min: 0, max: 4.0 },
  { key: 'decoB', min: -0.5, max: 1.5 },
  { key: 'okBonus', min: -0.5, max: 1.5 },
  { key: 'denialBonus', min: -0.5, max: 1.5 },
  { key: 'tradeKillBonus', min: -1.0, max: 1.0 },
  { key: 'assistPts', min: -0.5, max: 1.5 },
  { key: 'assistedShare', min: 0, max: 0.8 },
  { key: 'odCost', min: -1.5, max: 0.5 },
  { key: 'ftCost', min: -1.5, max: 0.5 },
  { key: 'tdCost', min: -1.5, max: 0.5 },
  { key: 'saveCost', min: -1.5, max: 0.5 },
  { key: 'mk2w', min: 0, max: 1.5 },
  { key: 'mk3w', min: 0, max: 2.5 },
  { key: 'mk4w', min: 0, max: 4.0 },
  { key: 'mk5w', min: 0, max: 6.0 },
  { key: 'cw1', min: -0.5, max: 2.0 },
  { key: 'cwPer', min: -0.5, max: 2.0 },
  { key: 'clLostCost', min: -1.0, max: 1.0 },
  { key: 'mkEco', min: -2.0, max: 2.0 },
  { key: 'kastEco', min: -2.0, max: 2.0 },
  { key: 'killLostMult', min: 0.4, max: 2.8 },
  { key: 'deathWonMult', min: 0.4, max: 2.8 },
  { key: 'pistolKillMult', min: 0.3, max: 2.6 },
  { key: 'etaOpp', min: -2.5, max: 4.0 },
  { key: 'wKills', min: 0, max: 1.5 },
  { key: 'wDmg', min: 0, max: 1.2 },
  { key: 'wSurv', min: 0, max: 1.5 },
  { key: 'wKast', min: 0, max: 2.0 },
  { key: 'wMk', min: 0, max: 1.5 },
  { key: 'wSwPos', min: -0.02, max: 0.10 },
  { key: 'wSwNeg', min: -0.02, max: 0.10 },
  { key: 'c0', min: -0.5, max: 1.5 },
  { key: 'wOppShare', min: -0.8, max: 0.8 },
  { key: 'pw', min: 0.7, max: 1.4 }
];
const P = SPEC.length;
const RANGE = SPEC.map((s) => s.max - s.min);
const clampVec = (v) => {
  for (let i = 0; i < P; i++) v[i] = Math.min(SPEC[i].max, Math.max(SPEC[i].min, v[i]));
  return v;
};
const toNamed = (v) => Object.fromEntries(SPEC.map((s, i) => [s.key, v[i]]));

const stripKey = (s) => String(s || '').replace(/[\d-]/g, '').toLowerCase();
const edit = (a, b) => {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
};

/**
 * Per-player round facts, resolved once. Facts do not depend on the
 * parameters, so the whole fit walks a plain array instead of re-deriving
 * trades and clutches on every candidate.
 */
async function loadSubjects() {
  const truth = JSON.parse(await fs.readFile(TRUTH, 'utf8'));
  const byDemo = new Map(truth.map((t) => [t.demo, t]));
  const subjects = [];

  for (const file of await listSamplePackages()) {
    const name = path.basename(file, '.aim4replay');
    const table = byDemo.get(name);
    if (!table) continue;
    const pkg = await loadPackage(file);
    const { roster, teamOf, rows } = await packageRows(pkg);

    const factsById = new Map(roster.map((p) => [p.id, []]));
    for (const row of rows) {
      const ctx = rating3RoundContext(row, teamOf);
      for (const pl of roster) {
        factsById.get(pl.id).push(rating3RoundFacts(ctx, pl.id, pl.team));
      }
    }

    const used = new Set();
    for (const pl of roster) {
      let best = null;
      let bestD = Infinity;
      for (const r of table.rows) {
        if (used.has(r.nick)) continue;
        const d = edit(stripKey(pl.name), r.nick);
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
      if (!best || bestD > 2) continue;
      used.add(best.nick);
      subjects.push({
        id: `${pl.name}@${name}`,
        demo: name,
        name: pl.name,
        facts: factsById.get(pl.id),
        swing: best.swing,
        y: best.rating
      });
    }
  }
  return subjects;
}

function predict(subject, params) {
  const acc = emptyRating3();
  for (const f of subject.facts) addRating3Round(acc, f, params);
  return rating3Breakdown(acc, { swing: subject.swing }, params).value;
}

function makeLoss(set) {
  return (v) => {
    const params = toNamed(v);
    let mse = 0;
    let worst = 0;
    for (const s of set) {
      const e = predict(s, params) - s.y;
      mse += e * e;
      const a = Math.abs(e);
      if (a > worst) worst = a;
    }
    return mse / set.length + 0.25 * worst * worst;
  };
}

function report(v, set) {
  const params = toNamed(v);
  let mae = 0;
  let max = 0;
  let exact = 0;
  const errs = [];
  for (const s of set) {
    const pr = predict(s, params);
    const e = pr - s.y;
    errs.push({ id: s.id, y: s.y, pred: pr, err: e });
    mae += Math.abs(e);
    if (Math.abs(e) > max) max = Math.abs(e);
    if (Math.abs(Math.round(pr * 100) / 100 - s.y) < 0.005) exact++;
  }
  return { mae: mae / set.length, max, exact, n: set.length, errs };
}

function createRng(seed) {
  let s = seed >>> 0 || 1;
  return {
    next() {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    },
    normal() {
      const u = Math.max(1e-9, this.next());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
    }
  };
}

const FD_FRAC = 0.002;
const LR_FRAC = 0.004;
const SIGMA_FRAC = 0.05;
const POLISH_STEPS = [0.002, 0.008, 0.03, 0.1, 0.25];
const ANNEAL_T0 = 0.0004;
const ANNEAL_T1 = 0.00001;

async function main() {
  const all = await loadSubjects();
  console.log(`subjects: ${all.length} player-maps across ${new Set(all.map((s) => s.demo)).size} demos`);
  const train = HOLD_DEMO ? all.filter((s) => s.demo !== HOLD_DEMO) : all;
  const hold = HOLD_DEMO ? all.filter((s) => s.demo === HOLD_DEMO) : [];
  const loss = makeLoss(train);

  const rng = createRng(SEED);
  let elite = Float64Array.from(SPEC.map((s) => RATING3_PARAMS[s.key]));
  clampVec(elite);

  const adamM = new Float64Array(P);
  const adamV = new Float64Array(P);
  let adamT = 0;
  let stall = 0;
  let bestLoss = loss(elite);
  let bestVec = Float64Array.from(elite);

  for (let gen = 1; gen <= GENERATIONS; gen++) {
    for (let step = 0; step < ADAM_STEPS; step++) {
      adamT++;
      for (let i = 0; i < P; i++) {
        const h = RANGE[i] * FD_FRAC;
        const up = Float64Array.from(elite);
        up[i] += h;
        const dn = Float64Array.from(elite);
        dn[i] -= h;
        const g = (loss(clampVec(up)) - loss(clampVec(dn))) / (2 * h);
        adamM[i] = 0.9 * adamM[i] + 0.1 * g;
        adamV[i] = 0.999 * adamV[i] + 0.001 * g * g;
        const mHat = adamM[i] / (1 - Math.pow(0.9, adamT));
        const vHat = adamV[i] / (1 - Math.pow(0.999, adamT));
        elite[i] -= (LR_FRAC * RANGE[i] * mHat) / (Math.sqrt(vHat) + 1e-8);
      }
      clampVec(elite);
    }

    let cur = loss(elite);
    for (let i = 0; i < P; i++) {
      const start = elite[i];
      let bestVal = start;
      for (const frac of POLISH_STEPS) {
        for (const cand of [start - frac * RANGE[i], start + frac * RANGE[i]]) {
          const c = Math.min(SPEC[i].max, Math.max(SPEC[i].min, cand));
          if (c === bestVal) continue;
          elite[i] = c;
          const l = loss(elite);
          if (l < cur - 1e-10) {
            cur = l;
            bestVal = c;
          }
        }
      }
      elite[i] = bestVal;
    }

    const boost = Math.min(6, 1 + 0.5 * stall);
    const temp =
      ANNEAL_T0 * Math.pow(ANNEAL_T1 / ANNEAL_T0, (gen - 1) / Math.max(1, GENERATIONS - 1));
    let mutBest = null;
    let mutBestLoss = Infinity;
    for (let m = 0; m < POP; m++) {
      const cand = Float64Array.from(elite);
      for (let i = 0; i < P; i++) cand[i] += rng.normal() * SIGMA_FRAC * RANGE[i] * boost;
      clampVec(cand);
      const l = loss(cand);
      if (l < mutBestLoss) {
        mutBestLoss = l;
        mutBest = cand;
      }
    }
    if (mutBest) {
      const worse = mutBestLoss - cur;
      if (worse < 0 || rng.next() < Math.exp(-worse / temp)) {
        elite = mutBest;
        cur = mutBestLoss;
      }
    }

    if (cur < bestLoss - 1e-9) {
      bestLoss = cur;
      bestVec = Float64Array.from(elite);
      stall = 0;
    } else {
      stall++;
    }
    // A scout that wandered far above the best is recalled; the best vector is
    // kept separately, so wandering can never lose ground.
    if (cur > bestLoss * 1.6) elite = Float64Array.from(bestVec);

    if (gen % 10 === 0 || gen === 1 || gen === GENERATIONS) {
      const rep = report(bestVec, train);
      console.log(
        `gen ${String(gen).padStart(3)}  mae=${rep.mae.toFixed(4)}  max=${rep.max.toFixed(4)}` +
          `  exact=${rep.exact}/${rep.n}${stall ? `  stall ${stall}` : ''}`
      );
    }
  }

  const rep = report(bestVec, train);
  console.log(`\nFINAL train mae=${rep.mae.toFixed(4)} max=${rep.max.toFixed(4)} exact=${rep.exact}/${rep.n}`);
  if (hold.length) {
    const h = report(bestVec, hold);
    console.log(`HOLDOUT ${HOLD_DEMO}: mae=${h.mae.toFixed(4)} max=${h.max.toFixed(4)} n=${h.n}`);
  }
  rep.errs.sort((a, b) => Math.abs(b.err) - Math.abs(a.err));
  console.log('worst 10:');
  for (const e of rep.errs.slice(0, 10)) {
    console.log(`  ${e.id.padEnd(42)} hltv=${e.y.toFixed(2)} ours=${e.pred.toFixed(3)} err=${e.err >= 0 ? '+' : ''}${e.err.toFixed(3)}`);
  }

  const named = toNamed(bestVec);
  console.log('\nparams:');
  console.log(JSON.stringify(named, null, 2));

  if (WRITE) {
    const src = await fs.readFile(MODULE, 'utf8');
    const body = SPEC.map((s) => `  ${s.key}: ${named[s.key]}`).join(',\n');
    const next = src.replace(
      /export const RATING3_PARAMS = \{[\s\S]*?\n\};/,
      `export const RATING3_PARAMS = {\n${body}\n};`
    );
    if (next === src) {
      console.error('Could not find RATING3_PARAMS to rewrite.');
      process.exitCode = 1;
      return;
    }
    await fs.writeFile(MODULE, next, 'utf8');
    console.log(`\nWrote parameters into ${path.relative(path.join(__dirname, '..'), MODULE)}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});

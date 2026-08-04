#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Fit the round win model against the cached snapshots, and sit three exams.
//
// The optimizer is the one the duel model ended up with, for the reasons that
// run was forced to establish:
//
//   - Adam on numeric gradients, at a small learning rate. Adam normalises by
//     the gradient's own size, so a generous rate walks a parameter into a
//     bound and momentum pins it there.
//   - A coordinate polish pass that sweeps each parameter and keeps only what
//     lowers the loss. On the duel model this was where nearly all the gain
//     came from, and it is the only part guaranteed not to make things worse.
//   - Mutation that grows while progress stalls, so the one component that can
//     propose something the data currently argues against tries hardest when
//     the careful methods have run out. On the duel corpus this found nothing
//     in a thousand proposals; whether it finds anything here is a question
//     worth asking again rather than assuming.
//
// THREE EXAMS. The headline loss answers "how good is this model" with one
// number, which hides that predicting a round is three different problems:
//
//   examEarly  at the early to mid transition
//   examMid    at the mid to late transition
//   examFinal  ten seconds before the round ended
//
// Each is graded separately on the held-out demos, alongside the overall
// average across every snapshot.
//
// Selection is on log loss, never on the exam points. The exam is linear in
// confidence, so a model trained on it would learn to shout every call; log
// loss is a proper scoring rule and punishes overclaiming harder than it pays.
//
// Usage:
//   node scripts/train-round-model.mjs --generations 60 --export
//   node scripts/train-round-model.mjs --generations 5 --dry-run
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { predictRound } from '../src/replays/rounds/roundModel.js';
import { ROUND_BUCKET_IDS, bucketizeRound } from '../src/replays/rounds/roundBuckets.js';
import {
  ROUND_PARAM_SPEC,
  clampVector,
  fromNamed,
  initialVector,
  specHash,
  toNamed
} from '../src/replays/rounds/roundParamSpec.js';
import { ROUND_MODEL_PARAMS } from '../src/replays/rounds/roundModelParams.js';
import { createScoreAccumulator, score, summarize } from '../src/replays/duels/scoring.js';
import { CACHE_DIR, loadRoundCorpus } from './lib/roundCorpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../src/replays/rounds/roundModelParams.js');
const LOG = path.join(CACHE_DIR, 'training-log.jsonl');
const CHECKPOINT = path.join(CACHE_DIR, 'checkpoint.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const GENERATIONS = Number(arg('--generations', 60));
const POP = Number(arg('--pop', 10));
const ADAM_STEPS = Number(arg('--adam-steps', 25));
const LIMIT = Number(arg('--limit', 0));
const SEED = Number(arg('--seed', 12345));
const HOLDOUT = Number(arg('--holdout', 0.2));
const WORKERS = Number(arg('--workers', Math.max(1, Math.min(16, os.cpus().length - 2))));
const warmStart = has('--warm-start');
const doExport = has('--export');
const dryRun = has('--dry-run');

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
    },
    get state() {
      return s;
    },
    set state(v) {
      s = v >>> 0 || 1;
    }
  };
}

const SIGMA_FRAC = { grad: 0.02, shape: 0.06 };
const LR_FRAC = { grad: 0.003, shape: 0.0015 };
const POLISH_STEPS = [0.002, 0.008, 0.03, 0.1, 0.25];
const STEER_GAIN = 4;
const FD_FRAC = 0.002;
const ADAM_B1 = 0.9;
const ADAM_B2 = 0.999;
const ADAM_EPS = 1e-8;
/** Mutation grows while progress stalls, and resets on a real improvement. */
const STALL_EPS = 1e-5;
const STALL_GAIN = 0.75;
const STALL_MAX = 10;

/**
 * Annealed acceptance, which is the part that lets the values actually move.
 *
 * Adam and the coordinate sweep only ever step downhill, and strict mutation
 * only keeps what is already better, so once all three agree the search sits
 * still forever whether or not it stopped somewhere good. On the duel corpus
 * that showed up as a thousand consecutive mutations finding nothing, and the
 * same thing happened here.
 *
 * So a mutant that is slightly worse is now accepted with probability
 * exp(-worsening / T), with T cooling over the run. Early on the search is
 * allowed to wander off a local optimum; later it settles. Nothing can be lost
 * by this because the best model ever seen is kept separately and is what gets
 * exported: the wandering point is a scout, not the answer.
 */
const ANNEAL_T0 = 0.0025;
const ANNEAL_T1 = 0.00005;

const RANGE = ROUND_PARAM_SPEC.map((p) => p.max - p.min);
const P_COUNT = ROUND_PARAM_SPEC.length;

/** Flatten rounds into scoreable rows, with buckets resolved once. */
function flatten(rounds) {
  const rows = [];
  for (const r of rounds) {
    for (const s of r.samples) {
      rows.push({
        f: s.f,
        y: s.y,
        w: r.weight,
        map: r.map,
        phase: s.phase,
        exam: s.exam,
        demo: r.demo,
        buckets: bucketizeRound(s.f, s.phase)
      });
    }
  }
  return rows;
}

function evaluate(v, rows) {
  const all = createScoreAccumulator();
  const buckets = new Map(ROUND_BUCKET_IDS.map((id) => [id, createScoreAccumulator()]));
  // Exam rows are single moments, so each counts once rather than carrying the
  // round's shared weight; otherwise a long round's exam would count for less
  // than a short one's for no reason.
  const exams = new Map(
    ['examEarly', 'examMid', 'examFinal'].map((id) => [id, createScoreAccumulator()])
  );
  for (const row of rows) {
    const p = predictRound(row.f, v, row.map);
    score(all, p, row.y, row.w);
    for (const id of row.buckets) score(buckets.get(id), p, row.y, row.w);
    if (row.exam && exams.has(row.exam)) score(exams.get(row.exam), p, row.y, 1);
  }
  const out = summarize(all);
  out.buckets = {};
  for (const [id, acc] of buckets) out.buckets[id] = summarize(acc);
  out.exams = {};
  for (const [id, acc] of exams) out.exams[id] = summarize(acc);
  return out;
}

function batchLoss(v, rows, idx) {
  let loss = 0;
  let weight = 0;
  for (const i of idx) {
    const row = rows[i];
    const p = Math.min(1 - 1e-6, Math.max(1e-6, predictRound(row.f, v, row.map)));
    loss -= (row.y * Math.log(p) + (1 - row.y) * Math.log(1 - p)) * row.w;
    weight += row.w;
  }
  return weight > 0 ? loss / weight : 0;
}

async function createPool(count, { limit, holdout, rows }) {
  if (count <= 1) {
    const allIdx = Int32Array.from({ length: rows.length }, (_, i) => i);
    return {
      size: 1,
      async lossMany(vectors) {
        return vectors.map((v) => batchLoss(v, rows, allIdx));
      },
      async close() {}
    };
  }

  const workerPath = path.join(__dirname, 'lib', 'roundTrainWorker.mjs');
  const workers = [];
  await Promise.all(
    Array.from({ length: count }, (_, shard) => {
      const w = new Worker(workerPath, {
        workerData: { shard, shardCount: count, limit, holdout }
      });
      workers.push(w);
      return new Promise((resolve, reject) => {
        w.once('message', resolve);
        w.once('error', reject);
      });
    })
  );

  let nextId = 0;
  return {
    size: count,
    async lossMany(vectors) {
      const width = vectors[0].length;
      const flat = new Float64Array(vectors.length * width);
      for (let i = 0; i < vectors.length; i++) flat.set(vectors[i], i * width);
      const id = nextId++;
      const replies = await Promise.all(
        workers.map(
          (w) =>
            new Promise((resolve, reject) => {
              const copy = flat.slice();
              const onMessage = (msg) => {
                if (msg.id !== id) return;
                w.off('message', onMessage);
                w.off('error', onError);
                resolve(new Float64Array(msg.buffer));
              };
              const onError = (err) => {
                w.off('message', onMessage);
                reject(err);
              };
              w.on('message', onMessage);
              w.once('error', onError);
              w.postMessage({ type: 'eval', id, count: vectors.length, buffer: copy.buffer }, [
                copy.buffer
              ]);
            })
        )
      );
      return vectors.map((_, i) => {
        let loss = 0;
        let weight = 0;
        for (const r of replies) {
          loss += r[i * 2];
          weight += r[i * 2 + 1];
        }
        return weight > 0 ? loss / weight : 0;
      });
    },
    async close() {
      for (const w of workers) w.postMessage({ type: 'stop' });
      await Promise.all(workers.map((w) => w.terminate()));
    }
  };
}

async function numericGradient(v, pool, out) {
  const probes = [];
  for (let i = 0; i < P_COUNT; i++) {
    const h = RANGE[i] * FD_FRAC;
    const up = Float64Array.from(v);
    up[i] = v[i] + h;
    const down = Float64Array.from(v);
    down[i] = v[i] - h;
    probes.push(up, down);
  }
  const losses = await pool.lossMany(probes);
  for (let i = 0; i < P_COUNT; i++) {
    const h = RANGE[i] * FD_FRAC;
    out[i] = (losses[i * 2] - losses[i * 2 + 1]) / (2 * h);
  }
  return out;
}

/** Sweep every parameter one at a time and keep whatever is better. */
async function coordinatePolish(v, pool) {
  let bestLoss = (await pool.lossMany([Float64Array.from(v)]))[0];
  let moved = 0;
  for (let i = 0; i < P_COUNT; i++) {
    const spec = ROUND_PARAM_SPEC[i];
    const start = v[i];
    const values = [];
    const probes = [];
    for (const frac of POLISH_STEPS) {
      const delta = RANGE[i] * frac;
      for (const cand of [start - delta, start + delta]) {
        const clamped = Math.min(spec.max, Math.max(spec.min, cand));
        if (clamped === start || values.includes(clamped)) continue;
        const probe = Float64Array.from(v);
        probe[i] = clamped;
        values.push(clamped);
        probes.push(probe);
      }
    }
    if (!probes.length) continue;
    const losses = await pool.lossMany(probes);
    let bestVal = start;
    for (let k = 0; k < values.length; k++) {
      if (losses[k] < bestLoss - 1e-9) {
        bestLoss = losses[k];
        bestVal = values[k];
      }
    }
    v[i] = bestVal;
    if (bestVal !== start) moved++;
  }
  return { loss: bestLoss, moved };
}

/** Blame from calibration error, not loss: some rounds are simply uncertain. */
function blamePerParam(report) {
  const blame = new Float64Array(P_COUNT);
  for (let i = 0; i < P_COUNT; i++) {
    let worst = 0;
    for (const id of ROUND_PARAM_SPEC[i].buckets) {
      const b = report.buckets[id];
      if (!b || b.n < 25) continue;
      if (b.calibration > worst) worst = b.calibration;
    }
    blame[i] = worst;
  }
  return blame;
}

function mutate(v, blame, rng, out, boost = 1) {
  for (let i = 0; i < P_COUNT; i++) {
    const spec = ROUND_PARAM_SPEC[i];
    const sigma = SIGMA_FRAC[spec.group] * RANGE[i] * (1 + STEER_GAIN * blame[i]) * boost;
    out[i] = v[i] + rng.normal() * sigma;
  }
  return clampVector(out);
}

const fmtExam = (s) =>
  `${s.examTotal >= 0 ? '+' : ''}${s.examTotal.toFixed(0)} (${s.exam.toFixed(2)}/ea over ${s.weight.toFixed(0)})`;

function fmtBuckets(report) {
  const lines = [];
  for (const id of ROUND_BUCKET_IDS) {
    const b = report.buckets[id];
    if (!b || !b.n) continue;
    lines.push(
      `    ${id.padEnd(13)} rounds=${b.weight.toFixed(0).padStart(5)}` +
        `  pred=${(b.predicted * 100).toFixed(1).padStart(5)}%` +
        `  actual=${(b.actual * 100).toFixed(1).padStart(5)}%` +
        `  off=${(b.calibration * 100).toFixed(1).padStart(4)}pt` +
        `  loss=${b.logLoss.toFixed(3)}`
    );
  }
  return lines.join('\n');
}

function fmtExams(report) {
  const names = {
    examEarly: 'early to mid',
    examMid: 'mid to late',
    examFinal: '10s before end'
  };
  const lines = [];
  for (const [id, label] of Object.entries(names)) {
    const e = report.exams[id];
    if (!e || !e.n) continue;
    lines.push(
      `    ${label.padEnd(15)} n=${String(e.n).padStart(4)}` +
        `  loss=${e.logLoss.toFixed(4)}` +
        `  exam=${((e.examTotal >= 0 ? '+' : '') + e.examTotal.toFixed(0)).padStart(6)}` +
        ` (${e.exam.toFixed(2)}/round)` +
        `  pred=${(e.predicted * 100).toFixed(1)}%  actual=${(e.actual * 100).toFixed(1)}%` +
        `  off=${(e.calibration * 100).toFixed(1)}pt`
    );
  }
  return lines.join('\n');
}

async function main() {
  console.log(`Loading round corpus from ${CACHE_DIR} ...`);
  const { rounds, demos } = await loadRoundCorpus({ limit: LIMIT });
  if (!rounds.length) {
    console.error('Cache is empty. Run: node scripts/extract-round-snapshots.mjs');
    process.exitCode = 1;
    return;
  }

  // Split by demo, never by round: rounds inside one match share an economy,
  // a roster and a map, so splitting rounds would leak across the divide.
  const names = [...new Set(rounds.map((r) => r.demo))].sort();
  const holdCount = Math.max(1, Math.round(names.length * HOLDOUT));
  const holdout = new Set(names.slice(0, holdCount));
  const trainRounds = rounds.filter((r) => !holdout.has(r.demo));
  const validRounds = rounds.filter((r) => holdout.has(r.demo));

  const trainRows = flatten(trainRounds);
  const validRows = flatten(validRounds);
  const ctShare = rounds.filter((r) => r.winnerSide === 'CT').length / rounds.length;
  console.log(
    `demos=${demos.length}  rounds=${rounds.length}  CT won ${(ctShare * 100).toFixed(1)}%\n` +
      `train=${trainRounds.length} rounds / ${trainRows.length} snapshots  ` +
      `validation=${validRounds.length} rounds / ${validRows.length} snapshots`
  );
  console.log(`parameters=${P_COUNT}  spec=${specHash()}`);

  const rng = createRng(SEED);
  let elite = initialVector();
  if (warmStart && ROUND_MODEL_PARAMS.trainedOn > 0) {
    elite = fromNamed(ROUND_MODEL_PARAMS.values);
    console.log(`Warm start from the exported model (${ROUND_MODEL_PARAMS.trainedOn} rounds).`);
  }

  const pool = await createPool(WORKERS, { limit: LIMIT, holdout: HOLDOUT, rows: trainRows });
  console.log(
    pool.size > 1
      ? `scoring on ${pool.size} threads, corpus split ${pool.size} ways\n`
      : 'scoring in-process on one thread\n'
  );

  let best = evaluate(elite, trainRows);
  let bestValid = evaluate(elite, validRows);
  let bestVec = Float64Array.from(elite);
  let bestGen = 0;
  const adamM = new Float64Array(P_COUNT);
  const adamV = new Float64Array(P_COUNT);
  let adamT = 0;
  const grad = new Float64Array(P_COUNT);
  const candidate = new Float64Array(P_COUNT);
  let stall = 0;
  const mutationStats = { tried: 0, accepted: 0, wandered: 0, bestBoost: 1 };
  let bestTrain = best.logLoss;

  for (let gen = 1; gen <= GENERATIONS; gen++) {
    const blame = blamePerParam(best);
    for (let step = 0; step < ADAM_STEPS; step++) {
      await numericGradient(elite, pool, grad);
      adamT++;
      for (let i = 0; i < P_COUNT; i++) {
        adamM[i] = ADAM_B1 * adamM[i] + (1 - ADAM_B1) * grad[i];
        adamV[i] = ADAM_B2 * adamV[i] + (1 - ADAM_B2) * grad[i] * grad[i];
        const mHat = adamM[i] / (1 - Math.pow(ADAM_B1, adamT));
        const vHat = adamV[i] / (1 - Math.pow(ADAM_B2, adamT));
        const lr = LR_FRAC[ROUND_PARAM_SPEC[i].group] * RANGE[i] * (1 + STEER_GAIN * blame[i]);
        elite[i] -= (lr * mHat) / (Math.sqrt(vHat) + ADAM_EPS);
      }
      clampVector(elite);
    }

    const polish = await coordinatePolish(elite, pool);
    let report = evaluate(elite, trainRows);
    let winner = Float64Array.from(elite);

    const boost = Math.min(STALL_MAX, 1 + STALL_GAIN * stall);
    const mutants = [];
    for (let m = 0; m < POP; m++) {
      mutate(elite, blame, rng, candidate, boost);
      mutants.push(Float64Array.from(candidate));
    }
    mutationStats.tried += POP;
    const mutantLoss = await pool.lossMany(mutants);
    // Cool geometrically from ANNEAL_T0 to ANNEAL_T1 across the run.
    const temp =
      GENERATIONS > 1
        ? ANNEAL_T0 * Math.pow(ANNEAL_T1 / ANNEAL_T0, (gen - 1) / (GENERATIONS - 1))
        : ANNEAL_T1;

    let pick = -1;
    let pickLoss = Infinity;
    for (let m = 0; m < mutants.length; m++) {
      if (mutantLoss[m] < pickLoss) {
        pickLoss = mutantLoss[m];
        pick = m;
      }
    }
    if (pick >= 0) {
      const worse = pickLoss - report.logLoss;
      const takeIt = worse < 0 || rng.next() < Math.exp(-worse / temp);
      if (takeIt) {
        const trial = evaluate(mutants[pick], trainRows);
        if (worse < 0) mutationStats.accepted++;
        else mutationStats.wandered++;
        if (boost > mutationStats.bestBoost) mutationStats.bestBoost = boost;
        report = trial;
        winner = mutants[pick];
      }
    }

    elite = winner;
    // Stall is measured against the best training loss ever reached, not the
    // last generation's, so a deliberate wander does not read as progress.
    const improvement = bestTrain - report.logLoss;
    stall = improvement < STALL_EPS ? stall + 1 : 0;
    if (report.logLoss < bestTrain) bestTrain = report.logLoss;
    best = report;

    const valid = evaluate(elite, validRows);
    if (valid.logLoss < bestValid.logLoss) {
      bestValid = valid;
      bestVec = Float64Array.from(elite);
      bestGen = gen;
    }

    const ex = (id) => {
      const e = valid.exams[id];
      if (!e || !e.n) return '   n/a   ';
      const pts = (e.exam >= 0 ? '+' : '') + e.exam.toFixed(2);
      return `${e.logLoss.toFixed(4)}/${pts.padStart(6)}`;
    };
    console.log(
      `gen ${String(gen).padStart(3)}  train=${report.logLoss.toFixed(4)}  val=${valid.logLoss.toFixed(4)}` +
        `  |  E1 ${ex('examEarly')}  E2 ${ex('examMid')}  E3 ${ex('examFinal')}` +
        `  |  polish ${String(polish.moved).padStart(2)}  mut x${boost.toFixed(1)}` +
        `  T=${temp.toFixed(5)}${stall ? `  stall ${stall}` : ''}` +
        `${bestGen === gen ? '  <- best' : ''}`
    );

    if (!dryRun) {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.appendFile(
        LOG,
        JSON.stringify({
          gen,
          seed: SEED,
          at: new Date().toISOString(),
          train: { logLoss: report.logLoss, exam: report.exam, examTotal: report.examTotal },
          validation: {
            logLoss: valid.logLoss,
            exam: valid.exam,
            examTotal: valid.examTotal,
            brier: valid.brier
          },
          exams: valid.exams,
          buckets: valid.buckets,
          params: toNamed(elite)
        }) + '\n',
        'utf8'
      );
      await fs.writeFile(
        CHECKPOINT,
        JSON.stringify({ specHash: specHash(), gen, params: toNamed(elite) }),
        'utf8'
      );
    }
  }

  await pool.close();

  const finalTrain = evaluate(bestVec, trainRows);
  const finalValid = evaluate(bestVec, validRows);
  console.log(
    `\n--- best model: generation ${bestGen}${bestGen === 0 ? ' (the starting point)' : ''}, ` +
      'chosen on held-out loss ---'
  );
  console.log(`train      loss=${finalTrain.logLoss.toFixed(4)}  brier=${finalTrain.brier.toFixed(4)}`);
  console.log(
    `validation loss=${finalValid.logLoss.toFixed(4)}  brier=${finalValid.brier.toFixed(4)}  ` +
      `exam=${fmtExam(finalValid)}`
  );
  console.log(`a coin flip on every round scores loss=${Math.log(2).toFixed(4)}, exam +0`);
  console.log(
    `\nmutation: ${mutationStats.accepted} of ${mutationStats.tried} proposals beat the gradient` +
      ` (strongest accepted boost x${mutationStats.bestBoost.toFixed(1)})`
  );

  console.log('\n=== THE THREE EXAMS (held-out demos) ===');
  console.log(fmtExams(finalValid));
  console.log('\nvalidation by scenario:');
  console.log(fmtBuckets(finalValid));

  if (doExport && !dryRun) {
    await writeParamsModule(bestVec, finalTrain, finalValid, rounds.length);
    console.log(`\nWrote ${path.relative(path.join(__dirname, '..'), OUT)}`);
  } else if (doExport) {
    console.log('\nDry run, params not exported.');
  }
}

async function writeParamsModule(v, train, valid, roundCount) {
  const named = toNamed(v);
  const body = Object.entries(named)
    .map(([k, val]) => `    ${k}: ${Number(val.toFixed(6))}`)
    .join(',\n');
  const exam = (id) => {
    const e = valid.exams[id];
    return e && e.n
      ? `{ logLoss: ${Number(e.logLoss.toFixed(6))}, exam: ${Number(e.exam.toFixed(4))}, n: ${e.n} }`
      : 'null';
  };
  const source = `// ---------------------------------------------------------------------------
// replays/rounds/roundModelParams.js
// GENERATED by scripts/train-round-model.mjs. Do not edit by hand.
//
// Fitted against ${roundCount} rounds from the parsed demos in sampledemos/.
// Validation is held out by demo, so no round contributes to both halves.
//
//   validation log loss  ${valid.logLoss.toFixed(4)}   (a coin flip scores ${Math.log(2).toFixed(4)})
//   validation brier     ${valid.brier.toFixed(4)}
//   training log loss    ${train.logLoss.toFixed(4)}
//
// The three exams, on held-out demos:
//   early to mid    loss ${valid.exams.examEarly ? valid.exams.examEarly.logLoss.toFixed(4) : 'n/a'}
//   mid to late     loss ${valid.exams.examMid ? valid.exams.examMid.logLoss.toFixed(4) : 'n/a'}
//   10s before end  loss ${valid.exams.examFinal ? valid.exams.examFinal.logLoss.toFixed(4) : 'n/a'}
//
// To refit:
//   node scripts/fetch-zone-networks.mjs
//   node scripts/extract-round-snapshots.mjs
//   node scripts/train-round-model.mjs --generations 60 --export
// ---------------------------------------------------------------------------

import { fromNamed } from './roundParamSpec.js';

export const ROUND_MODEL_PARAMS = {
  specHash: '${specHash()}',
  trainedOn: ${roundCount},
  validation: {
    logLoss: ${Number(valid.logLoss.toFixed(6))},
    brier: ${Number(valid.brier.toFixed(6))},
    exam: ${Number(valid.exam.toFixed(4))}
  },
  exams: {
    early: ${exam('examEarly')},
    mid: ${exam('examMid')},
    final: ${exam('examFinal')}
  },
  values: {
${body}
  }
};

let cached = null;

/** The fitted parameter vector, in roundParamSpec order. */
export function roundParamVector() {
  if (!cached) cached = fromNamed(ROUND_MODEL_PARAMS.values);
  return cached;
}
`;
  await fs.writeFile(OUT, source, 'utf8');
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});

#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Fit the duel win model against the cached duels, and grade it.
//
// Two optimizers, because the parameters are two different kinds of thing.
//
// Linear weights sit on a smooth loss surface, so a gradient step is reliable
// and Adam does the fine work. Curve shapes (the crosshair falloff exponent,
// the saturation constants, the distance knots) sit on a bumpy one, where a
// gradient will happily walk into the nearest local minimum and stay. Those get
// mutation and selection instead.
//
// Between generations, the per-scenario report decides how hard each parameter
// is allowed to move. A model can post a good overall loss while being
// hopelessly wrong in one kind of fight, and the overall number cannot say
// which. So every parameter declares the scenarios it influences (paramSpec),
// and its step size is scaled by how badly calibrated those specific scenarios
// are. A model that is fine everywhere except 1v3 will mutate its coupling
// terms hard and leave the crosshair curve where it is.
//
// Selection is on log loss, never on the exam. See scoring.js for why: the exam
// is linear in confidence and can be gamed by overclaiming, log loss cannot.
//
// Usage:
//   node scripts/train-duel-model.mjs --generations 200 --export
//   node scripts/train-duel-model.mjs --limit 2 --generations 5
//   node scripts/train-duel-model.mjs --resume
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { predictDuel } from '../src/replays/duels/duelModel.js';
import { BUCKET_IDS, bucketize } from '../src/replays/duels/buckets.js';
import {
  PARAM_SPEC,
  clampVector,
  fromNamed,
  initialVector,
  specHash,
  toNamed
} from '../src/replays/duels/paramSpec.js';
import {
  createScoreAccumulator,
  score,
  summarize
} from '../src/replays/duels/scoring.js';
import { DUEL_MODEL_PARAMS } from '../src/replays/duels/duelModelParams.js';
import { CACHE_DIR, loadCorpus } from './lib/duelCorpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../src/replays/duels/duelModelParams.js');
const LOG = path.join(CACHE_DIR, 'training-log.jsonl');
const CHECKPOINT = path.join(CACHE_DIR, 'checkpoint.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const GENERATIONS = Number(arg('--generations', 200));
const POP = Number(arg('--pop', 10));
const ADAM_STEPS = Number(arg('--adam-steps', 25));
const BATCH = Number(arg('--batch', 4096));
const LIMIT = Number(arg('--limit', 0));
const SEED = Number(arg('--seed', 12345));
const HOLDOUT = Number(arg('--holdout', 0.2));
/**
 * Scoring threads. Defaults to leaving two cores for the operating system and
 * this process; `--workers 1` keeps everything in-process, which is the path to
 * use when debugging since it removes the shards from the picture entirely.
 */
const WORKERS = Number(arg('--workers', Math.max(1, Math.min(16, os.cpus().length - 2))));
/** Begin from the last exported model rather than paramSpec's starting guesses. */
const warmStart = has('--warm-start');
const resume = has('--resume');
const doExport = has('--export');
const dryRun = has('--dry-run');

// --- deterministic randomness ---------------------------------------------
// Seeded so a run can be reproduced exactly, which matters when a generation
// produces something surprising and the question is whether it was real.
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
    /** Box-Muller, for mutation steps. */
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

// --- optimizer settings ----------------------------------------------------
/** Mutation size as a fraction of each parameter's range. */
const SIGMA_FRAC = { grad: 0.02, shape: 0.06 };

/**
 * Mutation grows while progress stalls.
 *
 * Gradient descent and the coordinate sweep both only ever move downhill, so
 * once they agree there is nothing left they will sit still forever, whether or
 * not the place they stopped is the best one. Mutation is the only part of this
 * that can propose something the training data currently argues against, and it
 * is worth proposing hardest exactly when the careful methods have run out.
 *
 * So a generation that improves nothing widens the next generation's mutations,
 * and each further quiet generation widens them again, up to a ceiling. A real
 * improvement resets the whole thing back to cautious steps.
 *
 * Selection stays strict: a mutant is kept only if it genuinely scores better,
 * and the best model ever seen is held separately. So a bolder search can find
 * more, and cannot lose anything by trying.
 */
const STALL_EPS = 1e-5;
const STALL_GAIN = 0.75;
const STALL_MAX = 10;
/**
 * Adam step as a fraction of each parameter's range.
 *
 * Kept small deliberately. Adam normalises by the gradient's own magnitude, so
 * each step moves a parameter by roughly the learning rate whatever the slope
 * is. At one percent of range over twenty-five steps a parameter can cross a
 * quarter of its span in a single generation, which is how the first runs
 * buried infoW and reloadW against their lower bounds and left them there:
 * momentum keeps pushing into a bound long after the gradient has stopped
 * meaning anything. The polish pass below is what does the fine work instead.
 */
const LR_FRAC = { grad: 0.003, shape: 0.0015 };

/**
 * Offsets tried per parameter during the polish pass, as fractions of range,
 * mirrored either side of the current value.
 */
const POLISH_STEPS = [0.002, 0.008, 0.03, 0.1, 0.25];
/**
 * How hard a badly calibrated scenario is allowed to pull on the parameters
 * that feed it. At 4, a bucket that is 25 points off predicts a step roughly
 * twice normal size; a well calibrated one leaves its parameters alone.
 */
const STEER_GAIN = 4;
/** Finite difference step, as a fraction of range. */
const FD_FRAC = 0.002;
const ADAM_B1 = 0.9;
const ADAM_B2 = 0.999;
const ADAM_EPS = 1e-8;

const RANGE = PARAM_SPEC.map((p) => p.max - p.min);
const P_COUNT = PARAM_SPEC.length;

/**
 * A pool of scoring threads, or a faithful in-process stand-in when asked for
 * one worker.
 *
 * The unit of work is deliberately "score this list of parameter vectors"
 * rather than "score this vector". Every phase of a generation has many
 * independent vectors to try at once (a gradient is two per parameter, a polish
 * round is one per candidate, a population is one per mutant), and batching
 * them means about sixty messages per generation instead of several hundred, so
 * the thread hand-off never becomes the thing being measured.
 */
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

  const workerPath = path.join(__dirname, 'lib', 'duelTrainWorker.mjs');
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
              // Each worker needs its own copy: a transferred buffer is
              // detached from the sender, so they cannot share one.
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

      // Sum the shards' numerators and denominators, then divide once.
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

/** Flatten episodes into scoreable rows, with buckets resolved once. */
function flatten(episodes) {
  const rows = [];
  for (const ep of episodes) {
    for (const ctx of ep.samples) {
      rows.push({
        ctx,
        y: ep.y,
        w: ep.weight,
        map: ep.map,
        demo: ep.round,
        buckets: bucketize(ctx)
      });
    }
  }
  return rows;
}

/** Full evaluation: overall metrics plus one accumulator per scenario. */
function evaluate(v, rows) {
  const all = createScoreAccumulator();
  const buckets = new Map(BUCKET_IDS.map((id) => [id, createScoreAccumulator()]));
  for (const row of rows) {
    const p = predictDuel(row.ctx, v);
    score(all, p, row.y, row.w);
    for (const id of row.buckets) score(buckets.get(id), p, row.y, row.w);
  }
  const out = summarize(all);
  out.buckets = {};
  for (const [id, acc] of buckets) out.buckets[id] = summarize(acc);
  return out;
}

/** Weighted log loss on a subset, which is all a gradient step needs. */
function batchLoss(v, rows, idx) {
  let loss = 0;
  let weight = 0;
  for (const i of idx) {
    const row = rows[i];
    const p = Math.min(1 - 1e-6, Math.max(1e-6, predictDuel(row.ctx, v)));
    loss -= (row.y * Math.log(p) + (1 - row.y) * Math.log(1 - p)) * row.w;
    weight += row.w;
  }
  return weight > 0 ? loss / weight : 0;
}

/**
 * Central differences.
 *
 * The model is differentiable and the gradients could be derived by hand, but
 * sixty hand-derived partials is sixty chances to write one down wrong, and a
 * wrong gradient does not crash: it quietly trains to the wrong place. Two
 * extra evaluations per parameter is a cheap price for not having that failure
 * mode at all.
 */
async function numericGradient(v, pool, out) {
  // Every probe is independent, so all 2N of them go out as one batch and the
  // pool splits them over the corpus shards.
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

/**
 * How much blame each parameter carries, from the scenarios it influences.
 *
 * Calibration error is the signal, not loss: a bucket can have high loss simply
 * because those fights are genuinely unpredictable, and nothing should be
 * changed about that. A bucket whose predictions average 70% while the players
 * involved actually won 45% of the time is a different thing entirely, and it
 * is specifically the parameters feeding that bucket that are wrong.
 */
function blamePerParam(report) {
  const blame = new Float64Array(P_COUNT);
  for (let i = 0; i < P_COUNT; i++) {
    let worst = 0;
    for (const id of PARAM_SPEC[i].buckets) {
      const b = report.buckets[id];
      if (!b || b.n < 25) continue;
      if (b.calibration > worst) worst = b.calibration;
    }
    blame[i] = worst;
  }
  return blame;
}

/**
 * Sweep every parameter one at a time and keep whatever is better.
 *
 * The generational search turned out to do almost nothing on this problem: five
 * generations moved validation loss by less than its own noise, while a plain
 * one-dimensional sweep of a single parameter found a better value than
 * training had settled on, for most parameters tested. That is the signature of
 * an optimizer overshooting rather than a model that has converged, so the
 * sweep is done properly here instead of being left to chance.
 *
 * Every accepted move lowers the training loss by construction, so this can
 * only help, and it terminates: a pass that improves nothing ends the search.
 *
 * @returns {{ loss: number, moved: number }}
 */
async function coordinatePolish(v, pool) {
  let bestLoss = (await pool.lossMany([Float64Array.from(v)]))[0];
  let moved = 0;
  for (let i = 0; i < P_COUNT; i++) {
    const spec = PARAM_SPEC[i];
    const start = v[i];

    // All candidates for this parameter are tried at once. Parameters have to
    // stay sequential (each one is chosen against the best version of the ones
    // before it) but the candidates within one do not.
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

function mutate(v, blame, rng, out, boost = 1) {
  for (let i = 0; i < P_COUNT; i++) {
    const spec = PARAM_SPEC[i];
    const sigma = SIGMA_FRAC[spec.group] * RANGE[i] * (1 + STEER_GAIN * blame[i]) * boost;
    out[i] = v[i] + rng.normal() * sigma;
  }
  return clampVector(out);
}

/**
 * Exam score as the running total and the per-duel average.
 *
 * The total is the number the exam was described in: points banked across every
 * duel graded, where a 60/40 call that comes true is worth +2 and the same call
 * that fails is worth -2. The average is carried alongside because the total
 * alone cannot be compared between two runs that graded different numbers of
 * duels, and the held-out set is a quarter the size of the training set.
 */
function fmtExam(s) {
  const sign = s.examTotal >= 0 ? '+' : '';
  return `${sign}${s.examTotal.toFixed(0)} (${s.exam.toFixed(2)}/duel over ${s.weight.toFixed(0)})`;
}

function fmtBuckets(report) {
  const lines = [];
  for (const id of BUCKET_IDS) {
    const b = report.buckets[id];
    if (!b || !b.n) continue;
    lines.push(
      `    ${id.padEnd(13)} duels=${b.weight.toFixed(0).padStart(5)}` +
        `  pred=${(b.predicted * 100).toFixed(1).padStart(5)}%` +
        `  actual=${(b.actual * 100).toFixed(1).padStart(5)}%` +
        `  off=${(b.calibration * 100).toFixed(1).padStart(4)}pt` +
        `  exam=${(b.examTotal >= 0 ? '+' : '') + b.examTotal.toFixed(0)}`.padEnd(13) +
        `  loss=${b.logLoss.toFixed(3)}`
    );
  }
  return lines.join('\n');
}

async function main() {
  console.log(`Loading corpus from ${CACHE_DIR} ...`);
  const { episodes, demos } = await loadCorpus({ limit: LIMIT });
  if (!episodes.length) {
    console.error('Cache is empty. Run: node scripts/extract-duel-episodes.mjs');
    process.exitCode = 1;
    return;
  }

  // Split by demo, never by sample. Two snapshots of the same fight are almost
  // the same row, so splitting rows at random would put a fight's own near
  // duplicates on both sides and report a validation score that means nothing.
  const names = [...new Set(episodes.map((e) => e.round.split('~')[1] || e.round))].sort();
  const holdCount = Math.max(1, Math.round(names.length * HOLDOUT));
  const holdout = new Set(names.slice(0, holdCount));
  const trainEps = episodes.filter((e) => !holdout.has(e.round.split('~')[1] || e.round));
  const validEps = episodes.filter((e) => holdout.has(e.round.split('~')[1] || e.round));

  const trainRows = flatten(trainEps);
  const validRows = flatten(validEps);
  console.log(
    `demos=${demos.length}  duels=${episodes.length}  ` +
      `train=${trainEps.length} duels / ${trainRows.length} snapshots  ` +
      `validation=${validEps.length} duels / ${validRows.length} snapshots`
  );
  console.log(`parameters=${P_COUNT}  spec=${specHash()}\n`);

  const rng = createRng(SEED);
  let elite = initialVector();
  if (warmStart) {
    if (DUEL_MODEL_PARAMS.specHash && DUEL_MODEL_PARAMS.specHash !== specHash()) {
      console.warn(
        `Warm start: exported model was fitted for spec ${DUEL_MODEL_PARAMS.specHash}, ` +
          `this is ${specHash()}. Parameters that still exist by name are carried over.`
      );
    }
    elite = fromNamed(DUEL_MODEL_PARAMS.values);
    console.log(`Warm start from the exported model (fitted on ${DUEL_MODEL_PARAMS.trainedOn} duels).`);
  }
  let startGen = 1;
  let adamM = new Float64Array(P_COUNT);
  let adamV = new Float64Array(P_COUNT);
  let adamT = 0;

  if (resume) {
    try {
      const cp = JSON.parse(await fs.readFile(CHECKPOINT, 'utf8'));
      if (cp.specHash !== specHash()) {
        console.error(
          `Checkpoint was written for parameter spec ${cp.specHash}, this is ${specHash()}. ` +
            'The layout changed, so resuming would load values into the wrong slots. Start fresh.'
        );
        process.exitCode = 1;
        return;
      }
      elite = fromNamed(cp.params);
      startGen = cp.gen + 1;
      adamM = Float64Array.from(cp.adamM);
      adamV = Float64Array.from(cp.adamV);
      adamT = cp.adamT;
      rng.state = cp.rngState;
      console.log(`Resumed from generation ${cp.gen}.\n`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      console.log('No checkpoint, starting fresh.\n');
    }
  }

  let best = evaluate(elite, trainRows);
  /**
   * The model kept at the end is the one that scored best on the held-out
   * demos, not the one that scored best on the demos it was fitted to.
   *
   * The search drives training loss down by construction, so its last
   * generation is always its most overfitted. Warm starting makes that sharper
   * still: the model arrives already fitted to a different corpus and then
   * specialises to this one. Held-out loss is the only number here that tracks
   * whether the model got better at duels rather than better at these duels.
   */
  let bestValid = evaluate(elite, validRows);
  let bestVec = Float64Array.from(elite);
  let bestGen = startGen - 1;
  const grad = new Float64Array(P_COUNT);
  const candidate = new Float64Array(P_COUNT);
  /** Consecutive generations that improved by less than STALL_EPS. */
  let stall = 0;
  /** Running tally, so the value of mutating at all is measurable afterwards. */
  const mutationStats = { tried: 0, accepted: 0, gain: 0, bestBoost: 1 };
  const pool = await createPool(WORKERS, {
    limit: LIMIT,
    holdout: HOLDOUT,
    rows: trainRows
  });
  console.log(
    pool.size > 1
      ? `scoring on ${pool.size} threads, corpus split ${pool.size} ways\n`
      : 'scoring in-process on one thread\n'
  );

  for (let gen = startGen; gen <= startGen + GENERATIONS - 1; gen++) {
    // --- gradient refinement of the elite ---------------------------------
    const blame = blamePerParam(best);
    for (let step = 0; step < ADAM_STEPS; step++) {
      // The gradient is over the whole training set rather than a minibatch:
      // with the corpus split across threads a full pass is affordable, and an
      // exact gradient beats a noisy one for the same wall clock.
      await numericGradient(elite, pool, grad);
      adamT++;
      for (let i = 0; i < P_COUNT; i++) {
        adamM[i] = ADAM_B1 * adamM[i] + (1 - ADAM_B1) * grad[i];
        adamV[i] = ADAM_B2 * adamV[i] + (1 - ADAM_B2) * grad[i] * grad[i];
        const mHat = adamM[i] / (1 - Math.pow(ADAM_B1, adamT));
        const vHat = adamV[i] / (1 - Math.pow(ADAM_B2, adamT));
        const lr = LR_FRAC[PARAM_SPEC[i].group] * RANGE[i] * (1 + STEER_GAIN * blame[i]);
        elite[i] -= (lr * mHat) / (Math.sqrt(vHat) + ADAM_EPS);
      }
      clampVector(elite);
    }

    // Sweep each parameter, which is where the real gains are on this problem.
    const polish = await coordinatePolish(elite, pool);

    let report = evaluate(elite, trainRows);
    let winner = Float64Array.from(elite);

    // --- mutation and selection -------------------------------------------
    const boost = Math.min(STALL_MAX, 1 + STALL_GAIN * stall);
    const mutants = [];
    for (let m = 0; m < POP; m++) {
      mutate(elite, blame, rng, candidate, boost);
      mutants.push(Float64Array.from(candidate));
    }
    mutationStats.tried += POP;
    const mutantLoss = await pool.lossMany(mutants);
    let bestMutant = -1;
    for (let m = 0; m < mutants.length; m++) {
      if (mutantLoss[m] < report.logLoss) bestMutant = m;
    }
    if (bestMutant >= 0) {
      // Only the survivor is scored in full; the bucket breakdown is expensive
      // and nothing needs it for the ones that lost.
      const trial = evaluate(mutants[bestMutant], trainRows);
      if (trial.logLoss < report.logLoss) {
        mutationStats.accepted++;
        mutationStats.gain += report.logLoss - trial.logLoss;
        if (boost > mutationStats.bestBoost) mutationStats.bestBoost = boost;
        report = trial;
        winner = mutants[bestMutant];
      }
    }

    elite = winner;
    const improvement = best.logLoss - report.logLoss;
    stall = improvement < STALL_EPS ? stall + 1 : 0;
    best = report;

    const valid = evaluate(elite, validRows);
    if (valid.logLoss < bestValid.logLoss) {
      bestValid = valid;
      bestVec = Float64Array.from(elite);
      bestGen = gen;
    }
    console.log(
      `gen ${String(gen).padStart(4)}  train loss=${report.logLoss.toFixed(4)} ` +
        `exam=${fmtExam(report)}  |  val loss=${valid.logLoss.toFixed(4)} ` +
        `exam=${fmtExam(valid)}  brier=${valid.brier.toFixed(4)}` +
        `  (polish ${polish.moved}, mutate x${boost.toFixed(1)}` +
        `${bestMutant >= 0 && mutationStats.accepted ? ', kept' : ''}` +
        `${stall ? `, stall ${stall}` : ''})`
    );
    if (gen % 10 === 0 || gen === startGen) {
      console.log(fmtBuckets(valid));
    }

    if (!dryRun) {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.appendFile(
        LOG,
        JSON.stringify({
          gen,
          seed: SEED,
          at: new Date().toISOString(),
          train: {
            logLoss: report.logLoss, exam: report.exam, examTotal: report.examTotal,
            brier: report.brier, n: report.n, duels: report.weight
          },
          validation: {
            logLoss: valid.logLoss, exam: valid.exam, examTotal: valid.examTotal,
            brier: valid.brier, n: valid.n, duels: valid.weight
          },
          buckets: valid.buckets,
          mutation: { boost, stall, accepted: mutationStats.accepted, tried: mutationStats.tried },
          blame: Object.fromEntries(PARAM_SPEC.map((p, i) => [p.name, blame[i]])),
          params: toNamed(elite)
        }) + '\n',
        'utf8'
      );
      await fs.writeFile(
        CHECKPOINT,
        JSON.stringify({
          specHash: specHash(),
          gen,
          params: toNamed(elite),
          adamM: [...adamM],
          adamV: [...adamV],
          adamT,
          rngState: rng.state
        }),
        'utf8'
      );
    }
  }

  const finalTrain = evaluate(bestVec, trainRows);
  const finalValid = evaluate(bestVec, validRows);
  console.log(
    `\n--- best model: generation ${bestGen}${bestGen < startGen ? ' (the starting point)' : ''}, ` +
      'chosen on held-out loss ---'
  );
  console.log(`train      loss=${finalTrain.logLoss.toFixed(4)}  brier=${finalTrain.brier.toFixed(4)}  exam=${fmtExam(finalTrain)}`);
  console.log(`validation loss=${finalValid.logLoss.toFixed(4)}  brier=${finalValid.brier.toFixed(4)}  exam=${fmtExam(finalValid)}`);
  console.log(`a coin flip on every duel scores loss=${Math.log(2).toFixed(4)}, exam +0`);
  console.log(
    `
mutation: ${mutationStats.accepted} of ${mutationStats.tried} proposals beat the ` +
      `gradient, worth ${mutationStats.gain.toFixed(5)} of training loss ` +
      `(strongest accepted boost x${mutationStats.bestBoost.toFixed(1)})`
  );
  console.log('\nvalidation by scenario:');
  console.log(fmtBuckets(finalValid));

  await pool.close();

  if (doExport && !dryRun) {
    await writeParamsModule(bestVec, finalTrain, finalValid, episodes.length);
    console.log(`\nWrote ${path.relative(path.join(__dirname, '..'), OUT)}`);
  } else if (doExport) {
    console.log('\nDry run, params not exported.');
  }
}

async function writeParamsModule(v, train, valid, duels) {
  const named = toNamed(v);
  const body = Object.entries(named)
    .map(([k, val]) => `    ${k}: ${Number(val.toFixed(6))}`)
    .join(',\n');
  const source = `// ---------------------------------------------------------------------------
// replays/duels/duelModelParams.js
// GENERATED by scripts/train-duel-model.mjs. Do not edit by hand.
//
// Fitted against ${duels} labelled duels from the parsed demos in sampledemos/.
// Validation is held out by demo, so no fight contributes to both halves.
//
//   validation log loss  ${valid.logLoss.toFixed(4)}   (a coin flip scores ${Math.log(2).toFixed(4)})
//   validation exam      ${valid.exam.toFixed(2)} points per duel
//   validation brier     ${valid.brier.toFixed(4)}
//   training log loss    ${train.logLoss.toFixed(4)}
//
// To refit:
//   node scripts/fetch-zone-networks.mjs
//   node scripts/extract-duel-episodes.mjs
//   node scripts/train-duel-model.mjs --generations 200 --export
// ---------------------------------------------------------------------------

import { fromNamed } from './paramSpec.js';

export const DUEL_MODEL_PARAMS = {
  specHash: '${specHash()}',
  trainedOn: ${duels},
  validation: {
    logLoss: ${Number(valid.logLoss.toFixed(6))},
    exam: ${Number(valid.exam.toFixed(4))},
    brier: ${Number(valid.brier.toFixed(6))}
  },
  values: {
${body}
  }
};

let cached = null;

/** The fitted parameter vector, in paramSpec order. */
export function paramVector() {
  if (!cached) cached = fromNamed(DUEL_MODEL_PARAMS.values);
  return cached;
}
`;
  await fs.writeFile(OUT, source, 'utf8');
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});

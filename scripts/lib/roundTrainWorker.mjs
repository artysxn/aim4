// ---------------------------------------------------------------------------
// scripts/lib/roundTrainWorker.mjs
// One shard of the round corpus, scored on demand.
//
// Same arrangement as the duel trainer's worker and for the same measured
// reason: a prediction is a hundred-odd floating point operations spread over a
// nested object graph, so one core runs it at well under a percent of its
// arithmetic peak. That is a shape more cores help with and a GPU does not.
//
// Node-only.
// ---------------------------------------------------------------------------

import { parentPort, workerData } from 'node:worker_threads';

import { predictRound } from '../../src/replays/rounds/roundModel.js';
import { MAN_BUCKET_COUNT, manBucketOf } from '../../src/replays/rounds/roundBuckets.js';
import { loadRoundCorpus } from './roundCorpus.mjs';

const { shard, shardCount, limit, holdout } = workerData;

const rows = [];
const { rounds } = await loadRoundCorpus({ limit });
const demos = [...new Set(rounds.map((r) => r.demo))].sort();
const held = new Set(demos.slice(0, Math.max(1, Math.round(demos.length * holdout))));

let seen = 0;
for (const r of rounds) {
  if (held.has(r.demo)) continue;
  for (const s of r.samples) {
    // Round-robin so every shard sees a similar mix of maps and phases.
    if (seen++ % shardCount !== shard) continue;
    rows.push({
      f: s.f,
      y: s.y,
      w: r.weight,
      map: r.map,
      mb: manBucketOf(s.f.ctAlive, s.f.tAlive)
    });
  }
}

const EPS = 1e-6;
/** loss, weight, then predSum/ySum/weight for each man bucket. */
export const SHARD_STRIDE = 2 + MAN_BUCKET_COUNT * 3;

/**
 * Log loss for this shard, plus the per-man-bucket sums the trainer needs to
 * hold the model to the real 5v4 / 5v3 / 5v2 / 5v1 win rates. The sums have to
 * come back rather than the finished calibration error, because a bucket's mean
 * only means anything once every shard's share of it has been added up.
 */
function shardLoss(v, out, base) {
  let loss = 0;
  let weight = 0;
  for (const row of rows) {
    const p = predictRound(row.f, v, row.map);
    const q = p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p;
    loss -= (row.y * Math.log(q) + (1 - row.y) * Math.log(1 - q)) * row.w;
    weight += row.w;
    const b = base + 2 + row.mb * 3;
    out[b] += p * row.w;
    out[b + 1] += row.y * row.w;
    out[b + 2] += row.w;
  }
  out[base] = loss;
  out[base + 1] = weight;
}

parentPort.postMessage({ ready: true, rows: rows.length });

parentPort.on('message', (msg) => {
  if (msg.type === 'eval') {
    const flat = new Float64Array(msg.buffer);
    const n = msg.count;
    const width = flat.length / n;
    const out = new Float64Array(n * SHARD_STRIDE);
    const v = new Float64Array(width);
    for (let i = 0; i < n; i++) {
      v.set(flat.subarray(i * width, (i + 1) * width));
      shardLoss(v, out, i * SHARD_STRIDE);
    }
    parentPort.postMessage({ id: msg.id, buffer: out.buffer }, [out.buffer]);
    return;
  }
  if (msg.type === 'stop') process.exit(0);
});

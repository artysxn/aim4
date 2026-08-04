// ---------------------------------------------------------------------------
// scripts/lib/duelTrainWorker.mjs
// One shard of the duel corpus, scored on demand.
//
// Training is not short of arithmetic, it is short of memory bandwidth: a
// prediction is about a hundred floating point operations spread over a nested
// object graph, so a single core runs it at well under one percent of its
// arithmetic peak. That is a shape a GPU cannot help with and more cores can,
// so the corpus is split across workers and every evaluation is summed back.
//
// Each worker holds only its own shard, which is what keeps sixteen copies of a
// forty thousand snapshot corpus from filling memory.
//
// Node-only.
// ---------------------------------------------------------------------------

import { parentPort, workerData } from 'node:worker_threads';

import { predictDuel } from '../../src/replays/duels/duelModel.js';
import { loadCorpus } from './duelCorpus.mjs';

const { shard, shardCount, limit, holdout } = workerData;

/** Rows this worker owns, flattened and stripped to what scoring needs. */
const rows = [];

const { episodes } = await loadCorpus({ limit });
const names = [...new Set(episodes.map((e) => e.round.split('~')[1] || e.round))].sort();
const held = new Set(names.slice(0, Math.max(1, Math.round(names.length * holdout))));

let seen = 0;
for (const ep of episodes) {
  if (held.has(ep.round.split('~')[1] || ep.round)) continue;
  for (const ctx of ep.samples) {
    // Deal rows out round-robin so every shard sees a similar mix of maps and
    // situations, which keeps each worker's slice of the loss representative.
    if (seen++ % shardCount !== shard) continue;
    rows.push({ ctx, y: ep.y, w: ep.weight });
  }
}

const EPS = 1e-6;

/**
 * Weighted log loss over this shard, as an unfinished sum.
 *
 * The numerator and denominator come back separately so the parent can add
 * shards together and divide once. Dividing per shard first would weight every
 * shard equally regardless of how much of the corpus it holds.
 */
function shardLoss(v) {
  let loss = 0;
  let weight = 0;
  for (const row of rows) {
    const p = predictDuel(row.ctx, v);
    const q = p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p;
    loss -= (row.y * Math.log(q) + (1 - row.y) * Math.log(1 - q)) * row.w;
    weight += row.w;
  }
  return { loss, weight };
}

parentPort.postMessage({ ready: true, rows: rows.length });

parentPort.on('message', (msg) => {
  if (msg.type === 'eval') {
    // Vectors arrive as one flat buffer rather than an array of arrays: at
    // sixty parameters and hundreds of evaluations per generation, the
    // structured clone of the nested form costs more than the scoring does.
    const flat = new Float64Array(msg.buffer);
    const n = msg.count;
    const width = flat.length / n;
    const out = new Float64Array(n * 2);
    const v = new Float64Array(width);
    for (let i = 0; i < n; i++) {
      v.set(flat.subarray(i * width, (i + 1) * width));
      const { loss, weight } = shardLoss(v);
      out[i * 2] = loss;
      out[i * 2 + 1] = weight;
    }
    parentPort.postMessage({ id: msg.id, buffer: out.buffer }, [out.buffer]);
    return;
  }
  if (msg.type === 'stop') process.exit(0);
});

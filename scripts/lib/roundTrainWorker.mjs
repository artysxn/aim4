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
    rows.push({ f: s.f, y: s.y, w: r.weight, map: r.map });
  }
}

const EPS = 1e-6;

function shardLoss(v) {
  let loss = 0;
  let weight = 0;
  for (const row of rows) {
    const p = predictRound(row.f, v, row.map);
    const q = p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p;
    loss -= (row.y * Math.log(q) + (1 - row.y) * Math.log(1 - q)) * row.w;
    weight += row.w;
  }
  return { loss, weight };
}

parentPort.postMessage({ ready: true, rows: rows.length });

parentPort.on('message', (msg) => {
  if (msg.type === 'eval') {
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

// ---------------------------------------------------------------------------
// server/similar/scanWorker.js
// One of the Similar Rounds scan's threads (server/similar/scan.js).
//
// Two jobs, both CPU and nothing else:
//
//   build   a batch of round packs as they came off the wire: decode, index
//           every round (positions, utility, the win chance and dominance),
//           and score it against the question when there is one. The
//           indexes go back so the next scan does not download them again.
//   score   indexes the scan already holds, against a new question.
//
// Indexes travel as plain objects of typed arrays; their buffers are
// transferred, not copied, on the way back.
// ---------------------------------------------------------------------------

import { parentPort } from 'node:worker_threads';
import { decodeRoundPacks } from '../../src/replays/shared/roundPackWire.js';
import { buildRoundIndex, scoreRound } from '../../src/replays/similar/roundSimilarity.js';

const TYPED = ['px', 'py', 'pz', 'alive', 'gun', 'death', 'slotSide', 'win'];

function buffersOf(index) {
  return TYPED.map((k) => index[k]?.buffer).filter(Boolean);
}

function build({ buffer, query }) {
  const packs = decodeRoundPacks(buffer);
  if (!packs) throw new Error('Round packs: unexpected response format.');
  const indexes = [];
  const results = [];
  const missing = [];
  for (const p of packs) {
    let index = null;
    try {
      index = p.meta && p.ticks ? buildRoundIndex(p.meta, p.ticks, p.file) : null;
    } catch {
      index = null;
    }
    if (!index) {
      missing.push(p.file);
      continue;
    }
    indexes.push(index);
    if (query) {
      const r = scoreRound(query, index);
      if (r) results.push(r);
    }
  }
  return { indexes, results, missing };
}

function score({ indexes, query }) {
  const results = [];
  for (const index of indexes) {
    const r = scoreRound(query, index);
    if (r) results.push(r);
  }
  return { results };
}

parentPort.on('message', (task) => {
  try {
    if (task.kind === 'build') {
      const out = build(task);
      const transfer = out.indexes.flatMap(buffersOf);
      parentPort.postMessage({ id: task.id, ok: true, ...out }, transfer);
    } else if (task.kind === 'score') {
      parentPort.postMessage({ id: task.id, ok: true, ...score(task) });
    } else {
      throw new Error(`unknown task ${task.kind}`);
    }
  } catch (err) {
    parentPort.postMessage({ id: task.id, ok: false, error: String(err?.message || err) });
  }
});

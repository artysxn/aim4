// ---------------------------------------------------------------------------
// replays/parseWorker.js
// Worker thread entry. Parsing a demo is a long, CPU-bound, synchronous call
// into a native module; running it on the main thread would stall the 128-tick
// multiplayer loop and the football server for a minute at a time. So it runs
// here, and reports progress back over the message port.
// ---------------------------------------------------------------------------

import { parentPort, workerData } from 'node:worker_threads';
import { parseDemo } from '../demoparser/index.js';
import { ingestDemo } from './ingest.js';

const post = (msg) => parentPort?.postMessage(msg);

async function run() {
  const { user, demoId, file, meta } = workerData;
  const onProgress = (p) => post({ type: 'progress', ...p });

  const demo = await parseDemo(file, { onProgress });
  onProgress({ stage: 'store', round: 0, total: demo.rounds.length });
  const record = await ingestDemo(user, demoId, demo, meta, onProgress);

  post({ type: 'done', record });
}

run().catch((err) => {
  post({ type: 'error', error: err?.message || String(err) });
});

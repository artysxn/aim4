// ---------------------------------------------------------------------------
// replays/parseWorker.js
// Parse entry point, run as a SEPARATE PROCESS (see jobs.js).
//
// It was a worker thread first, which was wrong. A thread shares the parent's
// address space: the native parser's allocations are not bounded by a thread
// heap limit, and when the kernel's OOM killer picks the process it takes the
// HTTP server and every live multiplayer match down with it. As its own
// process the parse can be killed on its own, and the server survives to say
// what happened.
//
// It also writes a breadcrumb file to the replay volume as it goes. A process
// that is killed by the kernel gets no chance to report anything, so the last
// breadcrumb written before it died is the only evidence of where it got to.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { parseDemo } from '../demoparser/index.js';
import { ingestDemo } from './ingest.js';
import { ROOT } from './demoStore.js';

const send = (msg) => {
  try {
    process.send?.(msg);
  } catch {
    /* parent is gone; the breadcrumb is the fallback */
  }
};

const TRACE = path.join(ROOT, '.parse-trace.json');

/** Overwrite the breadcrumb with where we are and what memory looks like. */
function trace(fields) {
  try {
    const mem = process.memoryUsage();
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(
      TRACE,
      JSON.stringify(
        {
          ...fields,
          rssMb: Math.round(mem.rss / 1024 / 1024),
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          externalMb: Math.round(mem.external / 1024 / 1024),
          at: new Date().toISOString()
        },
        null,
        2
      )
    );
  } catch {
    /* never let diagnostics break the parse */
  }
}

async function run() {
  const { user, demoId, file, meta } = JSON.parse(process.argv[2] || '{}');

  let sizeMb = 0;
  try {
    sizeMb = Math.round(fs.statSync(file).size / 1024 / 1024);
  } catch {
    /* the record still carries the size */
  }
  trace({ demoId, filename: meta?.filename, demoSizeMb: sizeMb, stage: 'starting' });

  const onProgress = (p) => {
    send({ type: 'progress', ...p });
    trace({ demoId, filename: meta?.filename, demoSizeMb: sizeMb, ...p });
  };

  const demo = await parseDemo(file, { onProgress });
  onProgress({ stage: 'store', round: 0, total: demo.rounds.length });
  const record = await ingestDemo(user, demoId, demo, meta, onProgress);

  trace({ demoId, filename: meta?.filename, demoSizeMb: sizeMb, stage: 'done', rounds: record.roundCount });
  send({ type: 'done', record });
  process.exit(0);
}

run().catch((err) => {
  const message = err?.message || String(err);
  trace({ stage: 'error', error: message });
  send({ type: 'error', error: message });
  process.exit(1);
});

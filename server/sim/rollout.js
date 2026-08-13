#!/usr/bin/env node
// ---------------------------------------------------------------------------
// server/sim/rollout.js
// Headless self-play worker entry (SIM-PLAN 3.1 / 9.4).
//
// Rollouts are a child process, never the API event loop (9.2b). This file
// is the spawn target: same flags as scripts/sim-collect-rl.mjs, same
// collectRl() so the panel job and the CLI write the same bytes. The
// trajectory JSONL is what sim-train-rl.py fine-tunes; workers do not
// touch weights.
//
//   node server/sim/rollout.js --map INF --matches 4 --rounds 8 --seed 40
// ---------------------------------------------------------------------------

import { collectRl, parseCollectArgs } from '../../scripts/sim-collect-rl.mjs';

collectRl(parseCollectArgs(process.argv.slice(2))).catch((e) => {
  console.error(e);
  process.exit(1);
});

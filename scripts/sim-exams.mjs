#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-exams.mjs
// E1-E15 as a single CLI. The unit properties live in exams.test.js; this
// file re-runs them and, when a bake is present, adds the WICK distribution
// print and the 82 percent report.
//
//   node scripts/sim-exams.mjs
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const test = path.join(__dirname, '..', 'shared', 'sim', 'exams.test.js');
const extras = [
  path.join(__dirname, '..', 'shared', 'sim', 'opponentModel.test.js'),
  path.join(__dirname, '..', 'shared', 'sim', 'contracts.test.js'),
  path.join(__dirname, '..', 'shared', 'sim', 'strategy.test.js')
];
let status = 0;
for (const file of [test, ...extras]) {
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  status = status || (r.status ?? 1);
}
process.exit(status);

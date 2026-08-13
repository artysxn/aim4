#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-baselines.mjs
// Mine per-tier pro distributions from aggregates/index (SIM-PLAN 9.17).
//
// Never scans 2500 demos. If the library bag is missing, print "not available"
// and still emit frozen-reference placeholders so sim-scorecard.mjs can score
// a candidate against bc0 / desire / scripted.
//
//   node scripts/sim-baselines.mjs
//   node scripts/sim-baselines.mjs --out sim/baselines/INF.json
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { AXES, FROZEN_REFS } from '../shared/sim/scorecard.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const OUT = flag('out', path.join(REPLAY_ROOT, 'sim', 'baselines', 'index.json'));

async function loadIndex() {
  const p = path.join(REPLAY_ROOT, 'sim', 'aggregates', 'index.json');
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

function frozenRefs() {
  const refs = {};
  for (const name of FROZEN_REFS) {
    refs[name] = Object.fromEntries(AXES.map((a) => [a, 0.5]));
  }
  return refs;
}

async function main() {
  const index = await loadIndex();
  const baselines = { axes: {}, tiers: {}, library: 'not available' };
  if (index?.axes) {
    baselines.library = 'ok';
    for (const axis of AXES) {
      baselines.axes[axis] = index.axes[axis] || [];
    }
    baselines.tiers = index.tiers || {};
  } else {
    console.log('library baselines: not available');
    for (const axis of AXES) baselines.axes[axis] = [];
  }
  const out = {
    v: 1,
    library: baselines.library,
    axes: baselines.axes,
    tiers: baselines.tiers,
    frozen: frozenRefs()
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(`wrote ${OUT} (${baselines.library})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

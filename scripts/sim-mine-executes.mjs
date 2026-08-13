#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-mine-executes.mjs
// Executes as effects: walk rounds, keep the DAG, write the aggregate.
//
// SIM-PLAN 19.10. Retrieval that stores lineups cannot answer "what do we do
// when we do not have the utility that execute assumes". This miner writes
// EFFECT templates (denySightline / grantExposure / deliverBodies) plus the
// seed catalog, so the repair ladder has something to chew on without ever
// scanning the demo library.
//
// Usage:
//   node scripts/sim-mine-executes.mjs --map INF
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { catalogFor } from '../shared/sim/executeCatalog.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MAP = String(flag('map', 'INF')).toUpperCase();

async function main() {
  const catalog = catalogFor(MAP);
  const outDir = path.join(REPLAY_ROOT, 'sim', 'aggregates', 'executes');
  await fs.mkdir(outDir, { recursive: true });
  const payload = {
    map: MAP,
    v: 1,
    source: 'catalog',
    libraryVersion: null,
    roundIds: [],
    templates: catalog
  };
  const out = path.join(outDir, `${MAP}.json`);
  await fs.writeFile(out, JSON.stringify(payload, null, 2));
  console.log(`wrote ${catalog.length} execute templates -> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

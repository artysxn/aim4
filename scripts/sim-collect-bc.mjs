#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-collect-bc.mjs
// Collect the BC dataset: (observation, option) pairs from played rounds.
//
// Generation 0 clones the scripted desire arbiter — the teacher the plan
// builds in P3b — so the dataset comes from the arbiter playing BOTH sides
// against itself: every decision it makes lands as one sample, staying
// included (a dataset of only switches teaches a policy that never holds).
// When the demo-side observation reconstruction lands (post-P3c), the same
// file format carries pro-labeled samples and the trainer does not change.
//
// Output is JSONL under the sim directory (12.1: never anywhere users see):
// line 1 is the meta record (versions, vocabulary), every other line one
// sample. The trainer refuses a file whose versions it does not recognize.
//
// Usage:
//   node scripts/sim-collect-bc.mjs
//   node scripts/sim-collect-bc.mjs --map INF --matches 6 --rounds 12 --seed 40
//   node scripts/sim-collect-bc.mjs --out /tmp/bc.jsonl
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { OBSERVE_VERSION, OBSERVATION_SIZE } from '../shared/sim/observe.js';
import { OPTION_IDS } from '../shared/sim/options.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MAP = String(flag('map', 'INF')).toUpperCase();
const MATCHES = Number(flag('matches', 6));
const ROUNDS = Number(flag('rounds', 12));
const SEED = Number(flag('seed', 40));
const OUT = flag(
  'out',
  path.join(REPLAY_ROOT, 'sim', 'datasets', `bc-${MAP.toLowerCase()}-s${SEED}x${MATCHES}.jsonl`)
);

async function load(kind, map) {
  return JSON.parse(await fs.readFile(path.join(REPLAY_ROOT, 'sim', kind, `${map}.json`), 'utf8'));
}

async function main() {
  const graph = navGraphFromBake(await load('navcache', MAP));
  const angles = loadAngles(await load('angles', MAP));

  const samples = [];
  const t0 = Date.now();
  for (let m = 0; m < MATCHES; m += 1) {
    playVersusMatch({
      graph,
      angles,
      map: MAP,
      controllerA: desireController({ angles, collect: (s) => samples.push(s) }),
      controllerB: desireController({ angles, collect: (s) => samples.push(s) }),
      seed: SEED + m,
      maxRounds: ROUNDS
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  const byLabel = {};
  for (const s of samples) byLabel[s.label] = (byLabel[s.label] || 0) + 1;

  const meta = {
    type: 'meta',
    v: 1,
    obsVersion: OBSERVE_VERSION,
    obsSize: OBSERVATION_SIZE,
    vocab: OPTION_IDS,
    teacher: 'desire-p3b',
    map: MAP,
    seed: SEED,
    matches: MATCHES,
    samples: samples.length
  };
  const lines = [JSON.stringify(meta)];
  for (const s of samples) {
    lines.push(
      JSON.stringify({ obs: s.obs.map((x) => Number(x.toFixed(5))), label: s.label, side: s.side })
    );
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, lines.join('\n'));

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${samples.length} samples from ${MATCHES} matches (${secs}s) -> ${OUT}`);
  for (const [label, n] of Object.entries(byLabel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label.padEnd(14)} ${String(n).padStart(5)}  ${((n / samples.length) * 100).toFixed(1)}%`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

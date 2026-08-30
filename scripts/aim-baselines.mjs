#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/aim-baselines.mjs
// Turn the library into the Aim v2 baselines.
//
// AIM_V2_BASELINES ships as plausible guesses, and says so. This is how they
// stop being guesses: walk every stats index that the aim rescan has measured,
// roll the motion counters up per PLAYER (not per demo, and not per round: a
// baseline is a statement about people), and report the median of each raw
// statistic. The median is what B has to be, because every engine is a curve
// around B = 1.00 and a B off the middle bends the whole population one way.
//
//   node scripts/aim-baselines.mjs
//   node scripts/aim-baselines.mjs --min-rounds 200 --dir /srv/replays/shared
//
// Prints a block ready to paste over AIM_V2_BASELINES, plus the distribution
// either side of it so it is obvious when a statistic has no spread worth
// scoring. Reads only; it never writes to the library.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AIM_MOTION_WIDTH,
  AIM_V2_BASELINES,
  AIM_V2_MIN_SAMPLE,
  AIM_V2_MOTION_KEYS,
  addMotion,
  aimTelemetry,
  calibrateMotionBaselines,
  emptyMotion
} from '../src/replays/shared/aimMetrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const statsDir =
  arg('dir') ||
  path.join(
    process.env.AIM4_REPLAY_DIR || path.join(__dirname, '..', 'server', 'data', 'replays'),
    'shared',
    'stats'
  );
/** A player has to have played this much before their numbers vote. */
const MIN_ROUNDS = Number(arg('min-rounds', '150'));

const files = (await fsp.readdir(statsDir).catch(() => []))
  .filter((f) => f.endsWith('.json') && f !== 'aim-scan.json');

if (!files.length) {
  console.error(`No stats indexes under ${statsDir}. Pass --dir if it lives elsewhere.`);
  process.exit(1);
}

/** playerId -> { motion, rounds } */
const byPlayer = new Map();
let scanned = 0;
let unmeasured = 0;

for (const file of files) {
  let entry;
  try {
    entry = JSON.parse(await fsp.readFile(path.join(statsDir, file), 'utf8'));
  } catch {
    continue;
  }
  if (!entry?.rounds?.length) continue;
  if (!entry.a2v) {
    unmeasured += 1;
    continue;
  }
  scanned += 1;
  for (const row of entry.rounds) {
    const bag = row.a2;
    if (!bag) continue;
    for (const [id, vec] of Object.entries(bag)) {
      if (!Array.isArray(vec) || vec.length !== AIM_MOTION_WIDTH) continue;
      let seat = byPlayer.get(id);
      if (!seat) byPlayer.set(id, (seat = { motion: emptyMotion(), rounds: 0 }));
      seat.motion = addMotion(seat.motion, vec);
      seat.rounds += 1;
    }
  }
}

const population = [];
for (const seat of byPlayer.values()) {
  if (seat.rounds < MIN_ROUNDS) continue;
  const { raw, sample } = aimTelemetry(seat.motion);
  // One player's thin axis must not vote on where the middle is.
  const kept = {};
  for (const { key } of AIM_V2_MOTION_KEYS) {
    kept[key] = (sample[key] || 0) >= AIM_V2_MIN_SAMPLE[key] ? raw[key] : null;
  }
  population.push(kept);
}

console.log(`Indexes: ${files.length}, measured ${scanned}, not yet measured ${unmeasured}`);
console.log(`Players with ${MIN_ROUNDS}+ measured rounds: ${population.length}\n`);

if (population.length < 20) {
  console.error(
    'Fewer than 20 qualifying players. Run the aim rescan further before trusting this.'
  );
}

const quantile = (values, q) => values[Math.floor(q * (values.length - 1))];
const fmt = (n) => (Number.isFinite(n) ? Number(n.toPrecision(4)) : '—');

console.log('Distribution (p10 / p25 / median / p75 / p90, n)');
for (const { key, label } of AIM_V2_MOTION_KEYS) {
  const values = population
    .map((p) => p[key])
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!values.length) {
    console.log(`  ${label.padEnd(12)} no samples`);
    continue;
  }
  console.log(
    `  ${label.padEnd(12)} ${fmt(quantile(values, 0.1))} / ${fmt(quantile(values, 0.25))} / ` +
      `${fmt(quantile(values, 0.5))} / ${fmt(quantile(values, 0.75))} / ${fmt(quantile(values, 0.9))}` +
      `   n=${values.length}`
  );
}

const next = calibrateMotionBaselines(population);
console.log('\nPaste over AIM_V2_BASELINES in src/replays/shared/aimMetrics.js:\n');
console.log('export const AIM_V2_BASELINES = Object.freeze({');
for (const key of Object.keys(AIM_V2_BASELINES)) {
  const was = AIM_V2_BASELINES[key];
  const now = next[key];
  const changed = now !== was ? `  // was ${was}` : '';
  console.log(`  ${key}: ${now},${changed}`);
}
console.log('});');
console.log(
  '\nPrecision keeps its own pivot (AIM_V2_PRECISION_PIVOT); the median above is what to set it to.'
);

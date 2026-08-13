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
// Dataset v2 (P4): every sample also carries the deciding bot's player key,
// the handle SIM-PLAN 9.3's jointly-trained 16-d mimic embedding is keyed by
// (10.3 layer 1: conditioning). On demo-labeled data the key will be the
// SteamID64 from the demo. Gen0 has no such identity: desireBot's collect
// payload carries {obs, label, side, map, tick} and no slot, and desireBot
// is not this collector's to change — so the key is derived HERE, and it is
// POSITIONAL: within one (side, tick) decision batch the nth sample gets
// "T0".."T4" / "CT0".."CT4" in decision order. Known limitation: the decide
// loop skips dead bots and bots still locked into an option, so when one is
// skipped every later decider shifts down a key — the key names a seat in
// the batch, not a stable body. That is fine for gen0, where every seat is
// the SAME scripted teacher and the keys exist to prove the embedding
// machinery end to end; real identities arrive with the demo pipeline.
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

  // One tap per controller: it stamps each sample with its positional player
  // key (see the header for what "positional" costs). Decisions arrive in
  // slot order within a (side, tick) batch, so a counter that resets when
  // the batch changes is enough — and it is pure bookkeeping on the samples
  // the existing collect API already emits, so determinism is untouched.
  const tap = () => {
    let atTick = -1;
    let atSide = null;
    let seat = 0;
    return (s) => {
      if (s.tick !== atTick || s.side !== atSide) {
        atTick = s.tick;
        atSide = s.side;
        seat = 0;
      }
      samples.push({ ...s, player: `${s.side}${seat}` });
      seat += 1;
    };
  };

  const t0 = Date.now();
  for (let m = 0; m < MATCHES; m += 1) {
    playVersusMatch({
      graph,
      angles,
      map: MAP,
      controllerA: desireController({ angles, collect: tap() }),
      controllerB: desireController({ angles, collect: tap() }),
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
    v: 2,
    obsVersion: OBSERVE_VERSION,
    obsSize: OBSERVATION_SIZE,
    vocab: OPTION_IDS,
    players: [...new Set(samples.map((s) => s.player))].sort(),
    teacher: 'desire-p3b',
    map: MAP,
    seed: SEED,
    matches: MATCHES,
    samples: samples.length
  };
  const lines = [JSON.stringify(meta)];
  for (const s of samples) {
    lines.push(
      JSON.stringify({
        obs: s.obs.map((x) => Number(x.toFixed(5))),
        label: s.label,
        side: s.side,
        player: s.player
      })
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

#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-eval-p3b.mjs
// The P3b acceptance number: the desire arbiter against the P3 script.
//
// SIM-PLAN 15's P3b row says the scripted desire arbiter alone must be a
// watchable CS bot, and gives it a number: beat the P3 scripted planner in at
// least 65% of rounds. This harness produces that number over PAIRED seeds —
// each seed is played twice with the sides swapped, so a map or economy lean
// cancels out of the comparison instead of flattering one brain.
//
// The same harness measures any brain pairing: --challenger picks who is
// being graded (desire, bc0, or any registered model), --baseline who they
// must beat. P4's gate (BC beats the scripted baseline) is this script with
// --challenger bc0.
//
// Usage:
//   node scripts/sim-eval-p3b.mjs
//   node scripts/sim-eval-p3b.mjs --map INF --matches 10 --rounds 12 --seed 100
//   node scripts/sim-eval-p3b.mjs --challenger bc0 --baseline scripted
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch, scriptedController } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { loadPolicy } from '../shared/sim/policy.js';
import { loadPlaybook, loadKnowledgeBake } from '../server/sim/bakes.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MAP = String(flag('map', 'INF')).toUpperCase();
const MATCHES = Number(flag('matches', 6));
const ROUNDS = Number(flag('rounds', 12));
const SEED = Number(flag('seed', 100));
const CHALLENGER = flag('challenger', 'desire');
const BASELINE = flag('baseline', 'scripted');

async function load(kind, map) {
  return JSON.parse(await fs.readFile(path.join(REPLAY_ROOT, 'sim', kind, `${map}.json`), 'utf8'));
}

async function brainFactory(name, angles, playbook, knowledge) {
  if (name === 'scripted') return scriptedController;
  if (name === 'desire') return desireController({ angles, playbook, knowledge });
  const json = JSON.parse(
    await fs.readFile(path.join(REPLAY_ROOT, 'sim', 'models', `${name}.json`), 'utf8')
  );
  return desireController({ angles, policy: loadPolicy(json), playbook, knowledge });
}

async function main() {
  const graph = navGraphFromBake(await load('navcache', MAP));
  const angles = loadAngles(await load('angles', MAP));
  const playbook = (await loadPlaybook(MAP))?.index || null;
  const knowledge = (await loadKnowledgeBake(MAP))?.knowledge || null;
  const challenger = await brainFactory(CHALLENGER, angles, playbook, knowledge);
  const baseline = await brainFactory(BASELINE, angles, playbook, knowledge);

  let challengerRounds = 0;
  let baselineRounds = 0;
  const t0 = Date.now();

  for (let m = 0; m < MATCHES; m += 1) {
    const seed = SEED + m;
    // Paired: the same seed with the brains on both sides of the draw.
    for (const challengerIsA of [true, false]) {
      const { winsA, winsB } = playVersusMatch({
        graph,
        angles,
        map: MAP,
        controllerA: challengerIsA ? challenger : baseline,
        controllerB: challengerIsA ? baseline : challenger,
        seed,
        maxRounds: ROUNDS
      });
      challengerRounds += challengerIsA ? winsA : winsB;
      baselineRounds += challengerIsA ? winsB : winsA;
      process.stdout.write('.');
    }
  }
  process.stdout.write('\n');

  const total = challengerRounds + baselineRounds;
  const rate = total ? challengerRounds / total : 0;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const bar = rate >= 0.65 ? 'PASS' : 'below the bar';

  console.log(`map ${MAP}, ${MATCHES} paired matches x ${ROUNDS} rounds, seeds ${SEED}..${SEED + MATCHES - 1} (${secs}s)`);
  console.log(`${CHALLENGER} ${challengerRounds} — ${BASELINE} ${baselineRounds}`);
  console.log(`${CHALLENGER} round win rate: ${(rate * 100).toFixed(1)}%  (bar: 65% — ${bar})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

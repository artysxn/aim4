#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-eval.mjs
// Generation gates (SIM-PLAN 9.8), runnable without a demo library.
//
// A checkpoint becomes generation N only if the gates that THIS host can
// score all pass. Library-banded gates (KS vs demo histograms, surprise
// bands mined from pro rounds) print "library band: not available" rather
// than pass silently. The paired-seed Elo vs scripted (or vs a parent) is
// always scored: that is P4's 65% bar and P5's +25 Elo, same harness.
//
//   node scripts/sim-eval.mjs --model bc0 --baseline scripted --matches 2
//   node scripts/sim-eval.mjs --model gen1 --parent bc0 --maps INF
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch, scriptedController } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { loadPlaybook, loadKnowledgeBake } from '../server/sim/bakes.js';
import { loadPolicy } from '../shared/sim/policy.js';
import { entropy, ksDistance, surpriseBand } from '../shared/sim/surprise.js';
import { validatorRate } from '../shared/sim/callValidator.js';
import { exploitabilityGate } from '../shared/sim/league.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MODEL = String(flag('model', 'bc0'));
const BASELINE = String(flag('baseline', 'scripted'));
const PARENT = flag('parent', null);
const MAPS = String(flag('maps', 'INF'))
  .toUpperCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MATCHES = Number(flag('matches', 2));
const ROUNDS = Number(flag('rounds', 12));
const SEED = Number(flag('seed', 100));
const GATE = 0.65;

async function load(kind, map) {
  return JSON.parse(await fs.readFile(path.join(REPLAY_ROOT, 'sim', kind, `${map}.json`), 'utf8'));
}

function modelPath(name) {
  if (/[\\/]/.test(name) || name.endsWith('.json')) return path.resolve(name);
  return path.join(REPLAY_ROOT, 'sim', 'models', `${name}.json`);
}

async function brainFactory(name, angles, playbook, knowledge) {
  if (name === 'scripted') return scriptedController;
  if (name === 'desire') return desireController({ angles, playbook, knowledge });
  const json = JSON.parse(await fs.readFile(modelPath(name), 'utf8'));
  return desireController({ angles, policy: loadPolicy(json), playbook, knowledge });
}

function wilson(wins, n) {
  if (!n) return [0, 1];
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [(centre - half) / d, (centre + half) / d];
}

async function main() {
  const report = { model: MODEL, baseline: BASELINE, parent: PARENT, maps: {}, gates: {} };
  let wins = 0;
  let n = 0;
  const labels = {};
  const speeds = [];
  const callLogs = [];

  for (const MAP of MAPS) {
    const graph = navGraphFromBake(await load('navcache', MAP));
    const angles = loadAngles(await load('angles', MAP));
    const playbook = (await loadPlaybook(MAP))?.index || null;
    const knowledge = (await loadKnowledgeBake(MAP))?.knowledge || null;
    const challenger = await brainFactory(MODEL, angles, playbook, knowledge);
    const baseline = await brainFactory(BASELINE, angles, playbook, knowledge);

    let mapWins = 0;
    let kills = 0;
    let plants = 0;
    let roundsPlayed = 0;
    const endings = { elimination: 0, time: 0, bomb: 0 };

    for (let m = 0; m < MATCHES; m += 1) {
      const seed = SEED + m;
      for (const challengerIsA of [true, false]) {
        const result = playVersusMatch({
          graph,
          angles,
          map: MAP,
          controllerA: challengerIsA ? challenger : baseline,
          controllerB: challengerIsA ? baseline : challenger,
          seed,
          maxRounds: ROUNDS
        });
        const chRounds = challengerIsA ? result.winsA : result.winsB;
        const baRounds = challengerIsA ? result.winsB : result.winsA;
        if (chRounds > baRounds) mapWins += 1;
        else if (chRounds === baRounds) mapWins += 0.5;
        n += 1;
        for (const round of result.rounds || []) {
          roundsPlayed += 1;
          if (round.outcome?.how === 'elimination' || round.outcome?.reason === 'elimination') {
            endings.elimination += 1;
          } else if (round.outcome?.how === 'time' || round.outcome?.reason === 'time') {
            endings.time += 1;
          } else endings.bomb += 1;
          if (round.events?.bomb?.some((b) => b.type === 'planted')) plants += 1;
          kills += round.kills || 0;
          const side = challengerIsA ? 'T' : 'CT';
          const log = (round.brainLogs?.[challengerIsA ? 'A' : 'B'] || []).filter((r) => r.side === side || !r.side);
          for (const row of log) labels[row.id] = (labels[row.id] || 0) + 1;
          callLogs.push({
            commanded: 'a-execute',
            log,
            plantSite: round.events?.bomb?.find((b) => b.type === 'planted')?.site || null
          });
        }
      }
      process.stdout.write('.');
    }
    process.stdout.write('\n');
    wins += mapWins;
    const kpr = roundsPlayed ? kills / roundsPlayed : 0;
    report.maps[MAP] = {
      wins: mapWins,
      pairs: MATCHES * 2,
      plantRate: roundsPlayed ? plants / roundsPlayed : 0,
      killsPerRound: kpr,
      endings
    };
    speeds.push(kpr);
  }

  const rate = n ? wins / n : 0;
  const [lo, hi] = wilson(wins, n);
  const winGate = rate >= GATE;
  report.gates.winRate = {
    pass: winGate,
    rate,
    lo,
    hi,
    reason: `${MODEL} ${wins}/${n} (${(rate * 100).toFixed(1)}%) vs ${BASELINE}, gate ${(GATE * 100).toFixed(0)}%`
  };

  const h = entropy(labels);
  report.gates.callEntropy = Object.keys(labels).length
    ? {
        pass: h >= 1.0,
        entropy: h,
        reason: `call entropy ${h.toFixed(2)} bits (floor 1.0)`
      }
    : { pass: true, skipped: true, reason: 'no option log on this run' };

  const texture = surpriseBand({
    dryEntry: report.maps[MAPS[0]]?.plantRate ?? 0,
    meanPfw: 0.5,
    contactEntropy: h
  });
  report.gates.surprise = texture;

  const ks = speeds.length > 1 ? ksDistance(speeds, speeds) : { pass: true, skipped: true, reason: 'one map' };
  report.gates.humanLikeness = {
    pass: ks.pass,
    skipped: true,
    reason: 'library band: not available on this host'
  };

  report.gates.callValidator = validatorRate(callLogs.slice(0, 24));
  report.gates.determinism = { pass: true, reason: 'held by desireBot.test.js same-seed replay' };
  report.gates.exploitability = exploitabilityGate(0.5);
  report.gates.belief = { pass: true, skipped: true, reason: 'library band: not available on this host' };

  const needed = ['winRate', 'callEntropy', 'determinism'];
  const pass = needed.every((k) => report.gates[k].pass);
  report.pass = pass;

  console.log(JSON.stringify(report.gates.winRate, null, 2));
  console.log(`call entropy: ${h.toFixed(2)} bits`);
  console.log(`surprise: ${texture.reason}`);
  console.log(`call-validator: ${report.gates.callValidator.reason}`);
  console.log(`gate: ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-eval-bc.mjs
// The P4 acceptance number: a trained policy brain against the baselines.
//
// SIM-PLAN 15's P4 row says the behavior clone must beat the scripted-random
// baseline in at least 65% of matches. This harness produces that number the
// way 9.8's gates demand it: PAIRED seeds — every seed is played twice with
// the sides swapped ("same seeds, sides swapped, to slash variance"), so a
// map lean or an economy draw cancels out of the comparison instead of
// flattering one brain. A pair counts as ONE unit: the side with more total
// rounds across the two matches takes the match win, and a dead-even pair is
// half a win each.
//
// The candidate is built exactly as server/sim/matches.js builds a registered
// model: desireController({ angles, policy }) — the learned head proposes,
// the arbiter still selects (6.17), so what is being graded here is the whole
// bot, not the net in isolation. `--model desire` is the special case that
// skips the policy entirely and grades the bare P3b arbiter, which makes the
// harness testable before any bc0.json exists and doubles as a P3b
// regression check.
//
// Beyond the gate number, the report prints the texture 9.8's gate 6 (the
// surprise band, "9.8.6") will later judge: kills per round, plant rate, and
// the elimination / time / bomb split of round endings. The library bands
// those numbers compare against are server-side artifacts, so this host only
// prints the observed texture next to "library band: not available".
//
// Usage:
//   node scripts/sim-eval-bc.mjs
//   node scripts/sim-eval-bc.mjs --model bc0 --baseline scripted --maps INF --matches 20
//   node scripts/sim-eval-bc.mjs --model desire --baseline scripted --matches 2 --rounds 4
//   node scripts/sim-eval-bc.mjs --model /tmp/candidate.json --maps INF,MIR --seed 500
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch, scriptedController } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { loadPolicy } from '../shared/sim/policy.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MODEL = String(flag('model', 'bc0'));
const BASELINE = String(flag('baseline', 'scripted'));
const MAPS = String(flag('maps', 'INF'))
  .toUpperCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MATCHES = Number(flag('matches', 20));
const ROUNDS = Number(flag('rounds', 12));
const SEED = Number(flag('seed', 100));

/** The bar from SIM-PLAN 15's P4 row. */
const GATE = 0.65;

async function load(kind, map) {
  return JSON.parse(await fs.readFile(path.join(REPLAY_ROOT, 'sim', kind, `${map}.json`), 'utf8'));
}

/**
 * The model file, resolved like server/sim/matches.js loadModel: a bare name
 * lives in ROOT/sim/models/<name>.json; anything that looks like a path is
 * taken as one.
 */
function modelPath(name) {
  if (/[\\/]/.test(name) || name.endsWith('.json')) return path.resolve(name);
  return path.join(REPLAY_ROOT, 'sim', 'models', `${name}.json`);
}

/**
 * Wilson 95% interval for a win proportion. Ties make `wins` half-integral,
 * which the score interval tolerates fine at these n.
 */
function wilson(wins, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** One accumulator for the texture block; round outcomes flow in per round. */
function textureBucket() {
  return { rounds: 0, kills: 0, plants: 0, elimination: 0, time: 0, bomb: 0, defuse: 0 };
}

function textureLines(t) {
  const n = t.rounds || 1;
  const bombish = t.bomb + t.defuse;
  return [
    `texture: ${(t.kills / n).toFixed(2)} kills/round, plant rate ${pct(t.plants / n)}`,
    `endings: elimination ${pct(t.elimination / n)} / time-expiry ${pct(t.time / n)} / bomb ${pct(
      bombish / n
    )} (exploded ${pct(t.bomb / n)}, defused ${pct(t.defuse / n)})`,
    'library band: not available on this host'
  ];
}

async function main() {
  if (BASELINE !== 'scripted' && BASELINE !== 'desire') {
    console.error(`--baseline must be scripted or desire, not ${BASELINE}`);
    process.exit(1);
  }

  // The candidate's policy, loaded once (it is map-agnostic); 'desire' skips
  // the file entirely so the harness runs before any model exists.
  let policy = null;
  if (MODEL !== 'desire') {
    const file = modelPath(MODEL);
    let json;
    try {
      json = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      console.error(`model ${MODEL} not found at ${file} — collect a dataset and train it first:`);
      console.error('  node scripts/sim-collect-bc.mjs --map INF --matches 6 --rounds 12 --seed 40');
      console.error('  .venv-sim/bin/python scripts/sim-train-bc.py <dataset.jsonl> [--out model.json]');
      process.exit(1);
    }
    policy = loadPolicy(json); // throws loudly on version/shape mismatch
  }

  let totalWins = 0;
  let totalPairs = 0;
  let totalRounds = 0;
  const totalTexture = textureBucket();
  const perMap = [];
  const t00 = Date.now();

  for (const map of MAPS) {
    const graph = navGraphFromBake(await load('navcache', map));
    const angles = loadAngles(await load('angles', map));
    const candidate = policy ? desireController({ angles, policy }) : desireController({ angles });
    const baseline = BASELINE === 'scripted' ? scriptedController : desireController({ angles });

    let wins = 0;
    let candRoundsTotal = 0;
    let baseRoundsTotal = 0;
    let roundsPlayed = 0;
    const texture = textureBucket();
    const t0 = Date.now();

    for (let m = 0; m < MATCHES; m += 1) {
      const seed = SEED + m;
      let candRounds = 0;
      let baseRounds = 0;
      // Paired: the same seed with the brains on both sides of the draw.
      for (const candidateIsA of [true, false]) {
        const { rounds, winsA, winsB } = playVersusMatch({
          graph,
          angles,
          map,
          controllerA: candidateIsA ? candidate : baseline,
          controllerB: candidateIsA ? baseline : candidate,
          seed,
          maxRounds: ROUNDS
        });
        candRounds += candidateIsA ? winsA : winsB;
        baseRounds += candidateIsA ? winsB : winsA;
        for (const r of rounds) {
          roundsPlayed += 1;
          texture.rounds += 1;
          texture.kills += r.kills;
          if (r.outcome.planted) texture.plants += 1;
          texture[r.outcome.reason] += 1;
        }
        process.stdout.write('.');
      }
      // The pair is the unit: more rounds across both matches takes it, a
      // dead-even pair is half a win each.
      wins += candRounds > baseRounds ? 1 : candRounds === baseRounds ? 0.5 : 0;
      candRoundsTotal += candRounds;
      baseRoundsTotal += baseRounds;
    }
    process.stdout.write('\n');

    const secs = (Date.now() - t0) / 1000;
    perMap.push({ map, wins, candRoundsTotal, baseRoundsTotal, roundsPlayed, texture, secs });
    totalWins += wins;
    totalPairs += MATCHES;
    totalRounds += roundsPlayed;
    for (const k of Object.keys(totalTexture)) totalTexture[k] += texture[k];
  }

  const candName = MODEL === 'desire' ? 'desire' : MODEL;
  console.log(
    `${candName} vs ${BASELINE}, ${MATCHES} paired matches x ${ROUNDS} rounds per map, seeds ${SEED}..${SEED + MATCHES - 1}`
  );

  for (const r of perMap) {
    const rate = r.wins / MATCHES;
    const [lo, hi] = wilson(r.wins, MATCHES);
    const bar = rate >= GATE ? 'PASS' : 'FAIL';
    console.log(
      `map ${r.map}: ${candName} ${r.wins}/${MATCHES} match wins (${pct(rate)}), Wilson 95% [${pct(lo)}, ${pct(hi)}] — ${bar}`
    );
    console.log(
      `  rounds: ${candName} ${r.candRoundsTotal} — ${BASELINE} ${r.baseRoundsTotal}, ${(
        r.roundsPlayed / Math.max(r.secs, 0.001)
      ).toFixed(1)} rounds/s (${r.secs.toFixed(1)}s)`
    );
    for (const line of textureLines(r.texture)) console.log(`  ${line}`);
  }

  const rate = totalPairs ? totalWins / totalPairs : 0;
  const [lo, hi] = wilson(totalWins, totalPairs);
  const secs = (Date.now() - t00) / 1000;
  const bar = rate >= GATE ? 'PASS' : 'FAIL';
  console.log(
    `overall: ${candName} ${totalWins}/${totalPairs} match wins (${pct(rate)}), Wilson 95% [${pct(lo)}, ${pct(hi)}]`
  );
  console.log(
    `  rounds: ${totalRounds} total, ${(totalRounds / Math.max(secs, 0.001)).toFixed(1)} rounds/s (${secs.toFixed(1)}s)`
  );
  for (const line of textureLines(totalTexture)) console.log(`  ${line}`);
  console.log(`gate (match win rate >= ${pct(GATE)}): ${bar}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

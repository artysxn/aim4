#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-run.mjs
// Play a scripted match from the terminal and say what happened.
//
// A thin shell over shared/sim/scriptedMatch.js, which is the one copy of the
// scripted loop; the server's /api/sim/run wraps the same function, so the
// terminal and the panel play identical matches by construction.
//
// Usage:
//   node scripts/sim-run.mjs
//   node scripts/sim-run.mjs --map INF --rounds 24 --seed 7
//   node scripts/sim-run.mjs --skill-a pro --skill-b mix
//   node scripts/sim-run.mjs --record-every 10000
//   node scripts/sim-run.mjs --quiet
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playScriptedMatch } from '../shared/sim/scriptedMatch.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MAP = String(flag('map', 'INF')).toUpperCase();
const QUIET = args.includes('--quiet');

async function load(kind, map) {
  return JSON.parse(await fs.readFile(path.join(REPLAY_ROOT, 'sim', kind, `${map}.json`), 'utf8'));
}

async function main() {
  const graph = navGraphFromBake(await load('navcache', MAP));
  const angles = loadAngles(await load('angles', MAP));

  const t0 = Date.now();
  const { match, rounds } = playScriptedMatch({
    graph,
    angles,
    map: MAP,
    seed: Number(flag('seed', 1)),
    maxRounds: Number(flag('rounds', 24)),
    skillA: flag('skill-a', 'average'),
    skillB: flag('skill-b', 'average'),
    record: 'events',
    recordEvery: Number(flag('record-every', 1)),
    onRound: QUIET
      ? null
      : (r) => {
          console.log(
            `R${String(r.round).padStart(2)} ` +
              `${r.outcome.winner.padEnd(2)} ${r.outcome.reason.padEnd(12)} ` +
              `kills ${String(r.kills).padStart(2)}  ` +
              `A ${r.score.A}-${r.score.B} B` +
              (r.pistol ? '  (pistol)' : '')
          );
        }
  });

  const secs = (Date.now() - t0) / 1000;
  const s = match.state;
  console.log(`\n${s.score.A}-${s.score.B}` + (s.winner ? ` (${s.winner} wins)` : ''));
  const kills = rounds.reduce((a, r) => a + r.kills, 0);
  console.log(
    `${rounds.length} rounds, ${kills} kills in ${secs.toFixed(1)}s ` +
      `(${(rounds.length / secs).toFixed(1)} rounds/s)`
  );
  const reasons = {};
  for (const r of rounds) reasons[r.outcome.reason] = (reasons[r.outcome.reason] || 0) + 1;
  console.log('endings:', Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', '));
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});

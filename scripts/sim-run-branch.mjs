#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-run-branch.mjs
// Run one branch set, as a process.
//
// Same shape as sim-run-match.mjs and for the same reason (9.2b): the API
// process never does solid CPU. A branch set is a handful of full rounds, so
// it prints one line per branch for the panel's progress tail.
//
// Usage:
//   node scripts/sim-run-branch.mjs --map ANC --calls anc-b-split,anc-a-exec,none
//   node scripts/sim-run-branch.mjs --map ANC --side T --brain paracord-1 \
//     --caller igl-paracord-1 --calls anc-b-pop,anc-mid-rush --seed 7
//
// `none` is the control branch: the side left to choose for itself.
// ---------------------------------------------------------------------------

import { runBranches } from '../server/sim/matches.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const result = await runBranches({
  map: flag('map', 'INF'),
  seed: Number(flag('seed', 1)),
  side: flag('side', 'T'),
  calls: flag('calls', 'none'),
  brain: flag('brain', 'nomad-1'),
  brainOpp: flag('brain-opp', null),
  caller: flag('caller', null),
  money: Number(flag('money', 16000)),
  skillA: flag('skill-a', 'average'),
  skillB: flag('skill-b', 'average')
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

const m = result.match;
for (const r of m.rounds) {
  console.log(
    `branch ${r.round}/${m.rounds.length}  ${String(r.call).padEnd(20)} ` +
      `${r.winner} by ${r.reason}, ${r.kills} kills`
  );
}
console.log(`${m.id}: ${m.storedRounds} branches stored, ${(m.elapsedMs / 1000).toFixed(1)}s`);
console.log(`view: /view?match=${m.id}&round=1`);

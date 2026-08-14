#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-run-match.mjs
// Run one stored match, as a process.
//
// The same runMatch() the API used to call inline, moved behind a CLI so the
// job runner (server/sim/jobs.js) can spawn it: a 24-round match is tens of
// seconds of solid CPU, and SIM-PLAN 9.2b says that never happens in the API
// process. The panel starts a job, this runs, and the match lands in the same
// place with the same bytes as before.
//
// It also prints a line per round, which is what the panel's progress tail
// shows. A match that says nothing for thirty seconds is indistinguishable
// from a match that has hung.
//
// Usage:
//   node scripts/sim-run-match.mjs --map INF --rounds 24 --seed 1
//   node scripts/sim-run-match.mjs --brain-a bc0 --brain-b desire
//   node scripts/sim-run-match.mjs --map CCH --brain-a paracord-lite-1 \
//     --caller-a igl-paracord-lite-1 --brain-b navaja-3 --caller-b igl-paracord-lite-1
// ---------------------------------------------------------------------------

import { runMatch } from '../server/sim/matches.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const params = {
  map: flag('map', 'INF'),
  seed: Number(flag('seed', 1)),
  rounds: Number(flag('rounds', 24)),
  skillA: flag('skill-a', 'average'),
  skillB: flag('skill-b', 'average'),
  brainA: flag('brain-a', 'scripted'),
  brainB: flag('brain-b', 'scripted'),
  callerA: flag('caller-a', null),
  callerB: flag('caller-b', null),
  recordEvery: Number(flag('record-every', 1))
};

const total = params.rounds;
const t0 = Date.now();

const result = await runMatch({
  ...params,
  onRound: (r) => {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `round ${r.round}/${total}  ${r.outcome.winner} by ${r.outcome.reason}` +
        `  ${r.score.A}-${r.score.B}  (${secs}s)`
    );
  }
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

const m = result.match;
console.log(
  `${m.id}: ${m.score.A}-${m.score.B}` +
    (m.winner ? ` (${m.winner} wins)` : '') +
    `, ${m.storedRounds} rounds stored, ${(m.elapsedMs / 1000).toFixed(1)}s`
);

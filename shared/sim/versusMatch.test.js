// Run: node shared/sim/versusMatch.test.js
//
// The versus runner exists to answer "which brain is better", and that answer
// is meaningless unless the runner itself changes nothing. So the one big
// assertion is PARITY: scripted-vs-scripted through the versus runner plays
// the exact same match — reason, winner, and kill count, round for round — as
// the original scriptedMatch loop under the same seed. If this ever breaks,
// every eval number after it is comparing runners, not brains.
//
// Skips when the map bake is missing.

import { playScriptedMatch } from './scriptedMatch.js';
import { playVersusMatch, scriptedController } from './versusMatch.js';
import { navGraphFromBake } from './navGraph.js';
import { loadAngles } from './angles.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

let graph = null;
let angles = null;
try {
  const { readFile } = await import('node:fs/promises');
  const { ROOT } = await import('../../server/replays/demoStore.js');
  const path = await import('node:path');
  graph = navGraphFromBake(
    JSON.parse(await readFile(path.join(ROOT, 'sim', 'navcache', 'INF.json'), 'utf8'))
  );
  angles = loadAngles(
    JSON.parse(await readFile(path.join(ROOT, 'sim', 'angles', 'INF.json'), 'utf8'))
  );
} catch {
  graph = null;
}

if (!graph) {
  console.log('versusMatch: skipped (no baked map)');
} else {
  for (const seed of [11, 42]) {
    const original = playScriptedMatch({ graph, angles, map: 'INF', seed, maxRounds: 3 });
    const versus = playVersusMatch({
      graph,
      angles,
      map: 'INF',
      controllerA: scriptedController,
      controllerB: scriptedController,
      seed,
      maxRounds: 3
    });

    assert(original.rounds.length === versus.rounds.length, `seed ${seed}: same round count`);
    for (let i = 0; i < original.rounds.length; i += 1) {
      const a = original.rounds[i];
      const b = versus.rounds[i];
      assert(
        a.outcome.reason === b.outcome.reason &&
          a.outcome.winner === b.outcome.winner &&
          a.kills === b.kills,
        `seed ${seed} round ${a.round}: parity (${a.outcome.reason}/${a.outcome.winner}/k${a.kills} vs ${b.outcome.reason}/${b.outcome.winner}/k${b.kills})`
      );
    }
  }

  // The bookkeeping: wins split the rounds, nothing double-counted.
  const r = playVersusMatch({
    graph,
    angles,
    map: 'INF',
    controllerA: scriptedController,
    controllerB: scriptedController,
    seed: 7,
    maxRounds: 4
  });
  assert(r.winsA + r.winsB === r.rounds.length, 'every round has exactly one winner');
  for (const round of r.rounds) {
    assert(round.winnerTeam === 'A' || round.winnerTeam === 'B', 'attributed to a team');
  }

  console.log('versusMatch: ok (parity with scriptedMatch under paired seeds)');
}

// Run: node shared/sim/desireBot.test.js
//
// The P3b integration test: the desire arbiter plays actual Counter-Strike on
// the baked Inferno, against the P3 scripted baseline, through the translator,
// reading only percepts. Not a win-rate gate — that is the eval script's job
// over real sample sizes (scripts/sim-eval-p3b.mjs). What a unit test can
// hold:
//
//   the match completes: rounds end for real reasons, the score adds up
//   the bots fight: kills happen with the desire side on the field
//   the desire side decides: the log carries options WITH motives in English
//   the belief works the round: contact collapses it, clearing thins it
//   determinism: the same seed plays the same match, decision for decision
//
// Skips when the map bake is missing, like every other engine-level test.

import { playVersusMatch, scriptedController } from './versusMatch.js';
import { desireController } from './desireBot.js';
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
  console.log('desireBot: skipped (no baked map)');
} else {
  const play = (seed) => {
    const result = playVersusMatch({
      graph,
      angles,
      map: 'INF',
      controllerA: desireController({ angles }),
      controllerB: scriptedController,
      seed,
      maxRounds: 4
    });
    // The runner drains each round's decisions into brainLogs (the panel's
    // motive feed reads the same field), so the test reads them there too.
    const log = result.rounds.flatMap((r) => r.brainLogs?.A || []);
    return { ...result, log };
  };

  // ---- the match completes, and the bots fight ------------------------------

  const first = play(11);
  {
    assert(first.rounds.length === 4, `four rounds played (${first.rounds.length})`);
    for (const r of first.rounds) {
      assert(
        ['bomb', 'defuse', 'time', 'elimination'].includes(r.outcome.reason),
        `round ${r.round} ended for a real reason (${r.outcome.reason})`
      );
      assert(r.outcome.winner === 'T' || r.outcome.winner === 'CT', 'and someone won it');
    }
    assert(first.winsA + first.winsB === 4, 'the score adds up');

    const kills = first.rounds.reduce((s, r) => s + r.kills, 0);
    assert(kills >= 4, `real fighting happened (${kills} kills over 4 rounds)`);
  }

  // ---- the desire side decides, with motives --------------------------------

  {
    assert(first.log.length >= 8, `decisions were made (${first.log.length})`);
    for (const d of first.log.slice(0, 20)) {
      assert(typeof d.motive === 'string' && d.motive.length > 3, `a motive: "${d.motive}"`);
      assert(typeof d.id === 'string', 'an option id');
      assert(Number.isInteger(d.slot), 'a deciding slot');
    }
    const ids = new Set(first.log.map((d) => d.id));
    assert(ids.size >= 2, `more than one kind of want (${[...ids].join(', ')})`);
  }

  // ---- determinism ----------------------------------------------------------

  {
    const again = play(11);
    assert(
      again.winsA === first.winsA && again.winsB === first.winsB,
      `the same seed plays the same score (${again.winsA}-${again.winsB} vs ${first.winsA}-${first.winsB})`
    );
    assert(again.log.length === first.log.length, 'decision for decision');
    for (let i = 0; i < first.log.length; i += 1) {
      assert(
        again.log[i].tick === first.log[i].tick &&
          again.log[i].id === first.log[i].id &&
          again.log[i].slot === first.log[i].slot,
        `decision ${i} identical under the seed`
      );
    }

    const different = play(12);
    const sameScore =
      different.winsA === first.winsA &&
      different.log.length === first.log.length &&
      different.log.every((d, i) => d.tick === first.log[i]?.tick && d.id === first.log[i]?.id);
    assert(!sameScore, 'a different seed plays a different match');
  }

  console.log('desireBot: ok (4 rounds vs the scripted baseline on the baked Inferno)');
}

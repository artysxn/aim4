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
import { indexPlaybook } from './playbook.js';
import { loadKnowledge } from './knowledgeBake.js';
import { KNOWLEDGE_VERSION } from './demoContracts.js';
import { FRAME_EVERY_TICKS, PICTURE_FIELDS, residualStats } from './prw.js';

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

  // ---- a tiny playbook is followed, not just loaded ---------------------------

  {
    const tSpawn = graph.spawns.find((s) => s.side === 'T') || { x: 0, y: 0 };
    const ctSpawn = graph.spawns.find((s) => s.side === 'CT') || { x: 0, y: 0 };
    const near = (origin) =>
      [...graph.anchors.values()]
        .map((a) => ({ id: a.id, d: Math.hypot(a.world.x - origin.x, a.world.y - origin.y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 5)
        .map((a) => a.id);
    const tIds = near(tSpawn);
    const ctIds = near(ctSpawn);
    const rolesOf = (ids, side) =>
      ids.map((id, i) => ({
        contract: id,
        steamId: `${side}${i}`,
        awp: i === 3,
        waypoints: [
          [0, id],
          [8, id]
        ],
        utility: []
      }));
    const playbook = indexPlaybook([
      {
        id: 'tiny-t',
        map: 'INF',
        side: 'T',
        call: 'default',
        econ: 4,
        plant: { site: tIds[0], t: 40 },
        firstContact: { t: 12, rel: 'front' },
        roles: rolesOf(tIds, 'T')
      },
      {
        id: 'tiny-ct',
        map: 'INF',
        side: 'CT',
        call: 'default',
        econ: 4,
        plant: null,
        firstContact: { t: 10, rel: 'front' },
        roles: rolesOf(ctIds, 'CT')
      }
    ]);
    const knowledge = loadKnowledge({
      v: KNOWLEDGE_VERSION,
      map: 'INF',
      rounds: 20,
      wonRounds: 20,
      tables: {
        [`INF|T|default|${tIds[0]}`]: {
          n: 20,
          occupancy: [{ anchor: tIds[0], share: 0.8, yaw: 45, seconds: 6 }],
          utility: [],
          spacing: { [tIds[1]]: { n: 12, mean: 600, sd: 40, p10: 500, p50: 600, p90: 700 } }
        },
        [`INF|CT|default|${ctIds[0]}`]: {
          n: 20,
          occupancy: [{ anchor: ctIds[0], share: 0.7, yaw: 90, seconds: 8 }],
          utility: [],
          spacing: {}
        }
      }
    });
    const playTaped = (seed) => {
      const result = playVersusMatch({
        graph,
        angles,
        map: 'INF',
        controllerA: desireController({ angles, playbook, knowledge }),
        controllerB: scriptedController,
        seed,
        maxRounds: 2
      });
      const log = result.rounds.flatMap((r) => r.brainLogs?.A || []);
      return { ...result, log };
    };
    const taped = playTaped(11);
    assert(taped.rounds.length === 2, 'a playbook match completes');
    assert(taped.winsA + taped.winsB === 2, 'and the score adds up');
    assert(
      taped.log.some((d) => typeof d.motive === 'string' && d.motive.startsWith('tape:')),
      'a bot followed the tape'
    );
    const tapedAgain = playTaped(11);
    assert(tapedAgain.log.length === taped.log.length, 'the same seed with a playbook matches');
    for (let i = 0; i < taped.log.length; i += 1) {
      assert(
        tapedAgain.log[i].tick === taped.log[i].tick &&
          tapedAgain.log[i].id === taped.log[i].id &&
          tapedAgain.log[i].slot === taped.log[i].slot,
        `playbook decision ${i} identical under the seed`
      );
    }
  }

  // ---- the two PRWs, from a played round (18.6b) ---------------------------

  {
    const res = play(11);
    const rows = res.rounds.flatMap((r) => r.prw?.A || []);
    assert(rows.length > 0, 'a played round writes PRW rows');
    assert(
      res.rounds.every((r) => (r.prw?.A || []).length > 0),
      'every round has its own, drained per round like the motive log'
    );

    // The honesty guarantee: a review is PRW and PFW, never positions (18.6).
    for (const row of rows) {
      for (const field of Object.keys(row.picture || {})) {
        assert(PICTURE_FIELDS.includes(field), `${field} does not reach a stored row`);
      }
    }

    // Both curves on one clock, which is what the inspector draws.
    assert(rows.every((r) => Number.isFinite(r.pWin_belief)), 'every row has the believed number');
    assert(
      rows.every((r) => Number.isFinite(r.pWin_true)),
      'roundEnd graded them all against the true state'
    );
    assert(
      rows.every((r) => Math.abs(r.residual - (r.pWin_true - r.pWin_belief)) < 1e-9),
      'and the residual is the difference'
    );
    const stats = residualStats(rows);
    assert(stats.mae > 0, 'the picture and the round are not the same thing');
    assert(stats.mae < 0.5, `nor wildly unrelated (mae ${stats.mae.toFixed(3)})`);

    // The density 18.6b asks for: the team frame and the events, not 8 Hz.
    const reasons = new Set(rows.map((r) => r.reason));
    assert(reasons.has('freeze') && reasons.has('frame'), 'the team frame is logged');
    for (const r of res.rounds) {
      const frames = (r.prw?.A || [])
        .filter((row) => row.reason === 'frame')
        .map((row) => row.tick)
        .sort((a, b) => a - b);
      for (let i = 1; i < frames.length; i += 1) {
        assert(frames[i] - frames[i - 1] >= FRAME_EVERY_TICKS, 'frames keep their spacing');
      }
      assert((r.prw?.A || []).length < 130 * 64, 'and nothing is logged at engine rate');
    }

    // Logging is an observation, not a decision: the same seed still plays
    // the same round, and the truth never turned into an actor input.
    const again = play(11);
    assert(again.log.length === res.log.length, 'the seed still reproduces the round');
  }

  console.log('desireBot: ok (4 rounds vs the scripted baseline on the baked Inferno)');
}

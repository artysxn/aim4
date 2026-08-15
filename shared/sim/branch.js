// ---------------------------------------------------------------------------
// shared/sim/branch.js
// 6.0: one freeze, several calls, exact worlds apart.
//
// The cleanest teaching material this project can generate (11.5): the same
// round played N times where the ONLY thing that differs is the decision. The
// engine is deterministic and seeded, so each branch replays the identical
// prelude from tick zero and diverges exactly at the call; nothing is
// approximate and nothing needs luck to reproduce.
//
// The freeze savestate ships with the set. Today it documents the world the
// decision was made in; 6.1's mid-round branching restores it instead of
// replaying, once controllers can wake from one.
//
// What this deliberately is not: a match. No economy carry, no halftime, no
// score. A branch set is round 1 played N ways, because comparability is the
// entire product — the moment money or momentum differs between branches, the
// difference on screen stops being the call.
// ---------------------------------------------------------------------------

import { FREEZE_SECONDS, ticksFor } from './constants.js';
import { PHASE, createEngine, serializeSnapshot } from './engine.js';
import { createMatch } from './match.js';
import { skillProfile } from './skill.js';
import { catalogueCanSee } from './scriptedMatch.js';
import { buySide } from './buy.js';
import { RoundRecorder } from './encode.js';
import { Rng } from './rng.js';

/** Branch sets stay small: each call is a full watchable round on disk. */
export const MAX_BRANCH_CALLS = 6;

/**
 * Play one branch set.
 *
 * @param {object} args
 * @param {import('./navGraph.js').NavGraph} args.graph
 * @param {object} args.angles
 * @param {string} args.map
 * @param {Array<string|null>} args.calls   one branch per entry; null lets the
 *                                          side choose for itself, which is the
 *                                          control branch every set should have
 * @param {'T'|'CT'} [args.side]            who the call is forced on
 * @param {(opts: {forceCall: string|null}) => object} args.controllerFor
 *        controller factory for the branching side; called once per branch
 * @param {() => object} args.opponentFor   factory for the other side
 * @param {number} [args.seed]
 * @param {number} [args.money]             wallet for every slot; full-buy by
 *                                          default so econ-matched tapes run
 * @param {string} [args.skillA]            team A skill (team A starts T)
 * @param {string} [args.skillB]
 * @returns {{branches: Array<object>, savestate: string, setup: object}}
 */
export function playBranchSet({
  graph,
  angles,
  map,
  calls,
  side = 'T',
  controllerFor,
  opponentFor,
  seed = 1,
  money = 16000,
  skillA = 'average',
  skillB = 'average'
}) {
  if (!Array.isArray(calls) || !calls.length) throw new Error('branch: no calls');
  if (calls.length > MAX_BRANCH_CALLS) throw new Error(`branch: at most ${MAX_BRANCH_CALLS} calls`);

  const canSee = catalogueCanSee(angles);
  const pathDistance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

  const siteIds = [...graph.anchors.keys()].filter((id) => /site$/.test(id));
  const sites = siteIds.length >= 2 ? siteIds.slice(0, 2) : [...graph.anchors.keys()].slice(0, 2);
  const plantCells = Object.fromEntries(sites.map((id) => [id, new Set(graph.anchor(id).cells)]));

  const teamA = [0, 1, 2, 3, 4].map((slot) => ({ id: `a${slot}`, slot }));
  const teamB = [5, 6, 7, 8, 9].map((slot) => ({ id: `b${slot}`, slot }));

  /**
   * The whole round setup is a pure function of the seed, built fresh per
   * branch. Sharing one roster object across branches would let branch 2 read
   * mutations branch 1 made, which is exactly the leak that would make the
   * branches differ in something other than the call.
   */
  const build = () => {
    const match = createMatch({ map, teamA, teamB });
    const rng = new Rng(seed);
    const tPool = graph.spawns.filter((s) => s.side === 'T');
    const ctPool = graph.spawns.filter((s) => s.side === 'CT');
    let ti = 0;
    let ci = 0;
    const buys = new Map();
    for (const [first, awpSlot] of [[0, 2], [5, 7]]) {
      const group = [first, first + 1, first + 2, first + 3, first + 4];
      for (const [slot, buy] of buySide({
        slots: group,
        moneyOf: () => money,
        side: match.sideOf(first),
        awpSlot
      })) {
        buys.set(slot, buy);
      }
    }
    const roster = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot) => {
      const s = match.sideOf(slot);
      const pool = s === 'T' ? tPool : ctPool;
      const sp = pool[(s === 'T' ? ti++ : ci++) % pool.length];
      const buy = buys.get(slot);
      return {
        id: `p${slot}`,
        side: s,
        x: sp.x,
        y: sp.y,
        z: sp.z || 0,
        weapon: buy.weapon,
        armor: buy.armor,
        helmet: buy.helmet,
        hasKit: buy.hasKit,
        grenades: buy.grenades
      };
    });
    const engine = createEngine({
      map,
      graph,
      seed: seed * 1000 + 1,
      roster,
      sites: plantCells,
      profiles: roster.map((_, slot) => skillProfile(match.teamOf(slot) === 'A' ? skillA : skillB)),
      canSee,
      pathDistance,
      record: 'events',
      recordEvery: 1,
      roundIndex: 0
    });
    const target = graph.anchor(rng.pick(sites));
    const other = graph.anchor(sites.find((id) => id !== target.id) || sites[0]);
    return { match, engine, target, other };
  };

  // The savestate: the frozen world before anyone has decided anything. A
  // bare engine stepped to the freeze boundary with no controller attached,
  // so no intent from any branch leaks into what 6.1 will one day restore.
  const bare = build();
  for (let i = 0; i < ticksFor(FREEZE_SECONDS); i += 1) bare.engine.step();
  const savestate = serializeSnapshot(bare.engine.snapshot());

  const branches = [];
  for (const call of calls) {
    const { match, engine, target, other } = build();
    const recorder = new RoundRecorder(engine);

    const ctrlBranch = controllerFor({ forceCall: call ?? null });
    const ctrlOther = opponentFor();
    const [ctrlA, ctrlB] = side === 'T' ? [ctrlBranch, ctrlOther] : [ctrlOther, ctrlBranch];

    const ctx = { engine, graph, angles, sites, plantCells, target, other, match };
    ctrlA.roundStart({ ...ctx, side: 'T', slots: teamA.map((p) => p.slot) });
    ctrlB.roundStart({ ...ctx, side: 'CT', slots: teamB.map((p) => p.slot) });

    for (let i = 0; i < ticksFor(FREEZE_SECONDS + 130); i += 1) {
      ctrlA.tick({ engine, i, tick: engine.state.tick });
      ctrlB.tick({ engine, i, tick: engine.state.tick });
      engine.step();
      recorder.sample();
      if (engine.state.phase === PHASE.OVER) break;
    }
    if (engine.state.phase !== PHASE.OVER) engine.runToEnd();

    const outcome = engine.outcome();
    branches.push({
      call: call ?? null,
      outcome,
      kills: engine.state.events.filter((e) => e.type === 'death').length,
      ticks: recorder.encodeTicks(),
      meta: recorder.encodeMeta({ round: branches.length + 1 }),
      brainLogs: {
        A: Array.isArray(ctrlA.log) ? ctrlA.log.splice(0) : null,
        B: Array.isArray(ctrlB.log) ? ctrlB.log.splice(0) : null
      },
      prw: {
        A: typeof ctrlA.prwRows === 'function' ? ctrlA.prwRows() : null,
        B: typeof ctrlB.prwRows === 'function' ? ctrlB.prwRows() : null
      }
    });
  }

  return {
    branches,
    savestate,
    setup: { map, seed, side, money, skillA, skillB, sites }
  };
}

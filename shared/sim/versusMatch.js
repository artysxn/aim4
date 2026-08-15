// ---------------------------------------------------------------------------
// shared/sim/versusMatch.js
// A match where each side brings its own brain.
//
// scriptedMatch.js drives both sides from one hard-coded loop, which was the
// right shape for P2 and is the wrong shape from P3b on: the acceptance test
// for the desire arbiter is literally "beat the P3 scripted planner", and that
// needs a runner where side A and side B are different controllers over the
// same engine.
//
// A controller is two functions and a name:
//
//   roundStart(ctx)  called once per round after the engine exists; build
//                    whatever per-round state the side needs
//   tick(ctx)        called every engine tick BEFORE engine.step(); read the
//                    world, set intents
//
// The P3 baseline lives here as scriptedController(), byte-for-byte the
// behavior scriptedMatch.js inlines: walk at a site, smoke the entry, plant,
// rotate, defuse, pull a T to a dropped bomb. The desire side (desireBot.js)
// is another controller over the same interface, and the eval harness plays
// them against each other over paired seeds.
// ---------------------------------------------------------------------------

import { FREEZE_SECONDS, ticksFor } from './constants.js';
import { PHASE, createEngine } from './engine.js';
import { createMatch } from './match.js';
import { skillProfile } from './skill.js';
import { scriptedLoadout, catalogueCanSee, throwLineCarries } from './scriptedMatch.js';
import { buySide } from './buy.js';
import { awpSlotOf } from './contracts.js';
import { RoundRecorder } from './encode.js';
import { Rng } from './rng.js';

/**
 * The P3 baseline as a controller. Every reaction here is hard-coded on
 * purpose: this is the floor the arbiter has to beat, so it must stay exactly
 * as dumb as it was when it was the whole game.
 */
export function scriptedController() {
  let my = null;

  return {
    name: 'scripted',

    roundStart({ engine, side, target, other, graph }) {
      my = { engine, side, target, other, graph, rotated: false, smoked: false };
    },

    tick({ i }) {
      const { engine, side, target, other, graph } = my;
      const state = engine.state;

      if (i === ticksFor(FREEZE_SECONDS) + 1) {
        for (const b of state.bodies) {
          if (b.side !== side) continue;
          const dest = side === 'T' ? target : b.slot % 2 === 0 ? target : other;
          engine.setIntent(b.slot, { moveTo: { cx: dest.cx, cy: dest.cy, level: dest.level } });
        }
      }
      // The approach smoke, from the first T whose line actually carries
      // (same rule as scriptedMatch): a fixed-tick throw put the smoke at
      // the thrower's feet whenever a wall came first.
      if (
        !my.smoked &&
        side === 'T' &&
        i >= ticksFor(FREEZE_SECONDS + 6) &&
        i <= ticksFor(FREEZE_SECONDS + 30) &&
        i % 8 === 0
      ) {
        for (const b of state.bodies) {
          if (b.side !== 'T' || !b.alive || !b.grenades.includes('smokegrenade')) continue;
          if (!throwLineCarries(graph, b, target.world)) continue;
          engine.throwGrenade(b.slot, 'smokegrenade', { x: target.world.x, y: target.world.y });
          my.smoked = true;
          break;
        }
      }

      const bomb = state.bomb;
      if (!bomb.planted) {
        if (side === 'T') {
          for (const b of state.bodies) {
            if (b.side === 'T' && b.alive && b.hasBomb && !b.channel) engine.beginPlant(b.slot);
          }
          if (bomb.dropped) {
            let best = null;
            let bestD = Infinity;
            for (const b of state.bodies) {
              if (!b.alive || b.side !== 'T' || b.hasBomb) continue;
              const d = Math.hypot(b.pos.x - bomb.dropped.x, b.pos.y - bomb.dropped.y);
              if (d < bestD) {
                bestD = d;
                best = b;
              }
            }
            if (best) {
              const cell = graph.nearestWalkable(
                bomb.dropped.x,
                bomb.dropped.y,
                16,
                bomb.dropped.level
              );
              if (cell) best.intent.moveTo = { ...cell, level: bomb.dropped.level };
            }
          }
        }
      } else if (side === 'CT') {
        if (!my.rotated) {
          my.rotated = true;
          const cell = graph.nearestWalkable(bomb.x, bomb.y, 16, graph.levelFor(bomb.z));
          if (cell) {
            for (const b of state.bodies) {
              if (b.alive && b.side === 'CT') {
                engine.setIntent(b.slot, { moveTo: { ...cell, level: cell.level } });
              }
            }
          }
        }
        for (const b of state.bodies) {
          if (b.alive && b.side === 'CT' && !b.channel) engine.beginDefuse(b.slot);
        }
      }
    }
  };
}

/**
 * Play a match between two controller factories.
 *
 * Team A starts T (like scriptedMatch); sides swap at halftime through the
 * match layer, and each controller is re-asked for its side every round, so a
 * controller never needs to know the half.
 *
 * @param {object} args
 * @param {import('./navGraph.js').NavGraph} args.graph
 * @param {object} args.angles
 * @param {string} args.map
 * @param {() => object} args.controllerA   factory: fresh controller per match
 * @param {() => object} args.controllerB
 * @param {number} [args.seed]
 * @param {number} [args.maxRounds]
 * @param {string} [args.skillA]
 * @param {string} [args.skillB]
 * @param {'none'|'events'|'full'} [args.record]
 * @param {number} [args.recordEvery]  keep 1 round in N (engine sampling)
 * @param {boolean} [args.replays]     capture tick buffers for sampled rounds
 * @param {(round: object) => void} [args.onRound]
 * @param {(step: {engine: object, tick: number}) => void} [args.onStep]
 *        optional, AFTER engine.step() each tick (P5 RL collect). Omitted
 *        callers and existing tests are unchanged.
 * @returns {{match: object, rounds: Array<object>, winsA: number, winsB: number}}
 */
export function playVersusMatch({
  graph,
  angles,
  map,
  controllerA,
  controllerB,
  seed = 1,
  maxRounds = 24,
  skillA = 'average',
  skillB = 'average',
  record = 'events',
  recordEvery = 1,
  replays = false,
  infiniteMoney = false,
  onRound = null,
  onStep = null
}) {
  const canSee = catalogueCanSee(angles);
  const pathDistance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

  const teamA = [0, 1, 2, 3, 4].map((slot) => ({ id: `a${slot}`, slot }));
  const teamB = [5, 6, 7, 8, 9].map((slot) => ({ id: `b${slot}`, slot }));
  const match = createMatch({ map, teamA, teamB });

  const siteIds = [...graph.anchors.keys()].filter((id) => /site$/.test(id));
  const sites = siteIds.length >= 2 ? siteIds.slice(0, 2) : [...graph.anchors.keys()].slice(0, 2);
  const plantCells = Object.fromEntries(sites.map((id) => [id, new Set(graph.anchor(id).cells)]));

  const rng = new Rng(seed);
  const rounds = [];
  const ctrlA = controllerA();
  const ctrlB = controllerB();

  while (!match.isOver() && match.state.round <= maxRounds) {
    const setup = match.roundSetup();
    // Bootcamp economics (operator spec): drills are about decisions, not
    // wallets, so every player buys from a full purse every round. The match
    // still settles money normally afterwards; it is simply never short.
    if (infiniteMoney) {
      for (const slot of Object.keys(setup.money)) setup.money[slot] = 16000;
    }

    const tPool = graph.spawns.filter((s) => s.side === 'T');
    const ctPool = graph.spawns.filter((s) => s.side === 'CT');
    let ti = 0;
    let ci = 0;
    const spend = {};
    // Buys are a TEAM decision: who holds the AWP, who takes the kit, and
    // whether this is a save at all cannot be answered one wallet at a time.
    // The AWPer is the same seat each half, which is what a role is.
    const buys = new Map();
    for (const first of [0, 5]) {
      const group = [first, first + 1, first + 2, first + 3, first + 4];
      const side = match.sideOf(first);
      const awpSlot = awpSlotOf({ map, side, slots: group });
      for (const [slot, buy] of buySide({
        slots: group,
        moneyOf: (s2) => setup.money[s2] ?? 0,
        side,
        awpSlot,
        forceBuy: match.state.round >= 24
      })) {
        buys.set(slot, buy);
      }
    }
    const roster = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot) => {
      const side = match.sideOf(slot);
      const pool = side === 'T' ? tPool : ctPool;
      const sp = pool[(side === 'T' ? ti++ : ci++) % pool.length];
      const buy = buys.get(slot) || scriptedLoadout(setup.money[slot] ?? 0, side);
      spend[slot] = buy.cost;
      return {
        id: `p${slot}`,
        side,
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
    match.applySpending(spend);

    const engine = createEngine({
      map,
      graph,
      seed: seed * 1000 + setup.round,
      roster,
      sites: plantCells,
      profiles: roster.map((_, slot) =>
        skillProfile(match.teamOf(slot) === 'A' ? skillA : skillB)
      ),
      canSee,
      pathDistance,
      record,
      recordEvery,
      roundIndex: setup.round - 1
    });
    const recorder = replays && engine.recorded ? new RoundRecorder(engine) : null;

    const target = graph.anchor(rng.pick(sites));
    const other = graph.anchor(sites.find((s) => s !== target.id) || sites[0]);

    const sideA = match.sideOf(0);
    const sideB = match.sideOf(5);
    const ctx = { engine, graph, angles, sites, plantCells, target, other, match };
    ctrlA.roundStart({ ...ctx, side: sideA, slots: teamA.map((p) => p.slot) });
    ctrlB.roundStart({ ...ctx, side: sideB, slots: teamB.map((p) => p.slot) });

    for (let i = 0; i < ticksFor(FREEZE_SECONDS + 130); i += 1) {
      ctrlA.tick({ engine, i, tick: engine.state.tick });
      ctrlB.tick({ engine, i, tick: engine.state.tick });
      engine.step();
      if (onStep) onStep({ engine, tick: engine.state.tick });
      if (recorder) recorder.sample();
      if (engine.state.phase === PHASE.OVER) break;
    }
    if (engine.state.phase !== PHASE.OVER) engine.runToEnd();

    const outcome = engine.outcome();
    match.recordRound(outcome, engine.killCash);

    const round = {
      round: setup.round,
      pistol: setup.pistol,
      outcome,
      kills: engine.state.events.filter((e) => e.type === 'death').length,
      winnerTeam: outcome.winner === sideA ? 'A' : 'B',
      // Which team played which side this round, so a per-side log (the
      // collect tap stamps 'T'/'CT') can be joined to a per-team one.
      sides: { A: sideA, B: sideB },
      score: { ...match.state.score },
      recorded: engine.recorded,
      ticks: recorder ? recorder.encodeTicks() : null,
      meta: recorder ? recorder.encodeMeta({ round: setup.round }) : null,
      // The decision logs are the round's soul on the inspector: drained per
      // round so a stored round carries exactly its own wants.
      brainLogs: {
        A: Array.isArray(ctrlA.log) ? ctrlA.log.splice(0) : null,
        B: Array.isArray(ctrlB.log) ? ctrlB.log.splice(0) : null
      }
    };
    rounds.push(round);
    if (typeof ctrlA.roundEnd === 'function') ctrlA.roundEnd({ outcome, side: sideA, round });
    if (typeof ctrlB.roundEnd === 'function') ctrlB.roundEnd({ outcome, side: sideB, round });
    // After roundEnd, because that is where the two PRWs are graded (18.6b):
    // a row drained before the review carries belief and no truth.
    round.prw = {
      A: typeof ctrlA.prwRows === 'function' ? ctrlA.prwRows() : null,
      B: typeof ctrlB.prwRows === 'function' ? ctrlB.prwRows() : null
    };
    // Same reason, one stage later: the caller's rows are sealed by roundEnd
    // with the outcome, the attribution and the true price (9.25 stage 3).
    round.igl = {
      A: typeof ctrlA.iglRows === 'function' ? ctrlA.iglRows() : null,
      B: typeof ctrlB.iglRows === 'function' ? ctrlB.iglRows() : null
    };
    // 6.1: what each side was ordered to do and whether it complied. A round
    // is one artifact, so if either side heard from a viewer the whole round
    // is stamped: half a clean round is not a clean round.
    const orderRows = {
      A: typeof ctrlA.orderRows === 'function' ? ctrlA.orderRows() : null,
      B: typeof ctrlB.orderRows === 'function' ? ctrlB.orderRows() : null
    };
    if (orderRows.A || orderRows.B) {
      round.orders = orderRows;
      round.humanCalled = Boolean(orderRows.A?.humanCalled || orderRows.B?.humanCalled);
    }
    if (onRound) onRound(round);
  }

  let winsA = 0;
  let winsB = 0;
  for (const r of rounds) {
    if (r.winnerTeam === 'A') winsA += 1;
    else winsB += 1;
  }
  return { match, rounds, winsA, winsB };
}

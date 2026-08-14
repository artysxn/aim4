// ---------------------------------------------------------------------------
// shared/sim/scriptedMatch.js
// The scripted match: the dumbest bots that still play complete Counter-Strike.
//
// One source of truth for the walk-and-shoot baseline, used by the CLI runner
// (scripts/sim-run.mjs) and the server's /api/sim/run alike, because two copies
// of a scripted loop is how the panel and the terminal quietly stop playing the
// same game.
//
// What the script does, and all it does: buys by wallet, walks at a site,
// smokes its own entry, plants on the site, retakes and defuses, pulls a T to
// a dropped bomb. Every one of those is a hard-coded reaction, not a decision;
// the decision layers replace this from P3b on, and this file then survives
// only as the baseline the first learned generation has to beat.
// ---------------------------------------------------------------------------

import { ADHOC_THROW_MAX, FREEZE_SECONDS, ticksFor } from './constants.js';
import { buyFor, buySide } from './buy.js';
import { PHASE, createEngine } from './engine.js';
import { createMatch } from './match.js';
import { skillProfile } from './skill.js';
import { RoundRecorder } from './encode.js';
import { Rng } from './rng.js';

/**
 * The scripted buy, now a thin shim over shared/sim/buy.js.
 *
 * Kept as an export because both match loops and their tests call it, but the
 * rules live in buy.js: side-legal guns, an AWP that somebody actually holds,
 * armour before utility, and a save that the whole side takes together.
 */
export function scriptedLoadout(money, side, opts = {}) {
  return buyFor({ money, side, ...opts });
}

/** Visibility from the angle catalogue: the page's own geometry. */
export function catalogueCanSee(angles) {
  return (watcher, target) => {
    if (watcher.level !== target.level) return false;
    return angles.canSee(watcher.pos.x, watcher.pos.y, target.pos.x, target.pos.y, watcher.level);
  };
}

/**
 * Whether an ad-hoc lob from this body toward a point would actually carry.
 * Walks the same 20-unit line engine.throwGrenade walks; anything under 70%
 * of the capped distance is a grenade at the thrower's own feet.
 */
export function throwLineCarries(graph, body, world) {
  const dx = world.x - body.pos.x;
  const dy = world.y - body.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  const want = Math.min(d, ADHOC_THROW_MAX);
  const ux = dx / d;
  const uy = dy / d;
  let carry = 0;
  for (let step = 20; step <= want; step += 20) {
    if (graph.isSolidWorld(body.pos.x + ux * step, body.pos.y + uy * step, body.level)) break;
    carry = step;
  }
  return carry >= want * 0.7;
}

/**
 * Play a full scripted match.
 *
 * @param {object} args
 * @param {import('./navGraph.js').NavGraph} args.graph
 * @param {object} args.angles       an AngleCatalogue
 * @param {string} args.map
 * @param {number} [args.seed]
 * @param {number} [args.maxRounds]
 * @param {string} [args.skillA]     team A's level (starts T)
 * @param {string} [args.skillB]
 * @param {'none'|'events'|'full'} [args.record]
 * @param {number} [args.recordEvery]  keep 1 round in N (engine sampling)
 * @param {boolean} [args.replays]     capture tick buffers for sampled rounds
 * @param {(round: object) => void} [args.onRound]  per-round callback
 * @returns {{match: object, rounds: Array<object>}}
 */
export function playScriptedMatch({
  graph,
  angles,
  map,
  seed = 1,
  maxRounds = 24,
  skillA = 'average',
  skillB = 'average',
  record = 'events',
  recordEvery = 1,
  replays = false,
  onRound = null
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

  while (!match.isOver() && match.state.round <= maxRounds) {
    const setup = match.roundSetup();

    // Spawns and loadouts.
    const tPool = graph.spawns.filter((s) => s.side === 'T');
    const ctPool = graph.spawns.filter((s) => s.side === 'CT');
    let ti = 0;
    let ci = 0;
    const spend = {};
    // Buys are a TEAM decision: who holds the AWP, who takes the kit, and
    // whether this is a save at all cannot be answered one wallet at a time.
    // The AWPer is the same seat each half, which is what a role is.
    const buys = new Map();
    for (const [first, awpSlot] of [[0, 2], [5, 7]]) {
      const group = [first, first + 1, first + 2, first + 3, first + 4];
      const side = match.sideOf(first);
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
    let rotated = false;
    let smoked = false;

    for (let i = 0; i < ticksFor(FREEZE_SECONDS + 130); i += 1) {
      if (i === ticksFor(FREEZE_SECONDS) + 1) {
        for (const b of engine.state.bodies) {
          const dest = b.side === 'T' ? target : b.slot % 2 === 0 ? target : other;
          engine.setIntent(b.slot, { moveTo: { cx: dest.cx, cy: dest.cy, level: dest.level } });
        }
      }
      // The approach smoke, thrown by the first T whose line to the site
      // actually carries. Throwing on a fixed tick regardless landed the
      // smoke at the thrower's feet whenever a wall was first in line.
      if (!smoked && i >= ticksFor(FREEZE_SECONDS + 6) && i <= ticksFor(FREEZE_SECONDS + 30) && i % 8 === 0) {
        for (const b of engine.state.bodies) {
          if (b.side !== 'T' || !b.alive || !b.grenades.includes('smokegrenade')) continue;
          if (!throwLineCarries(graph, b, target.world)) continue;
          engine.throwGrenade(b.slot, 'smokegrenade', { x: target.world.x, y: target.world.y });
          smoked = true;
          break;
        }
      }

      const bomb = engine.state.bomb;
      if (!bomb.planted) {
        for (const b of engine.state.bodies) {
          if (b.alive && b.hasBomb && !b.channel) engine.beginPlant(b.slot);
        }
        if (bomb.dropped) {
          let best = null;
          let bestD = Infinity;
          for (const b of engine.state.bodies) {
            if (!b.alive || b.side !== 'T' || b.hasBomb) continue;
            const d = Math.hypot(b.pos.x - bomb.dropped.x, b.pos.y - bomb.dropped.y);
            if (d < bestD) {
              bestD = d;
              best = b;
            }
          }
          if (best) {
            const cell = graph.nearestWalkable(bomb.dropped.x, bomb.dropped.y, 16, bomb.dropped.level);
            if (cell) best.intent.moveTo = { ...cell, level: bomb.dropped.level };
          }
        }
      } else {
        if (!rotated) {
          rotated = true;
          const cell = graph.nearestWalkable(bomb.x, bomb.y, 16, graph.levelFor(bomb.z));
          if (cell) {
            for (const b of engine.state.bodies) {
              if (b.alive && b.side === 'CT') {
                engine.setIntent(b.slot, { moveTo: { ...cell, level: cell.level } });
              }
            }
          }
        }
        for (const b of engine.state.bodies) {
          if (b.alive && b.side === 'CT' && !b.channel) engine.beginDefuse(b.slot);
        }
      }

      engine.step();
      if (recorder) recorder.sample();
      if (engine.state.phase === PHASE.OVER) break;
    }
    if (engine.state.phase !== PHASE.OVER) engine.runToEnd();

    const outcome = engine.outcome();
    const kills = engine.state.events.filter((e) => e.type === 'death').length;
    match.recordRound(outcome, engine.killCash);

    const round = {
      round: setup.round,
      pistol: setup.pistol,
      outcome,
      kills,
      recorded: engine.recorded,
      score: { ...match.state.score },
      ticks: recorder ? recorder.encodeTicks() : null,
      meta: recorder ? recorder.encodeMeta({ round: setup.round }) : null
    };
    rounds.push(round);
    if (onRound) onRound(round);
  }

  return { match, rounds };
}

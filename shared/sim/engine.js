// ---------------------------------------------------------------------------
// shared/sim/engine.js
// The round: freeze, live, over, at a fixed 64 Hz, with no wall clock in it.
//
// P1 scope, deliberately. Bodies move, the clock runs, the bomb can be carried
// and planted, and the round ends for the reasons a round ends. There is no
// combat, no utility, and no economy here yet; those are P2, and keeping them
// out means the state machine and the determinism guarantee can be tested on
// their own rather than through a shooting model.
//
// Two rules this file exists to enforce:
//
//   Nothing reads a wall clock. The only time is `tick`, an integer. A round
//   run at 780x and a round run at 1x execute identical code and produce
//   identical output, so there is no train/serve skew to discover later.
//
//   Nothing decides. The engine advances state given intents; it never picks a
//   target or a route. That boundary is what makes the same brains port to a
//   CS2 server by swapping the translator (SIM-PLAN 3, 13).
//
// DOM-free. Runs in the browser, on the server, and in the trainer.
// ---------------------------------------------------------------------------

import {
  ADHOC_FUSE_SECONDS,
  ADHOC_THROW_MAX,
  BOMB_PICKUP_RADIUS,
  BOMB_SECONDS,
  DEFUSE_RADIUS,
  DEFUSE_SECONDS,
  DEFUSE_SECONDS_KIT,
  FLASH_VISION_BLIND,
  FREEZE_SECONDS,
  PLANT_SECONDS,
  ROUND_SECONDS,
  TICK_DT,
  TICK_RATE,
  speedCap,
  ticksFor
} from './constants.js';
import {
  NADE,
  createEffect,
  fireDamagePerTick,
  flashSeconds as flashBlindSeconds,
  heDamage,
  inFire,
  isActive,
  smokeBlocks
} from './grenades.js';
import { seekDirection, stepBody, unit } from './movement2d.js';
import { BODY_RADIUS } from './constants.js';
import { findPath } from './navGraph.js';
import { Rng } from './rng.js';
import { acquire, angleDelta, createMotor, release, resolveShot, stepMotor } from './aimMotor.js';
import { skillProfile } from './skill.js';
import { applyBullet, simWeapon, tagFactor } from './weapons.js';
import { killAward } from './economy.js';
import { SOUND, SoundLog, broadcast, emit, stepFootstep } from './sound.js';

export const PHASE = Object.freeze({
  FREEZE: 'freeze',
  LIVE: 'live',
  OVER: 'over'
});

export const END_REASON = Object.freeze({
  TIME: 'time',
  BOMB_EXPLODED: 'bomb_exploded',
  BOMB_DEFUSED: 'bomb_defused',
  T_ELIMINATED: 't_eliminated',
  CT_ELIMINATED: 'ct_eliminated'
});

/**
 * One body. Mirrors SIM-PLAN 4.3, minus the fields P2 adds (ammo, channels
 * other than planting, tagging), so the shape does not have to change later.
 */
function makeBody(slot, spec) {
  return {
    slot,
    id: spec.id || `bot${slot}`,
    side: spec.side,
    role: spec.role || null,
    pos: { x: spec.x || 0, y: spec.y || 0 },
    z: spec.z || 0,
    vel: { x: 0, y: 0 },
    yaw: spec.yaw || 0,
    pitch: 0,
    level: 'default',
    health: 100,
    armor: spec.armor || 0,
    helmet: Boolean(spec.helmet),
    hasKit: Boolean(spec.hasKit),
    /** Grenades in the pocket, as type stems. Thrown ones are removed. */
    grenades: Array.isArray(spec.grenades) ? [...spec.grenades] : [],
    flashSeconds: 0,
    weapon: spec.weapon || 'ak47',
    gait: 'run',
    stance: 'stand',
    alive: true,
    hasBomb: false,
    channel: null,
    channelUntil: 0,
    magAmmo: 30,
    reserveAmmo: 90,
    reloadUntil: 0,
    lastHitTick: -Infinity,
    stepAccum: 0,
    /** Who this body is currently trying to kill, as a slot index. */
    focus: null,
    /** Set by the controller each decision step; the engine only reads it. */
    intent: { moveTo: null, gait: 'run', yaw: null, chase: false, holdFire: false },
    /** Current route, recomputed when the target changes. */
    route: null,
    routeStep: 0,
    routeKey: null,
    /** Tick of the last failed search, so it is not retried every tick. */
    routeFailedAt: null,
    /** Progress watchdog: where we were, and when we last made ground. */
    lastProgressTick: 0,
    lastProgressAt: { x: 0, y: 0 },
    repaths: 0,
    /** While set, the body is walking back to its cell centre to un-wedge. */
    recoverUntil: 0
  };
}

/**
 * @param {object} cfg
 * @param {string} cfg.map
 * @param {import('./navGraph.js').NavGraph} cfg.graph
 * @param {number} [cfg.seed]
 * @param {Array<object>} cfg.roster  10 specs: {id, side, role, x, y, z, weapon}
 * @param {number} [cfg.bombCarrier]  slot index of the T carrying the bomb
 */
export function createEngine(cfg) {
  const graph = cfg.graph;
  const rng = new Rng(cfg.seed ?? 1);

  const bodies = cfg.roster.map((spec, i) => makeBody(i, spec));
  for (const b of bodies) {
    b.level = graph.levelFor(b.z);
    b.lastProgressAt = { x: b.pos.x, y: b.pos.y };
  }

  // One motor per body. The engine owns bodies; the motor owns hands, and the
  // split is what keeps "how fast is this bot's hand" in one clamped place.
  const motors = bodies.map((b, i) =>
    createMotor(cfg.profiles?.[i] || skillProfile(cfg.skill || 'average'))
  );
  for (let i = 0; i < bodies.length; i += 1) motors[i].yaw = bodies[i].yaw;

  /**
   * Turn a body toward a commanded facing at its own turn rate.
   *
   * The crosshair used to TELEPORT here: any intent yaw, from a pre-aim or a
   * rotation, was assigned straight onto body.yaw, so bots snapped 180 degrees
   * in a single tick and every duel started already on target. The motor's
   * maxTurnRate (8.2, clamped by the pro envelope) existed the whole time and
   * only governed yaw once a fight had a focus; out of combat nothing did.
   *
   * That is why the bots looked like they were spinning: the pre-aim target
   * moves with the belief, and an instant turn to each new one reads as a
   * flick to nowhere.
   */
  function turnToward(body, wantYaw) {
    const rate = motors[body.slot]?.profile?.maxTurnRate ?? 400;
    const step = rate * TICK_DT;
    const delta = angleDelta(body.yaw, wantYaw);
    const move = Math.max(-step, Math.min(step, delta));
    body.yaw = ((((body.yaw + move) % 360) + 540) % 360) - 180;
  }

  const sounds = new SoundLog();

  // ---- what gets written down ---------------------------------------------
  //
  // Recording is OFF by default, and that is the important default. A training
  // run is millions of rounds and almost none of them will ever be watched;
  // logging every shot, reload, and re-path for all of them costs memory and
  // time to produce a stream nobody reads. Only rounds somebody intends to look
  // at need to be replayable.
  //
  // Note what is NOT affected by any of this: the bots. Deaths, damage, sound,
  // and the bomb are applied to state directly and reach the belief through
  // percepts. The event log is for viewers and for analysis, so switching it
  // off changes what can be watched afterwards and never changes what happened.
  // Sampling, so a long run keeps a readable handful rather than all or
  // nothing. `recordEvery: 10000` over a million rounds leaves a hundred, which
  // is enough to watch and small enough to store. Round zero is always one of
  // them, so a run that is stopped early still produced something to look at.
  const sampled =
    !cfg.recordEvery || cfg.recordEvery <= 1
      ? true
      : (cfg.roundIndex || 0) % Math.floor(cfg.recordEvery) === 0;

  const RECORD = sampled ? cfg.record || 'none' : 'none';
  const recordEvents = RECORD === 'events' || RECORD === 'full';
  const recordAll = RECORD === 'full';

  /** Events that describe how the round went, rather than how it was played. */
  const OUTCOME_EVENTS = new Set([
    'death',
    'plant_start',
    'bomb_planted',
    'defuse_start',
    'defuse_broken',
    'bomb_defused',
    'bomb_dropped',
    'bomb_pickup',
    'grenade_throw',
    'grenade_detonate',
    'round_end',
    'freeze_end'
  ]);
  /** Cash earned in-round, per slot, for the payout above (economy.js). */
  const killCash = {};

  const carrier = cfg.bombCarrier ?? bodies.findIndex((b) => b.side === 'T');
  if (carrier >= 0 && bodies[carrier]) bodies[carrier].hasBomb = true;

  const state = {
    map: cfg.map,
    tick: 0,
    phase: PHASE.FREEZE,
    /** Tick the live phase began, so the round clock is derived, never stored. */
    liveTick: ticksFor(FREEZE_SECONDS),
    plantTick: null,
    endTick: null,
    endReason: null,
    winner: null,
    bomb: {
      planted: false,
      site: null,
      x: 0,
      y: 0,
      z: 0,
      planterSlot: null,
      defusedBy: null,
      /** Where a dead carrier left it, or null while somebody holds it. */
      dropped: null
    },
    bodies,
    /** Live utility effects: smokes, fires, and one-tick HE/flash markers. */
    effects: [],
    /** Grenades in the air, waiting on their fuse. */
    nades: [],
    events: []
  };

  const freezeTicks = ticksFor(FREEZE_SECONDS);
  const roundTicks = ticksFor(ROUND_SECONDS);
  const bombTicks = ticksFor(BOMB_SECONDS);
  const plantTicks = ticksFor(PLANT_SECONDS);
  /** Ticks before an unreachable target is searched for again. */
  const REPATH_COOLDOWN = ticksFor(1);
  /** How long a body may make no ground before its route is thrown away. */
  const STUCK_TICKS = ticksFor(0.6);

  function log(type, data) {
    if (!recordEvents) return;
    if (!recordAll && !OUTCOME_EVENTS.has(type)) return;
    state.events.push({ tick: state.tick, type, ...data });
  }

  /** Seconds remaining on whichever clock is currently authoritative. */
  function clock() {
    if (state.phase === PHASE.FREEZE) return (freezeTicks - state.tick) / TICK_RATE;
    if (state.bomb.planted) {
      return (state.plantTick + bombTicks - state.tick) / TICK_RATE;
    }
    return (state.liveTick + roundTicks - state.tick) / TICK_RATE;
  }

  function aliveCount(side) {
    let n = 0;
    for (const b of bodies) if (b.alive && b.side === side) n += 1;
    return n;
  }

  function endRound(reason, winner) {
    if (state.phase === PHASE.OVER) return;
    state.phase = PHASE.OVER;
    state.endTick = state.tick;
    state.endReason = reason;
    state.winner = winner;
    log('round_end', { reason, winner });
  }

  // Collision runs at full radar resolution, not at lattice resolution: the
  // nav lattice is eroded by the body radius so routes are walkable, and using
  // that same eroded grid to collide would make bodies float 16 units off every
  // wall and unable to reach the angles a player holds.
  const isSolidFor = (body) => (x, y) => graph.isSolidWorld(x, y, body.level);

  /**
   * Follow the current route toward the intended target.
   *
   * Route recomputation is deliberately lazy: only when the target changes or
   * the body has fallen off the route. A* is sub-millisecond (navGraph) but at
   * 64 Hz for ten bodies it would still be the most expensive thing in the
   * engine, and re-pathing every tick also makes movement jitter at cell
   * boundaries.
   */
  function advance(body) {
    const target = body.intent.moveTo;
    if (!target) {
      // No order: bleed off speed rather than freezing mid-stride. A standing
      // body still honours a commanded facing (pre-aim is mostly done while
      // stationary, which is the whole point of it).
      stepBody(body, seekDirection(body.pos, body.vel, body.pos, 0, 0), 0, TICK_DT, isSolidFor(body));
      if (body.intent.yaw !== null && body.intent.yaw !== undefined && body.focus === null) {
        turnToward(body, body.intent.yaw);
      }
      return;
    }

    const here = graph.cellAt(body.pos.x, body.pos.y);
    const wantKey = `${target.cx},${target.cy},${target.level || 'default'}`;

    // A failed search must be remembered, not retried. Keying only on "do we
    // have a route" means an unreachable target runs A* and appends an event
    // every tick for the rest of the round: ten bodies times 7,000 ticks times
    // a full-lattice search, plus an events array that grows without bound. It
    // does not error and it does not stop, it just makes a training run take
    // hours instead of seconds, which is the worst shape a performance bug can
    // have. The failure is recorded against the key and retried on a cooldown,
    // because the map does not change but the body's position does, and a route
    // that was unreachable from inside a wall may be reachable a second later.
    const stale = body.routeKey !== wantKey;
    const retryDue = body.routeFailedAt !== null && state.tick >= body.routeFailedAt + REPATH_COOLDOWN;
    if (stale || (!body.route && (body.routeFailedAt === null || retryDue))) {
      const from = graph.isWalkableCell(here.cx, here.cy, body.level)
        ? { ...here, level: body.level }
        : graph.nearestWalkable(body.pos.x, body.pos.y, 16, body.level);
      body.route = from ? findPath(graph, from, target) : null;
      body.routeKey = wantKey;
      body.routeStep = 0;
      if (body.route) {
        body.routeFailedAt = null;
      } else {
        if (body.routeFailedAt === null) log('path_failed', { slot: body.slot, to: wantKey });
        body.routeFailedAt = state.tick;
      }
    }

    const route = body.route;
    if (!route || body.routeStep >= route.cells.length) return;

    // Walk the waypoint list, skipping cells already behind us so a body that
    // overshoots on a diagonal does not turn round to touch a cell it passed.
    // Tagging: a body that was just shot moves at a fraction of its speed for
    // half a second. It is the difference between an exit frag landing and not.
    const cap =
      speedCap(body.weapon, body.intent.gait || 'run') *
      tagFactor(state.tick - body.lastHitTick);
    let node = route.cells[body.routeStep];
    let world = graph.worldAt(node.cx, node.cy);
    // A fresh route's first cell is the body's own, and the body stands
    // anywhere inside it: steering at that cell's CENTRE walks backwards for a
    // few units on every repath, which is noise on a one-off path and a
    // steady speed tax on a follower that repaths every decision step. A
    // wider skip on the fresh route drops the cells the body is already
    // standing in; after that the tight radius keeps corners honest.
    while (
      body.routeStep < route.cells.length - 1 &&
      Math.hypot(world.x - body.pos.x, world.y - body.pos.y) <
        graph.cellUnits * (body.routeStep === 0 ? 1.25 : 0.5)
    ) {
      body.routeStep += 1;
      node = route.cells[body.routeStep];
      world = graph.worldAt(node.cx, node.cy);
    }

    // A route step that changes level moves the body between floors; z follows
    // the level rather than being simulated, because the 2D engine has no
    // height and the level is the only part of height that decides anything.
    if (node.level && node.level !== body.level) {
      body.level = node.level;
      body.z = node.level === 'lower' ? (graph.cal.lowerZ ?? 0) - 64 : (graph.cal.lowerZ ?? 0) + 64;
      log('level_change', { slot: body.slot, level: body.level });
    }

    // Only the final waypoint is braked into. Counter-strafing at every cell
    // along a corridor is both wrong (players run through corridors) and a
    // deadlock: the brake fires inside the arrive radius while the skip-ahead
    // threshold has not been met, so the body stops between two waypoints and
    // never reaches either. Intermediate cells are steered through at full cap.
    const arrived = body.routeStep >= route.cells.length - 1;

    // Un-wedging. The route runs cell to cell and every cell on it has body
    // clearance, because the lattice is eroded by the body radius. The body,
    // though, is at a POINT inside its cell, and a spawn or a slide can leave
    // that point hard against a wall. Steering from there straight at the next
    // waypoint drives the body into the geometry, both slide axes refuse, and
    // it grinds in place for the rest of the round: routes exist, no path
    // fails, and nobody ever arrives. Before this was found, ten bots walking
    // at one site produced two kills a round because most of them never left
    // the first cell.
    //
    // The recovery is the cell centre, which is stand-able by construction. Get
    // there first, then resume the route.
    const centre = graph.worldAt(here.cx, here.cy);
    const offCentre = Math.hypot(centre.x - body.pos.x, centre.y - body.pos.y);

    const moved = Math.hypot(body.pos.x - body.lastProgressAt.x, body.pos.y - body.lastProgressAt.y);
    if (moved > graph.cellUnits * 0.5) {
      body.lastProgressTick = state.tick;
      body.lastProgressAt = { x: body.pos.x, y: body.pos.y };
      body.recoverUntil = 0;
    } else if (!arrived && state.tick - body.lastProgressTick > STUCK_TICKS) {
      // Only a body that is trying to go somewhere counts as stuck. One that
      // has arrived is standing still on purpose.
      body.lastProgressTick = state.tick;
      body.lastProgressAt = { x: body.pos.x, y: body.pos.y };
      body.repaths += 1;
      body.recoverUntil = state.tick + ticksFor(0.5);
      log('stuck', { slot: body.slot, x: body.pos.x, y: body.pos.y, repaths: body.repaths });
    }

    if (state.tick < body.recoverUntil) {
      // Recovery, in two stages. First get back to the cell centre, which the
      // eroded lattice guarantees is stand-able. If that is not the problem,
      // move along ONE axis toward the next waypoint rather than diagonally:
      // a disc that cannot take a diagonal step between two clear cells can
      // almost always take the two orthogonal steps that make it up, because
      // each of those keeps it aligned with the corridor it is in.
      const capNow =
        speedCap(body.weapon, body.intent.gait || 'run') * tagFactor(state.tick - body.lastHitTick);

      const next = route.cells[Math.min(body.routeStep + 1, route.cells.length - 1)];
      const nextWorld = graph.worldAt(next.cx, next.cy);

      let dir = null;
      if (offCentre > graph.cellUnits * 0.35) {
        dir = unit(centre.x - body.pos.x, centre.y - body.pos.y);
      } else {
        const dx = nextWorld.x - body.pos.x;
        const dy = nextWorld.y - body.pos.y;
        // Try the larger component first; if the body cannot move that way,
        // take the other one.
        const tryX = { x: Math.sign(dx), y: 0 };
        const tryY = { x: 0, y: Math.sign(dy) };
        const first = Math.abs(dx) >= Math.abs(dy) ? tryX : tryY;
        const second = first === tryX ? tryY : tryX;
        const clear = (d) =>
          d.x || d.y
            ? !isSolidFor(body)(
                body.pos.x + d.x * (BODY_RADIUS + 2),
                body.pos.y + d.y * (BODY_RADIUS + 2)
              )
            : false;
        dir = clear(first) ? first : clear(second) ? second : null;
      }

      if (dir) {
        stepBody(body, dir, capNow, TICK_DT, isSolidFor(body));
        return;
      }
    }

    // `chase` is the moving-carrot mode: the target is somewhere the caller
    // will move again before the body reaches it (a follow tape, a pursuit),
    // so braking into it is wrong twice over: the stop costs a full accel ramp
    // per decision step, and the average speed collapses to half the cap. The
    // follower fell 400 units behind its own recording this way before the
    // flag existed. A chasing body runs through the carrot; a body walking to
    // a real destination still counter-strafes into it like a player.
    const wish =
      arrived && !body.intent.chase
        ? seekDirection(body.pos, body.vel, world, cap, 2)
        : unit(world.x - body.pos.x, world.y - body.pos.y);
    stepBody(body, wish, cap, TICK_DT, isSolidFor(body));

    if (body.intent.yaw !== null && body.intent.yaw !== undefined) {
      turnToward(body, body.intent.yaw);
    } else if (Math.hypot(body.vel.x, body.vel.y) > 1) {
      // Facing follows movement, and follows it at a human turn rate: a body
      // rounding a corner sweeps its crosshair round rather than teleporting.
      turnToward(body, (Math.atan2(body.vel.y, body.vel.x) * 180) / Math.PI);
    }
  }

  /**
   * Can `a` see `b` right now? Supplied by the caller, because the one true
   * answer lives in the viewer's vision code and the engine must not grow a
   * second one (SIM-PLAN 1). Defaults to "nobody sees anybody", so an engine
   * built without it runs movement only rather than fighting blind.
   */
  const canSee = cfg.canSee || (() => false);

  // Sound is a BOT input, not a viewer feature. Nothing about it reaches the
  // replay: percepts land on `engine.sounds`, which is what the belief reads
  // and what the observation vector samples. A viewer never needs to hear a
  // footstep; a bot needs to hear one and to be told almost nothing about it.
  //
  // Audibility has to be geodesic or sound travels through walls, so there is
  // no default here. A missing `pathDistance` used to disable the whole system
  // silently, which produces bots that are deaf and a training run that looks
  // fine, so it now refuses instead.
  if (!cfg.pathDistance) {
    throw new Error(
      'createEngine: pathDistance is required. Sound is how bots learn about ' +
        'what they cannot see, and a euclidean fallback would let them hear ' +
        'through walls. Pass a geodesic distance function.'
    );
  }

  function dist(a, b) {
    return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
  }

  /** Smokes that are up right now, refreshed once per tick. */
  let smokesNow = [];
  function refreshSmokes() {
    smokesNow.length = 0;
    for (const e of state.effects) {
      if (e.type === NADE.SMOKE && isActive(e, state.tick)) smokesNow.push(e);
    }
  }

  /**
   * The vision the FIGHT runs on: the injected geometry test, then the state
   * utility imposes on top of it. A flashed watcher sees nothing; a smoke
   * between two bodies blinds both directions. This wrapper is why a thrown
   * smoke changes a gunfight rather than just drawing a circle: everything
   * combat-side goes through here and nothing may call cfg.canSee directly.
   */
  function seeNow(watcher, target) {
    if (watcher.flashSeconds > FLASH_VISION_BLIND) return false;
    if (!canSee(watcher, target)) return false;
    if (
      smokesNow.length &&
      smokeBlocks(smokesNow, watcher.pos.x, watcher.pos.y, target.pos.x, target.pos.y, watcher.level)
    ) {
      return false;
    }
    return true;
  }

  /**
   * Straight-line blockage for blast effects, sampled against the fine mask.
   * Walls shield an HE and block a flash; a cheap sample is honest enough for
   * a 2D world where the alternative is pretending walls do not exist.
   */
  function blastBlocked(x1, y1, x2, y2, level) {
    const d = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(2, Math.ceil(d / 40));
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      if (graph.isSolidWorld(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, level)) return true;
    }
    return false;
  }

  function bearing(from, to) {
    return (Math.atan2(to.pos.y - from.pos.y, to.pos.x - from.pos.x) * 180) / Math.PI;
  }

  /** The nearest enemy this body can actually see, or null. */
  function visibleTarget(body) {
    let best = null;
    let bestD = Infinity;
    for (const other of bodies) {
      if (!other.alive || other.side === body.side) continue;
      if (!seeNow(body, other)) continue;
      const d = dist(body, other);
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  function damage(victim, attacker, amount, group, weapon) {
    const before = victim.health;
    victim.health = Math.max(0, victim.health - amount);
    victim.lastHitTick = state.tick;
    // Getting shot breaks the wire (6.5). Planting is not broken by damage,
    // only by death, which killBody handles by clearing the channel.
    if (victim.channel === 'defusing') {
      victim.channel = null;
      log('defuse_broken', { slot: victim.slot, by: attacker ? attacker.slot : null });
    }
    log('damage', {
      slot: victim.slot,
      by: attacker ? attacker.slot : null,
      amount: Math.min(before, amount),
      group,
      weapon
    });
    if (victim.health <= 0) killBody(victim, attacker, weapon);
  }

  function killBody(victim, attacker, weapon) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.vel.x = 0;
    victim.vel.y = 0;
    victim.channel = null;
    release(motors[victim.slot]);

    if (victim.hasBomb) {
      victim.hasBomb = false;
      state.bomb.dropped = { x: victim.pos.x, y: victim.pos.y, level: victim.level };
      log('bomb_dropped', { slot: victim.slot, x: victim.pos.x, y: victim.pos.y });
    }

    if (attacker) {
      const teamKill = attacker.side === victim.side;
      const cash = killAward(weapon, teamKill);
      killCash[attacker.slot] = (killCash[attacker.slot] || 0) + cash;
      // Anyone still tracking the dead body has to let go, or the motor keeps
      // shooting a corpse and never re-acquires.
      for (const b of bodies) if (b.focus === victim.slot) b.focus = null;
    }

    log('death', {
      slot: victim.slot,
      by: attacker ? attacker.slot : null,
      weapon,
      x: victim.pos.x,
      y: victim.pos.y,
      // The corpse is the sharpest percept in the game (SIM-PLAN 19.9): it says
      // the killer had line of sight to this cell, with this weapon, at this
      // tick. The belief reads it as a hard constraint rather than a hint.
      victimYaw: victim.yaw
    });
  }

  /** One body's gunfight: acquire, aim, fire, resolve. */
  function fight(body) {
    const motor = motors[body.slot];
    const target = visibleTarget(body);

    if (!target) {
      if (body.focus !== null) {
        release(motor);
        body.focus = null;
      }
      return;
    }

    if (body.focus !== target.slot) {
      body.focus = target.slot;
      acquire(motor, {
        targetId: target.slot,
        targetYaw: bearing(body, target),
        tick: state.tick,
        rng
      });
    }

    const d = dist(body, target);
    const speed = Math.hypot(body.vel.x, body.vel.y);
    const reloading = state.tick < body.reloadUntil;

    const r = stepMotor(motor, {
      tick: state.tick,
      targetYaw: bearing(body, target),
      distance: d,
      moveSpeed: speed,
      weapon: body.weapon,
      rng,
      canFire:
        !reloading && body.magAmmo > 0 && body.channel === null && !body.intent.holdFire
    });
    body.yaw = r.yaw;

    if (!r.fire) return;

    body.magAmmo -= 1;
    const info = simWeapon(body.weapon);
    log('shot', { slot: body.slot, weapon: body.weapon, x: body.pos.x, y: body.pos.y });
    pendingSounds.push(
      emit({
        type: SOUND.GUNSHOT,
        x: body.pos.x,
        y: body.pos.y,
        level: body.level,
        slot: body.slot,
        side: body.side,
        tick: state.tick,
        weapon: body.weapon
      })
    );

    const shot = resolveShot(motor, {
      distance: d,
      rng,
      weapon: body.weapon,
      moveSpeed: speed
    });
    if (shot.hit) {
      const out = applyBullet(target, { weapon: body.weapon, distance: d, group: shot.group });
      target.armor = out.armor;
      damage(target, body, out.dealt, shot.group, body.weapon);
    }

    if (body.magAmmo <= 0 && body.reserveAmmo > 0) {
      const take = Math.min(info.magSize || 30, body.reserveAmmo);
      body.magAmmo = take;
      body.reserveAmmo -= take;
      body.reloadUntil = state.tick + ticksFor(info.reloadSeconds || 2.5);
      log('reload', { slot: body.slot });
    }
  }

  /** Emissions produced this tick, flushed to listeners at the end of it. */
  const pendingSounds = [];

  function stepPlanting(body) {
    if (body.channel !== 'planting') return;
    if (!body.alive || !body.hasBomb || state.bomb.planted) {
      body.channel = null;
      return;
    }
    if (state.tick < body.channelUntil) return;
    state.bomb.planted = true;
    state.bomb.planterSlot = body.slot;
    state.bomb.x = body.pos.x;
    state.bomb.y = body.pos.y;
    state.bomb.z = body.z;
    state.plantTick = state.tick;
    body.hasBomb = false;
    body.channel = null;
    log('bomb_planted', { slot: body.slot, x: body.pos.x, y: body.pos.y, site: state.bomb.site });
  }

  function stepDefusing(body) {
    if (body.channel !== 'defusing') return;
    if (!body.alive || !state.bomb.planted || state.phase !== PHASE.LIVE) {
      body.channel = null;
      return;
    }
    if (state.tick < body.channelUntil) return;
    state.bomb.defusedBy = body.slot;
    body.channel = null;
    log('bomb_defused', { slot: body.slot });
    endRound(END_REASON.BOMB_DEFUSED, 'CT');
  }

  /**
   * One tick of utility: fuses burn down, blasts land, fires tick.
   *
   * Detonation order inside a tick does not matter (effects do not interact),
   * but everything here runs BEFORE the bomb clock is checked, so a flash that
   * lands as the round ends still writes its effect for the recorder.
   */
  function stepUtility() {
    // Fuses.
    for (let i = state.nades.length - 1; i >= 0; i -= 1) {
      const n = state.nades[i];
      if (state.tick < n.detonateTick) continue;
      state.nades.splice(i, 1);
      const effect = createEffect({
        type: n.type,
        x: n.x,
        y: n.y,
        level: n.level,
        tick: state.tick,
        thrownBy: n.thrownBy,
        side: n.side
      });
      state.effects.push(effect);
      // `nade`, not `type`: the spread would overwrite the event label.
      log('grenade_detonate', { nade: n.type, x: n.x, y: n.y, slot: n.thrownBy });
      pendingSounds.push(
        emit({
          type: SOUND.GRENADE,
          x: n.x,
          y: n.y,
          level: n.level,
          slot: n.thrownBy,
          side: n.side,
          tick: state.tick
        })
      );

      if (n.type === NADE.HE) {
        for (const b of bodies) {
          if (!b.alive || b.level !== n.level) continue;
          const d = Math.hypot(b.pos.x - n.x, b.pos.y - n.y);
          const hit = heDamage(d, {
            armor: b.armor,
            losClear: !blastBlocked(n.x, n.y, b.pos.x, b.pos.y, n.level)
          });
          if (hit.health <= 0) continue;
          b.armor = Math.max(0, b.armor - hit.armor);
          damage(b, bodies[n.thrownBy] || null, hit.health, 'chest', n.type);
        }
      } else if (n.type === NADE.FLASH) {
        for (const b of bodies) {
          if (!b.alive || b.level !== n.level) continue;
          const d = Math.hypot(b.pos.x - n.x, b.pos.y - n.y);
          if (blastBlocked(n.x, n.y, b.pos.x, b.pos.y, n.level)) continue;
          const bearing = (Math.atan2(n.y - b.pos.y, n.x - b.pos.x) * 180) / Math.PI;
          const off = Math.abs(((bearing - b.yaw + 540) % 360) - 180);
          const blind = flashBlindSeconds({ angleFromFacing: off, distance: d, losClear: true });
          if (blind > b.flashSeconds) b.flashSeconds = blind;
        }
      }
    }

    // Fires burn whoever stands in them, credited to the thrower: running a
    // molly is a priced decision (6.9) and the price has to actually be paid.
    for (const e of state.effects) {
      if (e.type !== NADE.MOLOTOV && e.type !== NADE.INCENDIARY) continue;
      if (state.tick < (e.igniteTick ?? e.startTick) || state.tick >= e.endTick) continue;
      for (const b of bodies) {
        if (!b.alive || b.level !== e.level) continue;
        if (Math.hypot(b.pos.x - e.x, b.pos.y - e.y) > e.radius) continue;
        damage(b, bodies[e.thrownBy] || null, fireDamagePerTick(), 'leg', e.type);
      }
    }

    // Expired effects leave.
    for (let i = state.effects.length - 1; i >= 0; i -= 1) {
      if (state.tick >= state.effects[i].endTick) state.effects.splice(i, 1);
    }
  }

  return {
    state,
    rng,
    graph,
    motors,
    /** Whether this round is one of the sampled ones worth keeping. */
    recorded: recordEvents,
    sounds,
    killCash,

    /** The round result in the shape the economy and the match layer want. */
    outcome() {
      return {
        winner: state.winner,
        reason:
          state.endReason === END_REASON.BOMB_EXPLODED
            ? 'bomb'
            : state.endReason === END_REASON.BOMB_DEFUSED
              ? 'defuse'
              : state.endReason === END_REASON.TIME
                ? 'time'
                : 'elimination',
        planted: state.bomb.planted,
        planterSlot: state.bomb.planterSlot ?? null,
        defuserSlot: state.bomb.defusedBy ?? null
      };
    },

    clock,
    aliveCount,

    /** Orders come in here and nowhere else. */
    setIntent(slot, intent) {
      const body = bodies[slot];
      if (!body || !body.alive) return;
      body.intent = { ...body.intent, ...intent };
    },

    /**
     * Begin the plant channel. Refused unless the body can actually plant:
     * alive, a T, holding the bomb, live phase, and standing on a site when
     * the caller supplied site geometry. `cfg.sites` maps a site id to a Set
     * of lattice cell indices (the painted anchors carry exactly these), and
     * an engine built without it stays permissive so scripted scenarios and
     * unit tests can plant anywhere.
     */
    beginPlant(slot) {
      const body = bodies[slot];
      if (!body?.alive || body.side !== 'T' || !body.hasBomb || state.bomb.planted) return false;
      if (state.phase !== PHASE.LIVE) return false;
      if (cfg.sites) {
        const c = graph.cellAt(body.pos.x, body.pos.y);
        const idx = c.cy * 256 + c.cx;
        let onSite = null;
        for (const [siteId, cells] of Object.entries(cfg.sites)) {
          if (cells.has(idx)) {
            onSite = siteId;
            break;
          }
        }
        if (!onSite) return false;
        state.bomb.site = onSite;
      }
      body.channel = 'planting';
      body.channelUntil = state.tick + plantTicks;
      log('plant_start', { slot });
      pendingSounds.push(
        emit({
          type: SOUND.PLANT,
          x: body.pos.x,
          y: body.pos.y,
          level: body.level,
          slot,
          side: body.side,
          tick: state.tick
        })
      );
      return true;
    },

    /**
     * Begin the defuse channel: alive, a CT, bomb down, close enough. The wire
     * takes 10 seconds bare and 5 with a kit, it breaks on damage (6.5), and it
     * completes in the body loop BEFORE the bomb clock is checked, so a defuse
     * finishing on the boom tick wins the race. The economy already prices the
     * two orderings apart; the engine has to resolve them the same way.
     */
    beginDefuse(slot) {
      const body = bodies[slot];
      if (!body?.alive || body.side !== 'CT') return false;
      if (!state.bomb.planted || state.phase !== PHASE.LIVE) return false;
      if (body.level !== graph.levelFor(state.bomb.z)) return false;
      const d = Math.hypot(body.pos.x - state.bomb.x, body.pos.y - state.bomb.y);
      if (d > DEFUSE_RADIUS) return false;
      body.channel = 'defusing';
      body.channelUntil =
        state.tick + ticksFor(body.hasKit ? DEFUSE_SECONDS_KIT : DEFUSE_SECONDS);
      log('defuse_start', { slot, kit: body.hasKit });
      pendingSounds.push(
        emit({
          type: SOUND.DEFUSE,
          x: body.pos.x,
          y: body.pos.y,
          level: body.level,
          slot,
          side: body.side,
          tick: state.tick
        })
      );
      return true;
    },

    /**
     * Throw a grenade from the pocket at a world point. The ad-hoc reactive
     * throw from 4.8: a straight line at a fixed speed, capped range, stopped
     * early by the first wall, fixed fuse. Mined lineups replace this for set
     * executes; a molly at the feet does not need a lineup.
     */
    throwGrenade(slot, type, target) {
      const body = bodies[slot];
      if (!body?.alive || body.channel) return false;
      if (state.phase !== PHASE.LIVE) return false;
      const i = body.grenades.indexOf(type);
      if (i < 0) return false;
      body.grenades.splice(i, 1);

      // Walk the line and stop short of the first wall, so a smoke thrown at a
      // wall lands against it rather than inside it.
      const dx = target.x - body.pos.x;
      const dy = target.y - body.pos.y;
      const want = Math.min(Math.hypot(dx, dy), ADHOC_THROW_MAX);
      const ux = dx / (Math.hypot(dx, dy) || 1);
      const uy = dy / (Math.hypot(dx, dy) || 1);
      let landed = 0;
      for (let step = 20; step <= want; step += 20) {
        if (graph.isSolidWorld(body.pos.x + ux * step, body.pos.y + uy * step, body.level)) break;
        landed = step;
      }
      const x = body.pos.x + ux * landed;
      const y = body.pos.y + uy * landed;

      const detonateTick = state.tick + ticksFor(ADHOC_FUSE_SECONDS);
      state.nades.push({
        type,
        x,
        y,
        level: body.level,
        thrownBy: slot,
        side: body.side,
        throwTick: state.tick,
        detonateTick
      });
      // `nade`, not `type`: the spread would overwrite the event label. The
      // origin and fuse ride along so the viewer can draw the flight without
      // reverse-engineering it from tick buffers.
      log('grenade_throw', {
        slot,
        nade: type,
        x,
        y,
        fromX: body.pos.x,
        fromY: body.pos.y,
        detonateTick
      });
      pendingSounds.push(
        emit({
          type: SOUND.GRENADE,
          x: body.pos.x,
          y: body.pos.y,
          level: body.level,
          slot,
          side: body.side,
          tick: state.tick
        })
      );
      return true;
    },

    /** Hurt a body without a bullet. Tests and scripted scenarios. */
    hurt(slot, amount, bySlot = null) {
      const body = bodies[slot];
      if (!body?.alive) return;
      damage(body, bySlot === null ? null : bodies[bySlot], amount, 'chest', 'script');
    },

    /**
     * Kill a body outright. Used by tests and by scripted scenarios; combat
     * goes through the same `killBody` underneath, so there is one death path
     * and one place that pays a kill award.
     */
    kill(slot, bySlot = null, weapon = 'ak47') {
      const body = bodies[slot];
      if (!body?.alive) return;
      killBody(body, bySlot === null ? null : bodies[bySlot], weapon);
    },

    /** One tick. The only way state advances. */
    step() {
      if (state.phase === PHASE.OVER) return state.phase;
      state.tick += 1;

      if (state.phase === PHASE.FREEZE) {
        if (state.tick >= freezeTicks) {
          state.phase = PHASE.LIVE;
          state.liveTick = state.tick;
          log('freeze_end', {});
        }
        return state.phase;
      }

      refreshSmokes();

      for (const body of bodies) {
        if (!body.alive) continue;

        // Eyes recover on their own clock, whatever the body is doing.
        if (body.flashSeconds > 0) body.flashSeconds = Math.max(0, body.flashSeconds - TICK_DT);

        const was = { x: body.pos.x, y: body.pos.y };

        if (body.channel === 'planting' || body.channel === 'defusing') {
          // Channels are stationary by definition; a moving body has cancelled.
          body.vel.x = 0;
          body.vel.y = 0;
          if (body.channel === 'planting') stepPlanting(body);
          else stepDefusing(body);
        } else {
          advance(body);

          // A T walking over a dropped bomb picks it up. Without this, one
          // dead carrier ends the T side's round even with four alive, which
          // is not a rule of the game anybody plays.
          const drop = state.bomb.dropped;
          if (
            drop &&
            body.side === 'T' &&
            body.level === drop.level &&
            Math.hypot(body.pos.x - drop.x, body.pos.y - drop.y) <= BOMB_PICKUP_RADIUS
          ) {
            body.hasBomb = true;
            state.bomb.dropped = null;
            log('bomb_pickup', { slot: body.slot });
          }
        }

        // Footsteps come from ground actually covered, so a body ramping out of
        // cover is silent for its first stride and a body shuffling in place
        // never makes a sound at all.
        const moved = Math.hypot(body.pos.x - was.x, body.pos.y - was.y);
        if (stepFootstep(body, moved)) {
          pendingSounds.push(
            emit({
              type: SOUND.FOOTSTEP,
              x: body.pos.x,
              y: body.pos.y,
              level: body.level,
              slot: body.slot,
              side: body.side,
              tick: state.tick
            })
          );
        }
      }

      // Fighting happens after everyone has moved, so no body shoots at where
      // another one used to be purely because of iteration order.
      for (const body of bodies) {
        if (body.alive) fight(body);
      }

      stepUtility();

      {
        // sound.js works in flat world coordinates rather than in the engine's
        // body shape, so that it can be handed a hypothesis or a demo sample
        // just as easily as a live body. The adapter is here rather than there.
        const listeners = bodies.map((b) => ({
          slot: b.slot,
          side: b.side,
          alive: b.alive,
          x: b.pos.x,
          y: b.pos.y,
          level: b.level
        }));
        for (const snd of pendingSounds) {
          for (const heard of broadcast(snd, listeners, cfg.pathDistance, cfg.zoneNamer)) {
            sounds.push(state.tick, heard.listener, heard.percept);
          }
        }
      }
      pendingSounds.length = 0;

      // Ends, in the order CS resolves them.
      if (state.bomb.planted) {
        if (state.tick >= state.plantTick + bombTicks) {
          endRound(END_REASON.BOMB_EXPLODED, 'T');
          return state.phase;
        }
      } else if (state.tick >= state.liveTick + roundTicks) {
        endRound(END_REASON.TIME, 'CT');
        return state.phase;
      }

      if (aliveCount('T') === 0 && !state.bomb.planted) {
        endRound(END_REASON.T_ELIMINATED, 'CT');
      } else if (aliveCount('CT') === 0) {
        endRound(END_REASON.CT_ELIMINATED, 'T');
      }

      return state.phase;
    },

    /** Run until the round is over, or the cap is hit. */
    runToEnd(maxTicks = ticksFor(FREEZE_SECONDS + ROUND_SECONDS + BOMB_SECONDS + 5)) {
      let n = 0;
      while (state.phase !== PHASE.OVER && n < maxTicks) {
        this.step();
        n += 1;
      }
      return state;
    },

    /**
     * FNV-1a over quantized state. Two runs of the same seed and the same
     * intent stream must produce the same hash at every tick; the gate in 9.8
     * is this function compared across a re-run.
     *
     * Quantized to the tick format's own precision on purpose: a hash over raw
     * floats would fail on a difference the encoded round could not express,
     * which would be a false alarm about a round nobody could tell apart.
     */
    stateHash() {
      let h = 0x811c9dc5;
      const mix = (n) => {
        h ^= n | 0;
        h = Math.imul(h, 0x01000193);
      };
      mix(state.tick);
      mix(state.bomb.planted ? 1 : 0);
      for (const b of bodies) {
        mix(Math.round(b.pos.x * 4));
        mix(Math.round(b.pos.y * 4));
        mix(Math.round(b.z * 4));
        mix(Math.round(b.yaw * 100));
        mix(b.health);
        mix(b.alive ? 1 : 0);
        mix(b.hasBomb ? 1 : 0);
      }
      return h >>> 0;
    }
  };
}

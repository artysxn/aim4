// ---------------------------------------------------------------------------
// shared/sim/translator.js
// Intents in, key presses out. Fixed forever, never learned.
//
// The translator is the boundary that makes the brains portable (SIM-PLAN 6.5):
// above it, everything speaks in anchors and modes; below it, everything is
// this file turning those into the engine's inputs. The 3D port re-implements
// THIS file against a CS2 server plugin; the schema and the brains do not
// change. That is the entire porting story, so nothing here may leak an engine
// detail upward or accept a motor value downward.
//
// It is also deliberately boring. No randomness (the aim motor owns the only
// dice), no decisions (a mode is executed, never chosen), and no state beyond
// what executing a temporally extended order requires: the follower tapes, and
// which one-shot orders have already fired.
// ---------------------------------------------------------------------------

import { DECISION_EVERY_TICKS, TICK_RATE } from './constants.js';
import { findPath } from './navGraph.js';
import { validateIntent, idleIntent, legalIntents } from './intents.js';
import { createFollower, stepFollower, followErrorStats } from './trackFollow.js';

/**
 * @param {object} engine  a createEngine() instance
 * @param {object} [opts]
 * @param {string[]} [opts.siteAnchorIds]  where a commanded plant may route to
 * @param {boolean} [opts.assertLegal]     throw on illegal intents (dev/tests)
 * @param {number[]} [opts.slots]  which slots this translator owns; others are
 *   untouched. A side controller MUST pass its own five: a translator that
 *   steps all ten silently stops the other side's feet every decision step,
 *   which looks like "the enemy never leaves spawn" and takes an evening to
 *   find.
 */
export function createTranslator(engine, opts = {}) {
  const graph = engine.graph;
  const bodies = engine.state.bodies;
  const owned = opts.slots ? new Set(opts.slots) : null;

  /** Per-slot current intent, follower, and one-shot bookkeeping. */
  const slots = bodies.map(() => ({
    intent: idleIntent(),
    follower: null,
    followStartTick: 0,
    followErrors: [],
    thrown: false,
    tapeIndex: null
  }));

  /** Follow-side events for the interrupt classifier: {tick, type, slot}. */
  const events = [];

  function anchorCell(id) {
    const a = graph.anchor(id);
    return a ? { cx: a.cx, cy: a.cy, level: a.level } : null;
  }

  function bearingTo(body, world) {
    return (Math.atan2(world.y - body.pos.y, world.x - body.pos.x) * 180) / Math.PI;
  }

  /**
   * Geodesic units between a body and a recorded pose. Euclidean is wrong in
   * exactly the case that matters (the tape on the far side of a wall reads as
   * close), so this is a real path query; the two points are near each other
   * whenever the follow is healthy, which keeps it cheap.
   */
  function geodesic(pos, pose) {
    const from = graph.nearestWalkable(pos.x, pos.y, 8);
    const to = graph.nearestWalkable(pose.x, pose.y, 8);
    if (!from || !to) return Infinity;
    const path = findPath(graph, from, to, { maxExpansions: 4000 });
    return path ? path.units : Infinity;
  }

  return {
    events,

    /** Hand a slot its intent for the coming steps. Validated at the door. */
    setIntent(slot, intent) {
      const s = slots[slot];
      if (!s) return;
      if (opts.assertLegal) {
        const problems = validateIntent(intent, legalIntents(engine, slot));
        if (problems.length) {
          throw new Error(`illegal intent for slot ${slot}: ${problems.join(', ')}`);
        }
      }
      // A new utility order re-arms the one-shot; a repeated identical intent
      // does not, so a planner may re-send its intent every step harmlessly.
      if (intent.utility && JSON.stringify(intent.utility) !== JSON.stringify(s.intent.utility)) {
        s.thrown = false;
        s.tapeIndex = null;
      }
      s.intent = intent;
      if (intent.move?.mode !== 'follow') s.follower = null;
    },

    /** Attach a tape and put the slot in follow mode. */
    startFollow(slot, track) {
      const s = slots[slot];
      s.follower = createFollower(track);
      s.followStartTick = engine.state.tick;
      s.followErrors = [];
      s.intent = {
        ...idleIntent(),
        move: { mode: 'follow', target: null, gait: 'run' },
        follow: { slot }
      };
    },

    followStats(slot) {
      return followErrorStats(slots[slot].followErrors);
    },

    /** Whether the slot's current utility order has fired its one shot. */
    hasThrown(slot) {
      return Boolean(slots[slot]?.thrown);
    },

    /** Playbook utility index of the last successful throw, or null. */
    tapeIndex(slot) {
      const i = slots[slot]?.tapeIndex;
      return Number.isInteger(i) ? i : null;
    },

    isBroken(slot) {
      return Boolean(slots[slot].follower?.broken);
    },

    /**
     * One decision step: turn every slot's intent into engine calls. Call at
     * the decision cadence (every 8 engine ticks), between engine.step()s.
     */
    step() {
      for (let slot = 0; slot < slots.length; slot += 1) {
        if (owned && !owned.has(slot)) continue;
        const s = slots[slot];
        const body = bodies[slot];
        if (!body?.alive) continue;

        const intent = s.intent;
        const move = intent.move || { mode: 'stop' };

        // ---- objectives first: a channel outranks feet ----
        const objective = intent.objective || 'none';
        if (objective === 'plant' && body.hasBomb && !engine.state.bomb.planted) {
          if (engine.beginPlant(slot)) continue;
          // Not on a site yet: route to the nearest one and keep walking.
          if (!move.target && opts.siteAnchorIds?.length) {
            let best = null;
            let bestD = Infinity;
            for (const id of opts.siteAnchorIds) {
              const a = graph.anchor(id);
              if (!a) continue;
              const d = Math.hypot(a.world.x - body.pos.x, a.world.y - body.pos.y);
              if (d < bestD) {
                bestD = d;
                best = a;
              }
            }
            if (best) {
              engine.setIntent(slot, {
                moveTo: { cx: best.cx, cy: best.cy, level: best.level },
                gait: move.gait || 'run'
              });
              continue;
            }
          }
        } else if (objective === 'defuse' && engine.state.bomb.planted) {
          if (body.channel === 'defusing') continue;
          if (engine.beginDefuse(slot)) continue;
          const cell = graph.nearestWalkable(
            engine.state.bomb.x,
            engine.state.bomb.y,
            16,
            graph.levelFor(engine.state.bomb.z)
          );
          if (cell) {
            engine.setIntent(slot, { moveTo: { ...cell }, gait: 'run' });
            continue;
          }
        } else if (objective === 'pickupBomb' && engine.state.bomb.dropped) {
          const d = engine.state.bomb.dropped;
          const cell = graph.nearestWalkable(d.x, d.y, 16, d.level);
          if (cell) {
            engine.setIntent(slot, { moveTo: { ...cell }, gait: 'run', knife: false });
            continue;
          }
        }

        // ---- one-shot utility ----
        if (intent.utility && !s.thrown && !body.channel) {
          const u = intent.utility;
          const travel = Number.isFinite(u.flight)
            ? Math.max(1, Math.round(u.flight * TICK_RATE))
            : Math.max(0, Math.round(u.travelTicks || 0));
          const atWorld = Number.isFinite(u.atX)
            ? { x: u.atX, y: u.atY }
            : graph.anchor(u.at)?.world;
          const fromWorld = Number.isFinite(u.fromX)
            ? { x: u.fromX, y: u.fromY }
            : graph.anchor(u.from)?.world;
          if (atWorld && travel > 0) {
            if (fromWorld) {
              const d = Math.hypot(body.pos.x - fromWorld.x, body.pos.y - fromWorld.y);
              if (d > 80) {
                const cell = graph.nearestWalkable(fromWorld.x, fromWorld.y, 16, body.level);
                if (cell) engine.setIntent(slot, { moveTo: { ...cell }, gait: 'run', knife: false });
                continue;
              }
            }
            if (engine.throwLineup(slot, { type: u.type, from: fromWorld, at: atWorld, travelTicks: travel })) {
              s.thrown = true;
              s.tapeIndex = Number.isInteger(u.tapeIndex) ? u.tapeIndex : null;
            }
          } else {
            const at = atWorld || graph.anchor(u.at)?.world;
            if (at && engine.throwGrenade(slot, u.type, at)) {
              s.thrown = true;
              s.tapeIndex = Number.isInteger(u.tapeIndex) ? u.tapeIndex : null;
            }
          }
        }

        // ---- combat posture ----
        const posture = intent.combat?.posture || 'free';
        const preAim = intent.combat?.preAim ? graph.anchor(intent.combat.preAim) : null;
        engine.setIntent(slot, {
          holdFire: posture === 'avoid',
          // Off unless this frame's move re-asks: setIntent merges, and a
          // knife left out by a stale flag is a bot that forgot it is holding
          // a knife.
          knife: false,
          // `focus` is the engine's own record of an enemy on screen; while it
          // is set the aim motor owns the view, and a pre-aim yaw handed in
          // over it would fight the fight.
          yaw: preAim && body.focus === null ? bearingTo(body, preAim.world) : null
        });

        // ---- feet ----
        switch (move.mode) {
          case 'stop':
            engine.setIntent(slot, { moveTo: null, chase: false });
            break;

          // v2 tape following: steer at the pro's actual position, not at a
          // landmark near it. `point` is a world coordinate, resolved to the
          // nearest walkable cell so the engine's pathing still owns collision
          // and the follower cannot be pushed inside geometry by a sample
          // taken on a ledge the nav graph does not have.
          case 'trace': {
            const pt = move.point;
            if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
              engine.setIntent(slot, { moveTo: null });
              break;
            }
            const d = Math.hypot(pt.x - body.pos.x, pt.y - body.pos.y);
            const cell = graph.nearestWalkable(pt.x, pt.y, 16, body.level);
            engine.setIntent(slot, {
              // Inside a body's width of the sample, stand: a follower that
              // keeps re-pathing to a point it is already on jitters in place,
              // which reads as the back-and-forth shuffle.
              moveTo: d > 32 && cell ? cell : null,
              chase: false,
              gait: move.gait || 'run',
              // Knife out on request: the engine owns the mechanics (speed,
              // the draw delay when the gun must come back), the bot layer
              // owns the judgment of when the map is safe enough to ask.
              knife: Boolean(move.knife),
              // The pro's own view angle, when the tape carries one. This is
              // the half that turns "hold one spot forever" into a bot that
              // checks the angles a human checked.
              ...(Number.isFinite(move.yaw) ? { yaw: move.yaw } : {})
            });
            break;
          }

          case 'advance':
          case 'rotate': {
            const cell = move.target ? anchorCell(move.target) : null;
            engine.setIntent(slot, {
              moveTo: cell,
              chase: false,
              gait: move.mode === 'rotate' ? 'run' : move.gait || 'run'
            });
            break;
          }

          case 'hold': {
            const a = move.target ? graph.anchor(move.target) : null;
            if (!a) {
              engine.setIntent(slot, { moveTo: null });
              break;
            }
            const d = Math.hypot(a.world.x - body.pos.x, a.world.y - body.pos.y);
            // Within the anchor's arm's reach: stand. Outside it: close in.
            engine.setIntent(slot, {
              moveTo: d > 48 ? { cx: a.cx, cy: a.cy, level: a.level } : null,
              chase: false,
              gait: move.gait || 'run'
            });
            break;
          }

          case 'follow': {
            const f = s.follower;
            if (!f) {
              engine.setIntent(slot, { moveTo: null });
              break;
            }
            const seconds = (engine.state.tick - s.followStartTick) / TICK_RATE;
            const r = stepFollower(f, {
              seconds,
              pos: body.pos,
              toCell: (x, y) => {
                const c = graph.nearestWalkable(x, y, 8, body.level);
                return c ? { ...c, level: body.level } : null;
              },
              geodesic,
              dtTicks: DECISION_EVERY_TICKS
            });

            if (r.status === 'follow') {
              s.followErrors.push(r.error);
              engine.setIntent(slot, {
                moveTo: r.holdStill ? null : r.moveTo,
                chase: !r.holdStill,
                gait: r.gait,
                // The tape's yaw only while nothing is being fought: the aim
                // motor owns the crosshair the moment there is a target (10.3).
                yaw: body.focus === null ? r.yaw : null
              });
            } else if (r.status === 'resynced') {
              events.push({ tick: engine.state.tick, type: 'follow_resync', slot });
            } else if (r.status === 'broken' && !s.reportedBreak) {
              s.reportedBreak = true;
              events.push({ tick: engine.state.tick, type: 'follow_error', slot });
              engine.setIntent(slot, { moveTo: null });
            } else if (r.status === 'done' && !s.reportedDone) {
              s.reportedDone = true;
              events.push({ tick: engine.state.tick, type: 'tape_done', slot });
              engine.setIntent(slot, { moveTo: null });
            }
            break;
          }

          default:
            engine.setIntent(slot, { moveTo: null });
        }
      }
    }
  };
}

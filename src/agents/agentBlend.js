// ---------------------------------------------------------------------------
// src/agents/agentBlend.js
// The locomotion blend's arithmetic: which of CS2's directional loops carry a
// body moving in a given direction at a given speed, and how much of the view
// pitch each spine bone takes.
//
// Split out from agentModels.js so it can be read and tested on its own —
// nothing here imports three, the pack, or the loader addons, and every number
// is the one src/cs3d/playerModels.js uses. That is deliberate: the explorer's
// blend and the trainer's are the same blend, and the parts that are only
// numbers should be identical on sight.
// ---------------------------------------------------------------------------

/** The eight directional loops, by the angle (Source degrees, CCW = left) they move in. */
export const DIRS = Object.freeze([
  { key: 'n', angle: 0 },
  { key: 'nw', angle: 45 },
  { key: 'w', angle: 90 },
  { key: 'sw', angle: 135 },
  { key: 's', angle: 180 },
  { key: 'se', angle: -135 },
  { key: 'e', angle: -90 },
  { key: 'ne', angle: -45 }
]);

/** The in-air loops only come in four flavours. */
export const AIR_DIRS = Object.freeze([
  { key: 'n', angle: 0 },
  { key: 'w', angle: 90 },
  { key: 's', angle: 180 },
  { key: 'e', angle: -90 }
]);

/** Below this (Source u/s) the body is standing still: idle, no phase advance. */
export const IDLE_SPEED = 6;

/** Speed (Source u/s) above which an airborne body picks a directional pose. */
export const AIR_MOVE_SPEED = 40;

/**
 * Bones that share the view pitch, low spine to head, and how much of it each
 * takes. The clips are authored aiming level; the game blends an aim matrix on
 * top, weighted toward the head — which is why a CS2 player looking at their
 * feet tips forward rather than folding double. The weights sum to 1.
 */
export const AIM_BONES = Object.freeze([
  ['spine_1', 0.1],
  ['spine_2', 0.15],
  ['spine_3', 0.25],
  ['neck_0', 0.2],
  ['head_0', 0.3]
]);

/** How far the body is allowed to follow the view, degrees. */
export const AIM_PITCH_LIMIT = 55;

/** Shortest signed representative of an angle in degrees, in [−180, 180). */
export function wrap180(d) {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/**
 * Weights of the two directional loops bracketing `angle` (Source degrees),
 * as [key, weight] pairs summing to 1.
 *
 * The neighbour is picked on the SIDE the offset points, not by index: the
 * rings are written in an order that is neither clockwise nor sorted, and
 * "the next one along" would blend a body strafing left with the loop for
 * walking backwards.
 */
export function dirWeights(ring, angle) {
  const step = 360 / ring.length;
  let best = null;
  let bestD = Infinity;
  for (const d of ring) {
    const dd = Math.abs(wrap180(angle - d.angle));
    if (dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  const off = wrap180(angle - best.angle);
  const t = Math.min(1, Math.abs(off) / step);
  if (t < 1e-4) return [[best.key, 1]];
  const nb = ring.reduce((acc, d) => {
    const dd = wrap180(d.angle - best.angle);
    if (Math.sign(dd) === Math.sign(off) && Math.abs(Math.abs(dd) - step) < 1e-3) return d;
    return acc;
  }, null);
  if (!nb) return [[best.key, 1]];
  return [
    [best.key, 1 - t],
    [nb.key, t]
  ];
}

/**
 * The stand layer's idle → walk → run split, and the crouch layer's
 * still → moving one, for a body at `speed` (Source u/s).
 *
 * `runSpeed` is the held weapon's own top speed, so the same 200 u/s is a run
 * with an AWP in hand and a walk with a knife — which is the whole reason the
 * gait reads differently per weapon in the game.
 */
export function gaitWeights(speed, runSpeed, walkScale) {
  const walkRef = runSpeed * walkScale;
  let idle = 0;
  let walk = 0;
  let run = 0;
  if (speed <= IDLE_SPEED) idle = 1;
  else if (speed < walkRef) {
    walk = (speed - IDLE_SPEED) / (walkRef - IDLE_SPEED);
    idle = 1 - walk;
  } else if (speed < runSpeed) {
    run = (speed - walkRef) / (runSpeed - walkRef);
    walk = 1 - run;
  } else run = 1;
  const crouchRef = Math.max(20, runSpeed * 0.34);
  const crouchMove = speed <= IDLE_SPEED ? 0 : Math.min(1, (speed - IDLE_SPEED) / (crouchRef - IDLE_SPEED));
  return { idle, walk, run, crouchMove };
}

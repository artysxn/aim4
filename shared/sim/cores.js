// ---------------------------------------------------------------------------
// shared/sim/cores.js
// Live core and lurker reads (SIM-PLAN 6.18).
//
// The formula is the coach's, not a second one: findCore from cores.js, same
// 60% share, same coreRadius(n) = 150 + 100 * max(2, n), same-level only.
// Own team uses true positions. Enemy team uses the particle filter's
// maximum-likelihood layout, which is a read of a belief and is wrong as
// often as the belief is.
// ---------------------------------------------------------------------------

import { ALONE_DISTANCE, coreRadius, findCore, nearestTeammate } from '../../src/replays/coach/cores.js';

export { ALONE_DISTANCE, coreRadius, findCore, nearestTeammate };

/**
 * Own living bodies as the coach's player list.
 * @param {Array<{slot:number, pos:{x:number,y:number,z?:number}}>} living
 */
export function ownCore(living) {
  return findCore(
    (living || []).map((b) => ({
      id: String(b.slot),
      x: b.pos.x,
      y: b.pos.y,
      z: b.pos.z || 0
    }))
  );
}

/**
 * Heaviest particle as a layout of positions, then findCore over it.
 */
export function enemyCoreFromBelief(belief, graph) {
  if (!belief?.particles?.length) {
    return findCore([]);
  }
  let best = belief.particles[0];
  for (const p of belief.particles) {
    if (p.weight > best.weight) best = p;
  }
  const alive = [];
  best.slots.forEach((sl, i) => {
    if (!sl) return;
    const a = graph?.anchor?.(sl.anchor);
    if (!a) return;
    alive.push({
      id: `e${i}`,
      x: a.world.x,
      y: a.world.y,
      z: a.world.z || 0
    });
  });
  return findCore(alive);
}

/** Tradeable: a teammate inside ALONE_DISTANCE. */
export function isTradeable(player, mates) {
  return nearestTeammate(player, mates) <= ALONE_DISTANCE;
}

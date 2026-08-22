// ---------------------------------------------------------------------------
// mapCollision.js
// One door in front of the two worlds a scenario can be played in: a list of
// cover boxes (BoxCollision.js, every arena the trainer ships) or a ported map's
// triangle hull (MeshCollision.js).
//
// Every caller keeps passing the same `colliders` value it always passed and
// keeps getting the same answers, so nothing outside this file has to know
// which kind of world it is standing in. That is the whole point: the movement,
// the bots and the spawn picker are shared, and a map that needed its own copy
// of any of them would drift away from the arenas one fix at a time.
// ---------------------------------------------------------------------------

import { groundHeightAt, resolveBoxCollisions } from './BoxCollision.js';
import { BODY_R } from '../multiplayer/constants.js';

/** Is there a world to collide with at all? */
export function hasCollision(colliders) {
  return !!(colliders && (colliders.isMeshCollider ? colliders.length > 0 : colliders.length));
}

/** Highest walkable surface at (x, z). */
export function supportHeightAt(x, z, colliders, footY, floorY = 0) {
  if (!hasCollision(colliders)) return floorY;
  return colliders.isMeshCollider
    ? colliders.groundHeightAt(x, z, footY, floorY)
    : groundHeightAt(x, z, colliders, footY, floorY);
}

/** Push a body out of whatever it is inside. Mutates `pos` and `vel`. */
export function resolveCollisions(pos, vel, footY, crouch, colliders, radius = BODY_R) {
  if (!hasCollision(colliders)) return;
  if (colliders.isMeshCollider) colliders.resolve(pos, vel, footY, crouch, radius);
  else resolveBoxCollisions(pos, vel, footY, crouch, colliders, radius);
}

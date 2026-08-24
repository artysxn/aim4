// ---------------------------------------------------------------------------
// trainerNadeFlight.js
// The aim trainer's binding of the shared projectile entity
// (src/cs3d/projectilesCore.js) to the WebGL renderer it draws with.
//
// The twin of src/cs3d/projectiles.js, and that is the whole content of this
// file: the flight, the 64 Hz stepping, the render-time interpolation, the
// tumble, the trails, the bounce hook and `fastForward` are all the map
// practice mode's code, running here. Only the `three` differs, and it has to
// be a separate module to differ — see the core's header.
//
// `createHullWorld` comes through with the trainer's unit scale baked in: a
// ported map's collision hull is in metres and the sim is in Source units, so
// the SAME broadphase adapter is asked for a factor of 0.0254 that the
// explorer's packs, already in units, ask for as 1.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js?three-webgl';
import { createHullWorld } from '../cs3d/hullWorld.js';
import { makeProjectiles } from '../cs3d/projectilesCore.js';
import { UNIT_M } from '../../shared/sim3d/units.js';

const { Projectiles: CoreProjectiles } = makeProjectiles({
  THREE,
  cloneSkinned,
  /**
   * The audience is ignored, and that is a real difference worth naming.
   *
   * The explorer's pack merges its collision in bands, so it can hand a
   * grenade the `nade` set (stopped by `grenadeclip`, through `playerclip`) and
   * a player the `walk` set. The porter merges walk-solid geometry into ONE
   * mesh, so a grenade in the trainer is stopped by whatever stops a player —
   * which is right everywhere except at a `grenadeclip` or a `playerclip`, and
   * fixing it means the porter carrying a second hull, not this line changing.
   */
  createHullWorld: (collider) =>
    collider ? createHullWorld({ bvh: collider.bvh }, 'walk', null, { unitScale: UNIT_M }) : null
});

/**
 * The core, drawn at the trainer's scale.
 *
 * Everything the projectile system puts on screen is authored in SOURCE UNITS:
 * `_place` writes `sourceToScene(sim.pos)` straight into the group, a trail is
 * a line of those same positions, and a grenade model comes out of the weapons
 * pack in the pack's own frame. The map practice mode's scene IS Source units,
 * so all three land correctly there with no conversion at all.
 *
 * The trainer's scene is METRES. Undoing that per-thing would mean scaling the
 * model, dividing every position and dividing every trail vertex — three
 * conversions to keep in step, in code that is deliberately shared. Scaling the
 * one group they all hang off converts the whole subsystem at once, and keeps
 * the shared core free of any knowledge of which scene it is drawing into.
 *
 * Only the DRAWING is scaled. The sim underneath stays in Source units, which
 * is what `createHullWorld`'s `unitScale` above is for and what every caller
 * that hands this a position or reads a detonation out of it already speaks.
 */
export class Projectiles extends CoreProjectiles {
  constructor(opts) {
    super(opts);
    this.root.scale.setScalar(UNIT_M);
  }
}

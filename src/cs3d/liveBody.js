// ---------------------------------------------------------------------------
// src/cs3d/liveBody.js
// A player body driven by a LIVE movement sim rather than a recorded tick:
// the explorer's own walking body today, bots and other players tomorrow.
// The same PlayerBody the demo viewers animate — one body, two sources of
// truth, exactly the split CS3D-PLAN §0 asks for (one brain, two bodies): a
// recorded tick and a simulated tick feed the same `set()`.
//
// What the sim gives that a demo does not: exact velocity and ground state
// every tick, so the blend runs on the real numbers instead of a finite
// difference of quantised positions.
// ---------------------------------------------------------------------------

import { sourceYawFromCamera } from '../../shared/sim3d/units.js';
import { EYE_STAND, EYE_DUCK } from '../../shared/sim3d/constants.js';

const RAD = 180 / Math.PI;

export class LiveBody {
  /**
   * @param {import('./playerModels.js').PlayerModels} models
   * @param {() => import('three').Object3D|null} getRoot  where the body lives (the pack's world)
   */
  constructor(models, getRoot) {
    this.models = models;
    this.getRoot = getRoot;
    this.body = null;
    this.side = 'T';
  }

  /** Team model to wear; takes effect on the next update. */
  setSide(side) {
    if (side === 'T' || side === 'CT') this.side = side;
  }

  /**
   * Read the explorer's Player (its `sim` is Source frame, its camera angles
   * are the view) and pose the body at it. `visible` false keeps it updated
   * but hidden — first person, where your own body would sit in the camera.
   */
  update(player, dt, { visible = true } = {}) {
    if (!this.models.ready) return;
    if (!this.body) {
      const root = this.getRoot();
      if (!root) return;
      this.body = this.models.createBody(this.side);
      root.add(this.body.group);
    } else if (this.body.side !== this.side) this.body.setSide(this.side);
    const b = this.body;
    const s = player.sim;
    const speed = Math.hypot(s.vel.x, s.vel.y);
    const viewYaw = sourceYawFromCamera(player.yaw);
    // The eased eye height is the duck amount the camera is showing; the body
    // crouches with it rather than snapping with the hull.
    const duck = Math.max(0, Math.min(1, (EYE_STAND - player.eyeSmooth) / (EYE_STAND - EYE_DUCK)));
    b.set({
      speed,
      moveYaw: speed > 1 ? Math.atan2(s.vel.y, s.vel.x) * RAD : viewYaw,
      viewYaw,
      // Camera pitch is up-positive radians; Source pitch is down-positive degrees.
      pitch: -player.pitch * RAD,
      duck,
      airborne: !s.onGround,
      weapon: player.weapon,
      alive: true
    });
    b.group.position.set(s.pos.x, s.pos.z, -s.pos.y);
    b.update(dt);
    b.group.visible = visible;
  }

  dispose() {
    this.body?.dispose();
    this.body = null;
  }
}

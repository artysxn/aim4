// ---------------------------------------------------------------------------
// replays/duels/visionState.js
// Who can see whom, and who saw it first.
//
// A duel is defined by vision: two enemies with a clear line between them are
// in a potential duel, and the moment either one has the other inside their
// screen they are in an active one. Everything the model reasons about hangs
// off that, so the geometry is settled here once per pair per tick and handed
// on as plain numbers.
//
// The FOV used is the real one a player sees on a 16:9 monitor, not the 30
// degree wedge the zone overlay paints. The overlay's cone is deliberately
// narrow because it is estimating map control, which is about where attention
// is; a duel is about what is on screen, which is much wider. A player with an
// enemy at 50 degrees off centre has not "spotted" them in any useful sense,
// but the pixels are there, and the crosshair-offset feature is what expresses
// how little that is worth.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { isLowerLevel } from '../viewer/mapCalibration.js';
import { losBlockedBetween } from './sightRay.js';

/**
 * Half of the horizontal field of view, degrees.
 * CS2's default 90 degree FOV is quoted 4:3; on 16:9 that is ~106 across.
 */
export const VISION_HALF_FOV_DEG = 53;

/** Range cap for vision tests, world units. Matches the zone overlay's reach. */
export const VISION_MAX_DIST = 4200;

/**
 * How long a pair may lose sight of each other before their engagement is
 * treated as over. Short enough that repeeking the same angle counts as a new
 * fight, long enough that a doorframe passing between them does not.
 */
export const DISENGAGE_GRACE_SECONDS = 3;

const RAD_TO_DEG = 180 / Math.PI;

/** World bearing from one point to another, in the same convention as yaw. */
export function bearingDeg(fromX, fromY, toX, toY) {
  return Math.atan2(toY - fromY, toX - fromX) * RAD_TO_DEG;
}

/** Smallest absolute angle between two bearings, 0 to 180. */
export function angleOffset(yawDeg, targetDeg) {
  let d = (targetDeg - yawDeg) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.abs(d);
}

/**
 * @typedef {object} PairVision
 * @property {number} dist      world units between the two
 * @property {boolean} losClear nothing solid, and no smoke, in the way
 * @property {number} offA      degrees A's crosshair sits off B
 * @property {number} offB      degrees B's crosshair sits off A
 * @property {boolean} aSeesB   B is on A's screen
 * @property {boolean} bSeesA   A is on B's screen
 */

/**
 * Geometry for one pair of enemies at one tick.
 *
 * @param {object} args
 * @param {{x:number,y:number,z:number,yaw:number}} args.a
 * @param {{x:number,y:number,z:number,yaw:number}} args.b
 * @param {object} args.network  prepared zone network
 * @param {string} args.mapCode
 * @param {Array<{x:number,y:number}>} [args.smokes]
 * @param {Uint8Array} [args.blockedMask]  hoisted out of the per-pair loop
 * @returns {PairVision}
 */
export function pairVision({ a, b, network, mapCode, smokes = null, blockedMask = null }) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const toB = bearingDeg(a.x, a.y, b.x, b.y);
  const offA = angleOffset(a.yaw, toB);
  const offB = angleOffset(b.yaw, toB + 180);

  let losClear = dist <= VISION_MAX_DIST;
  // Stacked maps are two floors sharing one radar. Two players on opposite
  // levels project on top of each other and would otherwise read as a duel at
  // point-blank range through a concrete slab.
  if (losClear && isLowerLevel(mapCode, a.z) !== isLowerLevel(mapCode, b.z)) losClear = false;
  if (losClear) {
    losClear = !losBlockedBetween({
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      network,
      mapCode,
      blockedMask,
      smokes
    });
  }

  return {
    dist,
    losClear,
    offA,
    offB,
    aSeesB: losClear && offA <= VISION_HALF_FOV_DEG,
    bSeesA: losClear && offB <= VISION_HALF_FOV_DEG
  };
}

/**
 * Remembers, per pair, who saw whom first in the engagement they are currently
 * in.
 *
 * Information advantage is the whole point: a player who has been watching an
 * angle for two seconds is in a different fight from the one who just walked
 * into it, even when the two crosshairs are identical. That only means anything
 * relative to the current engagement, so once a pair has been out of contact
 * for the grace period both clocks are thrown away and the next contact starts
 * a fresh one.
 *
 * Ticks must arrive in order. Seeking backwards in the viewer invalidates the
 * state, which is what `reset()` is for.
 */
export function createVisionTracker(tickRate = 64) {
  const graceTicks = DISENGAGE_GRACE_SECONDS * tickRate;
  /** first tick A saw B, keyed a*16+b */
  const firstSeen = new Map();
  /** last tick the pair had a clear line, keyed min*16+max */
  const lastContact = new Map();

  const dirKey = (a, b) => a * 16 + b;
  const pairKey = (a, b) => (a < b ? a * 16 + b : b * 16 + a);

  return {
    reset() {
      firstSeen.clear();
      lastContact.clear();
    },

    /**
     * Fold one tick's pair geometry into the tracker.
     * @param {number} tick
     * @param {Array<{aSlot:number,bSlot:number,vision:PairVision}>} pairs
     */
    observe(tick, pairs) {
      for (const p of pairs) {
        const pk = pairKey(p.aSlot, p.bSlot);
        const last = lastContact.get(pk);
        if (last !== undefined && tick - last > graceTicks) {
          // Contact lapsed: this is a new engagement, not a continuation.
          firstSeen.delete(dirKey(p.aSlot, p.bSlot));
          firstSeen.delete(dirKey(p.bSlot, p.aSlot));
          lastContact.delete(pk);
        }
        if (!p.vision.losClear) continue;
        lastContact.set(pk, tick);
        const ab = dirKey(p.aSlot, p.bSlot);
        const ba = dirKey(p.bSlot, p.aSlot);
        if (p.vision.aSeesB && !firstSeen.has(ab)) firstSeen.set(ab, tick);
        if (p.vision.bSeesA && !firstSeen.has(ba)) firstSeen.set(ba, tick);
      }
    },

    /** Tick A first saw B in this engagement, or null. */
    firstSeenTick(aSlot, bSlot) {
      const v = firstSeen.get(dirKey(aSlot, bSlot));
      return v === undefined ? null : v;
    },

    /** Last tick the pair had a clear line, or null. */
    lastContactTick(aSlot, bSlot) {
      const v = lastContact.get(pairKey(aSlot, bSlot));
      return v === undefined ? null : v;
    },

    /**
     * Seconds of head start A has on B, positive when A looked first.
     *
     * One-sided awareness is the extreme case and gets the cap: if A has B on
     * screen and B has never had A on screen this engagement, A is holding an
     * angle on someone who does not know they exist.
     */
    infoAdvantageSeconds(aSlot, bSlot, cap = 4) {
      const aSaw = this.firstSeenTick(aSlot, bSlot);
      const bSaw = this.firstSeenTick(bSlot, aSlot);
      if (aSaw === null && bSaw === null) return 0;
      if (bSaw === null) return cap;
      if (aSaw === null) return -cap;
      const secs = (bSaw - aSaw) / tickRate;
      return Math.max(-cap, Math.min(cap, secs));
    }
  };
}

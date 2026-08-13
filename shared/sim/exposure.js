// ---------------------------------------------------------------------------
// shared/sim/exposure.js
// What they know about me, estimated from my own footprint.
//
// SIM-PLAN 5.6: unawareness is already a fitted, shipped quantity — the duel
// model's `infoW`/`infoTau` run on `visionState.infoAdvantageSeconds`, and
// holding an angle on somebody who does not know you exist is the largest
// non-crosshair term in it. So unawareness is a resource a bot SPENDS, and to
// spend it the bot has to know how much it has.
//
// The catch: the real tracker reads both players' god-view geometry, and a bot
// may not. It estimates from its own side, which is exactly what a human does
// ("they have not seen me: I have not fired, I walked, and nobody had an angle
// on me since I left spawn"). This module is that estimate: a ledger of the
// evidence I EMITTED, queried against enemy hypotheses from the belief.
//
// Two rules keep it honest:
//
//   Only my own emissions enter the ledger. Shots I fired, steps I ran, angles
//   that overlooked me, damage I dealt, utility I threw, my death. Never an
//   enemy's state — the enemy is a hypothesis, supplied by the caller from the
//   filter (knowledge.js), and this module only asks "would that hypothesis
//   have received this evidence".
//
//   The output is interchangeable with the fitted tracker. `infoAdvSecsHat`
//   uses the same ±4 s cap, the same one-sided-awareness-takes-the-cap rule,
//   and the same engagement-grace reset as visionState.js, so it can be fed
//   straight into pairFeatures when foresight prices a hypothetical duel (6.7)
//   and the fitted coefficients still mean what they meant.
//
// v1 is fixed rules, not learned, for the same reason enemy economy inference
// is fixed (5.3): it is a rulebook fact. From P5 the god-view value becomes a
// training-time label and these rules become the prior for a learned head.
// ---------------------------------------------------------------------------

import { SOUND_RADIUS, TICK_RATE } from './constants.js';

/** Same cap as visionState.js, so the numbers are interchangeable. */
export const INFO_ADV_CAP = 4;
/** Same grace as DISENGAGE_GRACE_SECONDS: stale clocks are dead clocks. */
export const EXPOSURE_GRACE_SECONDS = 3;
/** Positional knowledge fades: a shot tells them where I WAS. `[calibrate]` */
export const EVIDENCE_HALF_LIFE_SECONDS = 6;
/** Evidence older than this cannot matter even undecayed. */
export const EVIDENCE_TTL_SECONDS = 15;
/** Cumulative soft evidence at which "they know" flips on (their clock starts). */
export const KNOWN_THRESHOLD = 0.5;

/** Soft-evidence weights, per emission. Hard evidence is weight 1. `[calibrate]` */
export const EVIDENCE_WEIGHT = Object.freeze({
  footstep: 0.35,
  landing: 0.5,
  seenPerSecond: 0.5, // exposure to a facing angle, integrated over time
  utility: 0.5
});

/**
 * One bot's self-footprint: the evidence it has emitted this round.
 *
 * Radius evidence (sounds) applies to any hypothesis geodesically inside the
 * radius. Anchor evidence (being overlooked, utility they watched land) applies
 * to the named anchors the caller computed from the angle catalogue. Slot
 * evidence (damage I dealt) applies to one enemy slot wherever it stands,
 * because a player I just shot knows a sector instantly (5.1).
 */
export class SelfFootprint {
  constructor({ tickRate = TICK_RATE } = {}) {
    this.tickRate = tickRate;
    /** @type {Array<{tick:number, kind:string, weight:number, x?:number, y?:number, level?:string, radius?:number, anchors?:Set<string>, slot?:number}>} */
    this.evidence = [];
    this.deadSinceTick = null;
  }

  reset() {
    this.evidence.length = 0;
    this.deadSinceTick = null;
  }

  // ---- recording, one call per emission -------------------------------------

  /** An unsilenced shot is the loudest thing I can say about my position. */
  noteShot(tick, { x, y, level = 'default', silenced = false }) {
    this.evidence.push({
      tick,
      kind: 'shot',
      weight: 1,
      x,
      y,
      level,
      radius: silenced ? SOUND_RADIUS.gunshotSilenced : SOUND_RADIUS.gunshot
    });
    this.prune(tick);
  }

  /** One running step. Soft: a single step is a hint, a jog is a broadcast. */
  noteFootstep(tick, { x, y, level = 'default' }) {
    this.evidence.push({
      tick,
      kind: 'footstep',
      weight: EVIDENCE_WEIGHT.footstep,
      x,
      y,
      level,
      radius: SOUND_RADIUS.footstep
    });
    this.prune(tick);
  }

  /**
   * I stood inside angles that could see me, facing my way, for `dt` seconds.
   *
   * The caller computes WHICH angles from the catalogue's exposure transpose
   * intersected with belief mass; this ledger only integrates the time. The
   * per-second rate turns loitering in an open lane into certainty and a
   * half-second dash across it into a maybe.
   */
  noteSeenBy(tick, anchorIds, dt) {
    if (!anchorIds || anchorIds.length === 0 || !(dt > 0)) return;
    const w = 1 - Math.exp(-EVIDENCE_WEIGHT.seenPerSecond * dt);
    this.evidence.push({ tick, kind: 'seen', weight: w, anchors: new Set(anchorIds) });
    this.prune(tick);
  }

  /** My utility detonated where these hypotheses could watch it land. */
  noteUtilityLanded(tick, anchorIds) {
    if (!anchorIds || anchorIds.length === 0) return;
    this.evidence.push({
      tick,
      kind: 'utility',
      weight: EVIDENCE_WEIGHT.utility,
      anchors: new Set(anchorIds)
    });
    this.prune(tick);
  }

  /** I hit someone. That slot knows a sector instantly, wherever it stands. */
  noteDamageDealt(tick, victimSlot) {
    this.evidence.push({ tick, kind: 'damage', weight: 1, slot: victimSlot });
    this.prune(tick);
  }

  /** Death is total: their whole team knows, and knows where. */
  noteDeath(tick) {
    this.deadSinceTick = tick;
  }

  /** Drop evidence too old to matter even undecayed. */
  prune(tick) {
    const cutoff = tick - EVIDENCE_TTL_SECONDS * this.tickRate;
    while (this.evidence.length && this.evidence[0].tick < cutoff) this.evidence.shift();
  }

  // ---- queries, against one hypothesis at a time ----------------------------

  decay(ageTicks) {
    return Math.pow(0.5, ageTicks / (EVIDENCE_HALF_LIFE_SECONDS * this.tickRate));
  }

  /**
   * Evidence applicable to a hypothesis, decayed to `tick`.
   *
   * @param {object} h  {anchor, level, x, y, slot?} — an enemy hypothesis from
   *   the belief: where it stands and, when known, which slot it is
   * @param {number} tick
   * @param {(ax:number, ay:number, bx:number, by:number) => number} pathDistance
   *   geodesic, like sound.js: euclidean here would leak through walls
   */
  applicable(h, tick, pathDistance) {
    const out = [];
    for (const e of this.evidence) {
      if (e.tick > tick) continue;
      let applies = false;
      if (e.slot != null) {
        applies = h.slot != null && h.slot === e.slot;
      } else if (e.anchors) {
        applies = e.anchors.has(h.anchor);
      } else {
        const d = pathDistance(h.x, h.y, e.x, e.y);
        applies = Number.isFinite(d) && d <= e.radius;
      }
      if (applies) out.push({ ...e, decayed: e.weight * this.decay(tick - e.tick) });
    }
    return out;
  }

  /**
   * P(this hypothesis knows about me), in [0, 1].
   *
   * Independent-evidence combination: 1 − Π(1 − wᵢ). Not a calibrated
   * probability — a monotone score fed to a model that was fitted on the real
   * quantity, which is why the shape (hard beats soft, recent beats stale)
   * matters more than the absolute value.
   */
  pKnowsMe(h, tick, pathDistance) {
    if (this.deadSinceTick != null && tick >= this.deadSinceTick) return 1;
    let pUnknown = 1;
    for (const e of this.applicable(h, tick, pathDistance)) {
      pUnknown *= 1 - Math.min(1, e.decayed);
    }
    return 1 - pUnknown;
  }

  /**
   * When did this hypothesis first learn about me, in the CURRENT engagement?
   *
   * The tracker's semantics: clocks live only inside an engagement, and a lapse
   * of the grace period voids them. Here that means evidence trails are walked
   * newest-first and a gap longer than the grace period ends the engagement:
   * whatever lies beyond it belongs to a fight that is already over.
   *
   * Returns the tick, or null when they never crossed the knowing threshold.
   */
  firstKnownTick(h, tick, pathDistance) {
    if (this.deadSinceTick != null && tick >= this.deadSinceTick) return this.deadSinceTick;
    const hits = this.applicable(h, tick, pathDistance);
    if (!hits.length) return null;
    hits.sort((a, b) => a.tick - b.tick);

    // Walk back from the newest evidence; a grace-sized silence ends the
    // engagement, and evidence beyond it is discarded from the clock.
    const grace = EXPOSURE_GRACE_SECONDS * this.tickRate;
    let start = hits.length - 1;
    if (tick - hits[start].tick > grace) return null;
    while (start > 0 && hits[start].tick - hits[start - 1].tick <= grace) start -= 1;

    // Inside the engagement, accumulate undecayed weight oldest-first until
    // the threshold: that crossing is when "they know" flipped on.
    let pUnknown = 1;
    for (let i = start; i < hits.length; i += 1) {
      pUnknown *= 1 - Math.min(1, hits[i].weight);
      if (1 - pUnknown >= KNOWN_THRESHOLD) return hits[i].tick;
    }
    return null;
  }

  /**
   * Estimated seconds of head start I have on this hypothesis, positive when I
   * knew first — `visionState.infoAdvantageSeconds` computed from one side.
   *
   * `myFirstSeenTick`/`myLastSeenTick` come from the caller's belief contact
   * log: when I first and most recently had positive evidence of an enemy at
   * this hypothesis. The same grace that voids their clock voids mine.
   */
  infoAdvSecsHat(h, tick, pathDistance, { myFirstSeenTick = null, myLastSeenTick = null } = {}) {
    const grace = EXPOSURE_GRACE_SECONDS * this.tickRate;
    const mine =
      myFirstSeenTick != null && myLastSeenTick != null && tick - myLastSeenTick <= grace
        ? myFirstSeenTick
        : null;
    const theirs = this.firstKnownTick(h, tick, pathDistance);

    if (mine === null && theirs === null) return 0;
    if (theirs === null) return INFO_ADV_CAP; // they do not know I exist
    if (mine === null) return -INFO_ADV_CAP; // I am the one being held
    const secs = (theirs - mine) / this.tickRate;
    return Math.max(-INFO_ADV_CAP, Math.min(INFO_ADV_CAP, secs));
  }
}

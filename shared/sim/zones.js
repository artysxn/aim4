// ---------------------------------------------------------------------------
// shared/sim/zones.js
// Safe, risk, buffer, unknown: the doctrine's four zone types, computed live.
//
// Chapter 1 of Counter-Strike 101 calls Zone and Layer Theory the single most
// important structural concept in the game, and its definitions are precise
// enough to implement literally. What makes them work here is that they are
// defined RELATIVE TO A SIDE'S KNOWLEDGE, so this is a function of the belief
// and the nav graph rather than a layer somebody paints:
//
//   Safe    we hold it, and an enemy cannot reach it without first taking
//           another zone we are watching
//   Risk    we hold it, but it can be contested right now
//   Buffer  neither side holds it, and it sits between our safe ground and an
//           unknown, so losing it costs the enemy resources to take
//   Unknown unchecked, and by doctrine never assumed clear
//
// The Safe clause is a transcription of the document's own sentence, expressed
// as a reachability query. The map therefore paints itself differently for each
// side every second, which is what the doctrine describes and what a static
// zone layer could never be.
//
// SIM-PLAN 20.2. Everything in the doctrine layer above this reads from it.
// ---------------------------------------------------------------------------

import { TICK_RATE } from './constants.js';

export const ZONE = Object.freeze({
  SAFE: 'safe',
  RISK: 'risk',
  BUFFER: 'buffer',
  UNKNOWN: 'unknown'
});

/** Seconds after which ground we swept counts as unchecked again. `[tune]` */
export const SWEEP_STALE_SECONDS = 12;
/** Belief mass above which a zone is considered to plausibly hold someone. */
export const OCCUPIED_FLOOR = 0.12;

/**
 * Classify every named zone for one side.
 *
 * @param {object} args
 * @param {string[]} args.zones            zone ids to classify
 * @param {(z: string) => boolean} args.holding   do we have a body in or watching it
 * @param {(z: string) => number} args.enemyMass  belief mass that an enemy is there
 * @param {(z: string) => number} args.sweptTick  when we last had eyes on it
 * @param {(z: string) => string[]} args.gates    zones every path into z crosses
 * @param {number} args.tick
 * @returns {Map<string, string>} zone -> ZONE.*
 */
export function classifyZones({ zones, holding, enemyMass, sweptTick, gates, tick }) {
  const staleTicks = SWEEP_STALE_SECONDS * TICK_RATE;
  const out = new Map();

  // Pass one. UNKNOWN is decided by ignorance and nothing else: a zone is
  // unknown when we do not hold it, have not looked at it recently, and the
  // belief says somebody could be there. Sweeping it or believing it empty
  // makes it known, and known-but-unheld ground is a buffer, which is exactly
  // what chapter 1 says a buffer is ("it may already be cleared, or it may be
  // too exposed to hold directly").
  //
  // An earlier version also demoted buffers that did not sit between safe
  // ground and an unknown. That was wrong in a way worth recording: it took
  // ground the team had just cleared and called it unknown again, which is the
  // one thing a sweep is supposed to buy.
  for (const z of zones) {
    const held = holding(z);
    const fresh = tick - (sweptTick(z) ?? -Infinity) < staleTicks;
    const empty = enemyMass(z) <= OCCUPIED_FLOOR;

    if (held) out.set(z, ZONE.RISK); // provisional; pass two promotes
    else if (fresh || empty) out.set(z, ZONE.BUFFER);
    else out.set(z, ZONE.UNKNOWN);
  }

  // Pass two: a held zone is SAFE when everything gating it is itself risk or
  // safe, which is the doctrine's "an enemy cannot reach you here without first
  // taking another zone". Iterated to a fixed point because safety propagates:
  // ground behind ground you hold is safer than ground behind ground you are
  // fighting over, and that difference is where the bomb belongs.
  for (let pass = 0; pass < zones.length; pass += 1) {
    let changed = false;
    for (const z of zones) {
      if (out.get(z) !== ZONE.RISK) continue;
      const gate = gates(z) || [];
      const shielded =
        gate.length > 0 &&
        gate.every((g) => {
          const c = out.get(g);
          return c === ZONE.RISK || c === ZONE.SAFE;
        });
      if (shielded) {
        out.set(z, ZONE.SAFE);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return out;
}

/**
 * Is the bomb somewhere the doctrine allows it to be?
 *
 * Chapter 1 is unambiguous: the bomb stays in a green zone until the path is
 * secure, because a carrier who dies in a risk zone loses the package rather
 * than dropping it somewhere recoverable. This is the cheapest high-value rule
 * in the document, it is checkable every tick, and every FPS bot ever shipped
 * gets it wrong.
 */
export function bombIsSafe(classification, zone) {
  return classification.get(zone) === ZONE.SAFE;
}

/**
 * The layer conversion the T side is trying to perform: unknown to risk to
 * safe. Returns the zones that are the current frontier, which is where a
 * three-man take should be pointed.
 */
export function frontier(classification, gates) {
  const out = [];
  for (const [z, c] of classification) {
    if (c !== ZONE.UNKNOWN) continue;
    const gate = gates(z) || [];
    // A frontier unknown is one we could actually walk into: something we hold
    // borders it. An unknown behind three other unknowns is not a next step.
    if (gate.some((g) => classification.get(g) === ZONE.SAFE || classification.get(g) === ZONE.RISK)) {
      out.push(z);
    }
  }
  return out;
}

/** Counts per class, which is the zone ledger (SIM-PLAN 20.4). */
export function zoneLedger(classification) {
  const led = { safe: 0, risk: 0, buffer: 0, unknown: 0 };
  for (const c of classification.values()) led[c] += 1;
  return led;
}

// ---------------------------------------------------------------------------
// replays/coach/angleHold.js
// Detect a clean angle hold versus a peek: the coached player is nearly still
// and the enemy is moving into them at the first moment of the fight.
//
// Several rules tell people to "hold the angle" or punish them for being on an
// angle unprepared. Those misfire when the player was already holding and got
// peeked. This module is the shared test those rules consult.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { speedAt } from '../duels/duelFeatures.js';

/** Holder is still at or below this, world units per second. */
const HOLD_MAX_SPEED = 70;
/** Peeker must be moving at least this fast. */
const PEEK_MIN_SPEED = 90;
/**
 * Component of peeker velocity toward the holder, world units per second.
 * Positive means they are closing the gap into the engagement.
 */
const PEEK_TOWARD_MIN = 50;
/** Ticks used to estimate the peeker's velocity vector. */
const VEL_LOOKBACK_TICKS = 8;

/**
 * Rules that second-guess a hold or tell someone to hold.
 * Suppressed when the coached player is the one holding against a peek.
 */
export const ANGLE_HOLD_SUPPRESS_RULES = new Set([
  'not-ready',
  'lost-ahead',
  'unaware-openness',
  'negative-ev',
  'untraded-won-round',
  'solo-even',
  'advantage-lost',
  'underdog-won-round',
  'afterplant-duel',
  'free-opening',
  'pushed-advantage'
]);

/**
 * True when `holderSlot` is holding still and `enemySlot` has velocity into
 * them at `engageTick` (the first moment of the fight).
 *
 * @param {object} track
 * @param {number} tickRate
 * @param {number} holderSlot
 * @param {number} enemySlot
 * @param {number} engageTick
 * @returns {boolean}
 */
export function isHoldingVsPeekIn(track, tickRate, holderSlot, enemySlot, engageTick) {
  if (!track || holderSlot == null || enemySlot == null) return false;
  if (!Number.isFinite(engageTick)) return false;

  const tick = Math.max(track.firstTick + VEL_LOOKBACK_TICKS, Math.round(engageTick));
  const holderSpeed = speedAt(track, holderSlot, tick, tickRate);
  if (!(holderSpeed <= HOLD_MAX_SPEED)) return false;

  const enemySpeed = speedAt(track, enemySlot, tick, tickRate);
  if (!(enemySpeed >= PEEK_MIN_SPEED)) return false;

  const prev = Math.max(track.firstTick, tick - VEL_LOOKBACK_TICKS);
  const dt = (tick - prev) / (tickRate || 64);
  if (!(dt > 0)) return false;

  const holder = track.sample(holderSlot, tick, {});
  const enemyNow = track.sample(enemySlot, tick, {});
  const enemyBefore = track.sample(enemySlot, prev, {});
  if (!holder?.alive || !enemyNow?.alive || !enemyBefore?.alive) return false;
  if (![holder.x, holder.y, enemyNow.x, enemyNow.y, enemyBefore.x, enemyBefore.y].every(Number.isFinite)) {
    return false;
  }

  const vx = (enemyNow.x - enemyBefore.x) / dt;
  const vy = (enemyNow.y - enemyBefore.y) / dt;
  const dx = holder.x - enemyNow.x;
  const dy = holder.y - enemyNow.y;
  const dist = Math.hypot(dx, dy);
  // Already on top of each other with the enemy moving: treat as a peek contact.
  if (dist < 32) return true;
  const toward = (vx * dx + vy * dy) / dist;
  return toward >= PEEK_TOWARD_MIN;
}

/**
 * Drop hold/readiness advice when the coached player was holding an angle and
 * the enemy walked/peeked into the first moment of the engagement.
 *
 * @param {Array<{playerId:string,tick:number,rule:string}>} flags
 * @param {object} args
 * @returns {Array}
 */
export function dropAngleHoldAdvice(flags, { tickRate, byId, kills = [], track }) {
  if (!flags?.length || !track || !byId) return flags || [];

  const window = Math.max(1, Math.round(tickRate || 64));
  const deaths = (kills || []).filter((k) => k.victim && k.attacker);

  return flags.filter((f) => {
    if (!f || !ANGLE_HOLD_SUPPRESS_RULES.has(f.rule)) return true;

    // Death notes: coached player is the victim.
    const asVictim = deaths.find(
      (k) => k.victim === f.playerId && Math.abs(k.tick - f.tick) <= window
    );
    if (asVictim) {
      const holderSlot = byId.get(asVictim.victim)?.slot;
      const enemySlot = byId.get(asVictim.attacker)?.slot;
      const engage = Math.max(track.firstTick, asVictim.tick - 1);
      if (isHoldingVsPeekIn(track, tickRate, holderSlot, enemySlot, engage)) return false;
      return true;
    }

    // Won-fight notes (e.g. negative-ev survived): coached player is the killer.
    const asKiller = deaths.find(
      (k) => k.attacker === f.playerId && Math.abs(k.tick - f.tick) <= window
    );
    if (asKiller) {
      const holderSlot = byId.get(asKiller.attacker)?.slot;
      const enemySlot = byId.get(asKiller.victim)?.slot;
      const engage = Math.max(track.firstTick, asKiller.tick - 1);
      if (isHoldingVsPeekIn(track, tickRate, holderSlot, enemySlot, engage)) return false;
    }
    return true;
  });
}

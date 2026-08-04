// ---------------------------------------------------------------------------
// replays/duels/buckets.js
// The scenarios a duel gets filed under, so the exam can be read per situation
// rather than as a single number.
//
// This exists to solve a specific failure. A model can post a respectable
// overall loss while being completely broken in one kind of fight, because that
// kind of fight is a small slice of the corpus and its contribution is drowned.
// Told only "your loss is 0.58", the next generation has no way to know whether
// to touch the crosshair curve or the outnumbered coupling, so it perturbs
// everything and mostly damages the parts that were working.
//
// Filing every duel under the scenarios it belongs to, and reporting predicted
// against actual win rate inside each, turns that single number into a
// diagnosis. paramSpec then maps each parameter to the buckets it can move, and
// the optimizer steps a parameter in proportion to how wrong its own buckets
// are.
//
// A duel is filed under several buckets at once. They are overlapping views of
// the same fight, not a partition.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { weaponTier } from '../shared/weaponTable.js';

/** Every bucket id, in report order. */
export const BUCKET_IDS = [
  '1v1_close',
  '1v1_mid',
  '1v1_long',
  '1v2',
  '1v3plus',
  'tier_even',
  'tier_up',
  'tier_down',
  'flashed',
  'moving',
  'reloading',
  'spread_tight',
  'spread_mid',
  'spread_wide'
];

/** Range boundaries, world units. */
const CLOSE_MAX = 600;
const MID_MAX = 1500;

/** Speed above which a player counts as moving, world units per second. */
const MOVING_SPEED = 60;

/** Crossfire width boundaries, degrees. */
const SPREAD_TIGHT_MAX = 25;
const SPREAD_WIDE_MIN = 60;

/**
 * Which scenarios this duel belongs to, from A's point of view.
 *
 * Weapon tier buckets are relative to A: `tier_up` means A holds the better
 * gun. Since every duel is scored once with a definite A, and A is whichever
 * player the sample was recorded for, the three tier buckets stay balanced
 * across the corpus.
 *
 * @param {object} ctx  from duelSnapshot's duelContext
 * @returns {string[]}
 */
export function bucketize(ctx) {
  const { pair, threatsOnA, spreadA } = ctx;
  const out = [];

  // How outnumbered A is. Enemies watching A, plus the opponent themselves.
  const against = threatsOnA.length + 1;
  if (against >= 3) out.push('1v3plus');
  else if (against === 2) out.push('1v2');
  else if (pair.dist <= CLOSE_MAX) out.push('1v1_close');
  else if (pair.dist <= MID_MAX) out.push('1v1_mid');
  else out.push('1v1_long');

  const ta = weaponTier(pair.a.weapon);
  const tb = weaponTier(pair.b.weapon);
  if (ta > tb) out.push('tier_up');
  else if (ta < tb) out.push('tier_down');
  else out.push('tier_even');

  if (pair.a.flash > 0 || pair.b.flash > 0) out.push('flashed');
  if (pair.a.speed > MOVING_SPEED || pair.b.speed > MOVING_SPEED) out.push('moving');
  if (pair.a.reloading || pair.b.reloading) out.push('reloading');

  if (against >= 2) {
    if (spreadA <= SPREAD_TIGHT_MAX) out.push('spread_tight');
    else if (spreadA >= SPREAD_WIDE_MIN) out.push('spread_wide');
    else out.push('spread_mid');
  }

  return out;
}

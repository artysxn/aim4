// ---------------------------------------------------------------------------
// shared/sim/scan.js
// Holding an angle is checking several, in turn.
//
// The bug this exists to remove, in the operator's words: "if they take a
// position they stand perfectly still and hold only one spot instead of
// checking left or right". That was literal. A hold compiled to
//
//   intent.combat = { posture: 'holdAngle', preAim: p.yaw }
//
// with one anchor for the option's whole twenty-second timeout, so a bot
// arrived, faced one way, and never moved its crosshair again.
//
// A human holding site does not do that. They pick the two or three ways
// somebody can arrive, and they cycle: long dwell on the dangerous one, short
// glances at the others, more attention to whichever the round has given them
// a reason to fear. That is what this builds.
//
// Two halves, split so the map knowledge stays where the map is:
//
//   watchAngles()  the arrivals worth checking from a spot. Needs the graph,
//                  the visibility catalogue and the belief, so the caller
//                  computes it once when the hold begins.
//   scanPick()     which of them to be looking at on THIS tick. Pure, and a
//                  function of tick alone, so a hold is reproducible and the
//                  determinism gate stays true.
// ---------------------------------------------------------------------------

/** How many arrivals a bot will keep in its rotation. Three is a human's lot. */
export const WATCH_MAX = 3;

/** Ticks on the primary before glancing away. Roughly 1.4s at 64 tick. */
export const DWELL_PRIMARY = 90;

/** Ticks spent on a secondary glance. Roughly 0.55s: a check, not a stare. */
export const DWELL_GLANCE = 35;

/** How far from the spot an arrival can be and still be worth watching. */
export const WATCH_RADIUS = 2200;

/**
 * The ways somebody can arrive at this spot, worth checking, most dangerous
 * first.
 *
 * "Can see the spot" is the test rather than "is near it": an angle that
 * cannot see you is not an angle you hold, however close. Ranked by believed
 * threat first and proximity second, because the point of a rotation is to
 * spend most of it on the door the enemy is actually behind.
 *
 * @param {object} args
 * @param {object} args.graph
 * @param {object} args.angles         visibility catalogue
 * @param {{x: number, y: number, level: string}} args.spot
 * @param {(anchorId: string) => number} [args.threatOf]  believed mass, 0..1
 * @param {string[]} [args.exclude]    anchors never to watch (own post)
 * @param {number} [args.k]
 * @returns {string[]} anchor ids
 */
export function watchAngles({ graph, angles, spot, threatOf = null, exclude = [], k = WATCH_MAX }) {
  if (!graph || !angles || !spot) return [];
  const skip = new Set(exclude);
  const out = [];
  for (const [id, a] of graph.anchors) {
    if (skip.has(id)) continue;
    if (a.level !== spot.level) continue;
    const d = Math.hypot(a.world.x - spot.x, a.world.y - spot.y);
    // Arm's reach is where the bot IS, not an approach to it.
    if (d < 200 || d > WATCH_RADIUS) continue;
    if (!angles.canSee(spot.x, spot.y, a.world.x, a.world.y, spot.level)) continue;
    const threat = threatOf ? threatOf(id) || 0 : 0;
    out.push({ id, d, threat });
  }
  // Threat dominates; distance breaks ties so the order is stable rather than
  // whatever the anchor map happened to iterate in.
  out.sort((p, q) => q.threat - p.threat || p.d - q.d || (p.id < q.id ? -1 : 1));
  return out.slice(0, Math.max(1, k)).map((o) => o.id);
}

/**
 * Which watched angle the crosshair is on at this tick.
 *
 * A cycle is one long dwell on the primary and one short glance at each of the
 * others, so a two-angle hold spends about 72% of its time on the dangerous
 * side and still checks the other twice a cycle. Derived from `tick` and
 * nothing else: no state, no clock, no rng, so two runs of the same seed hold
 * the same angles at the same moments (9.8 gate 5).
 *
 * @param {string[]} watch    from watchAngles, most dangerous first
 * @param {number} tick
 * @param {object} [opts]
 * @param {number} [opts.offset]  per-bot phase, so five holders on one site do
 *                                not all glance away in the same instant
 * @returns {string|null}
 */
export function scanPick(watch, tick, { offset = 0, primary = DWELL_PRIMARY, glance = DWELL_GLANCE } = {}) {
  if (!Array.isArray(watch) || !watch.length) return null;
  if (watch.length === 1) return watch[0];
  const others = watch.length - 1;
  const cycle = primary + glance * others;
  if (cycle <= 0) return watch[0];
  const t = (((tick + offset) % cycle) + cycle) % cycle;
  if (t < primary) return watch[0];
  const i = Math.floor((t - primary) / glance);
  return watch[Math.min(watch.length - 1, 1 + i)];
}

/**
 * A stable per-bot phase offset.
 *
 * Five bots holding the same site with the same cycle would sweep in lockstep,
 * which looks like a chorus line and, worse, leaves every angle unwatched at
 * the same moment. Spreading them by slot removes both.
 */
export function scanOffset(slot, cycleTicks = DWELL_PRIMARY + DWELL_GLANCE * 2) {
  return Math.round((cycleTicks / 5) * (Number(slot) || 0));
}

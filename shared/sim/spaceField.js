// ---------------------------------------------------------------------------
// shared/sim/spaceField.js
// Space, not the ball.
//
// SIM-PLAN 6.14. FIFA 17's Active Intelligence System is the most transferable
// idea in the research: players stopped reasoning about the ball and started
// evaluating SPACE — where the defenders are, which ground is dangerous to
// them, and running there. Every CS bot ever shipped is ball-chasing: movement
// is a reaction to contact, sound, or an order. That is why bots cluster, why
// they all rotate at once, and why they never take the map.
//
// The field, per named anchor (the sim's working resolution — the belief, the
// options, and the catalogue all speak in anchors; the lattice version is a
// bake away when a consumer needs cells):
//
//   control(a)      P(my side occupies a uncontested at t + tau), from my
//                   living bots' travel times against the belief's mass reach.
//                   The football pitch-control model.
//   value(a)        tactical worth, supplied by the caller: site proximity,
//                   angle quality, what it cuts. Static per (map, call).
//   danger(a)       enemy influence, StarCraft style: each hypothesis projects
//                   reach = weapon range + speed x my option duration, so
//                   threat covers where they can GET, not where they stand.
//   opportunity(a)  value x control - danger. Where the free ground is.
//
// Plus the routing seam: findPath already takes a per-cell cost functor, so
// the three CS route types (fastest, safest, retreat) are three functors over
// this field, exactly as nav_pathfind.h did it in 2003.
// ---------------------------------------------------------------------------

/** Sharpness of the arrival race, per second of edge. `[calibrate]` */
const RACE_STEEPNESS = 0.9;

/** How far ahead control is projected, seconds. The plan's tau. */
export const CONTROL_HORIZON_SECONDS = 4;

/**
 * The field, computed at the tactical cadence (4 Hz) and shared by the team.
 *
 * @param {object} args
 * @param {string[]} args.anchors  the vocabulary to evaluate
 * @param {(anchorId:string) => number} args.myReachSeconds
 *        fastest living teammate's travel time to the anchor
 * @param {(anchorId:string) => number} args.enemyReachSeconds
 *        belief-weighted enemy arrival: nearest hypothesis mass counts,
 *        Infinity when the belief has nobody near
 * @param {(anchorId:string) => number} args.value      0..1 tactical worth
 * @param {(anchorId:string) => number} [args.dangerMass]
 *        belief mass that can fight ON the anchor within the horizon
 *        (massAt over the projection radius); defaults to 0
 * @returns {Map<string, {control:number, value:number, danger:number, opportunity:number}>}
 */
export function computeSpaceField({
  anchors,
  myReachSeconds,
  enemyReachSeconds,
  value,
  dangerMass = () => 0
}) {
  const field = new Map();
  for (const a of anchors) {
    const mine = myReachSeconds(a);
    const theirs = enemyReachSeconds(a);

    // The race: control is a logistic over the arrival edge. Unreachable for
    // me = no control; unreachable for them = full control; both = nothing.
    let control;
    if (!Number.isFinite(mine)) control = 0;
    else if (!Number.isFinite(theirs)) control = 1;
    else control = 1 / (1 + Math.exp(-RACE_STEEPNESS * (theirs - mine)));

    const v = value(a);
    const danger = Math.max(0, Math.min(1, dangerMass(a)));
    field.set(a, {
      control,
      value: v,
      danger,
      opportunity: v * control - danger
    });
  }
  return field;
}

/**
 * The best free ground: where an off-ball run goes. This is the target
 * supplier for `take_space`, `run_in_behind`, and `lurk` (6.14's football
 * vocabulary) — the arbiter turns the top entries into candidate options and
 * foresight prices them like anything else.
 *
 * @param {Map<string, object>} field  from computeSpaceField
 * @param {(anchorId:string) => boolean} [eligible]  e.g. exclude my own site
 * @param {number} [limit]
 * @returns {Array<{anchor:string, opportunity:number}>} best first
 */
export function bestSpace(field, eligible = () => true, limit = 3) {
  const out = [];
  for (const [anchor, f] of field) {
    if (!eligible(anchor)) continue;
    out.push({ anchor, opportunity: f.opportunity });
  }
  out.sort((a, b) => b.opportunity - a.opportunity);
  return out.slice(0, limit);
}

/**
 * The three route functors of 6.14, for findPath's cost seam. `dangerAt` maps
 * a cell to this-moment danger (typically the belief's threatAt through the
 * catalogue, plus the decayed per-match death memory, 4.2).
 *
 *   fastest   pure distance — the functor is null and A* is untouched
 *   safest    distance inflated by danger, so quiet ground wins long detours
 *   retreat   safest, plus everything nearer the threat than I am is poison
 *
 * @param {'fastest'|'safest'|'retreat'} kind
 * @param {object} [hooks]
 * @param {(cx:number, cy:number) => number} [hooks.dangerAt]  0..1
 * @param {(cx:number, cy:number) => number} [hooks.towardThreat]
 *        positive when the cell moves toward the threat, for retreat
 * @param {number} [hooks.dangerWeight]  how many extra units a fully dangerous
 *        cell costs, relative to its length. `[calibrate]`
 * @returns {((cx:number, cy:number) => number)|null}
 */
export function routeCost(kind, hooks = {}) {
  const { dangerAt = () => 0, towardThreat = () => 0, dangerWeight = 6 } = hooks;
  switch (kind) {
    case 'fastest':
      return null;
    case 'safest':
      return (cx, cy) => 1 + dangerWeight * dangerAt(cx, cy);
    case 'retreat':
      return (cx, cy) => {
        const toward = towardThreat(cx, cy);
        return 1 + dangerWeight * dangerAt(cx, cy) + (toward > 0 ? 8 * toward : 0);
      };
    default:
      throw new Error(`spaceField: unknown route kind ${kind}`);
  }
}

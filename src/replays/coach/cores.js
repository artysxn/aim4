// ---------------------------------------------------------------------------
// replays/coach/cores.js
// Who is playing together, and who is out on their own.
//
// A core is the largest group holding at least 60% of a side's living players
// inside one zone. Anyone alive and outside that group, while a core exists, is
// a lurker. With no core there are no lurkers — five players spread evenly
// across the map are not four lurkers and a loner, they are a spread.
//
// The zone grows with the group: two players standing together occupy a much
// smaller area than four, and demanding four fit inside a two-player radius
// would never find a core at all.
// ---------------------------------------------------------------------------

/** Radius in world units for a group of n, measured from the group centroid. */
export function coreRadius(n) {
  return 150 + 100 * Math.max(2, n);
}

/** Below this share of the living side, a group is not a core. */
const CORE_SHARE = 0.6;

/**
 * Players on different floors are not together however close the radar puts
 * them — the ramp on Nuke reads as ten units on a map that has no third
 * dimension.
 */
const SAME_LEVEL_Z = 200;

const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function centroid(group) {
  const c = { x: 0, y: 0, z: 0 };
  for (const p of group) {
    c.x += p.x;
    c.y += p.y;
    c.z += p.z || 0;
  }
  c.x /= group.length;
  c.y /= group.length;
  c.z /= group.length;
  return c;
}

/** Does every member sit inside the radius its own size allows? */
function holdsTogether(group) {
  const r = coreRadius(group.length);
  const c = centroid(group);
  return group.every((p) => dist2d(p, c) <= r && Math.abs((p.z || 0) - c.z) <= SAME_LEVEL_Z);
}

/**
 * The core and the lurkers for one side.
 *
 * @param {Array<{id: string, x: number, y: number, z?: number}>} alive
 * @returns {{core: string[], lurkers: string[], size: number, centroid: object|null}}
 */
export function findCore(alive) {
  const none = { core: [], lurkers: [], size: 0, centroid: null };
  const list = (alive || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (list.length < 2) return none;

  const minSize = Math.max(2, Math.ceil(list.length * CORE_SHARE));

  // Largest group first: a core of four is a better description of the round
  // than the core of three hiding inside it.
  for (let k = list.length; k >= minSize; k--) {
    const r = coreRadius(k);
    for (const seed of list) {
      const near = list
        .filter((p) => dist2d(p, seed) <= r * 2 && Math.abs((p.z || 0) - (seed.z || 0)) <= SAME_LEVEL_Z)
        .sort((a, b) => dist2d(a, seed) - dist2d(b, seed));
      if (near.length < k) continue;
      const group = near.slice(0, k);
      if (!holdsTogether(group)) continue;
      const ids = new Set(group.map((p) => p.id));
      return {
        core: group.map((p) => p.id),
        lurkers: list.filter((p) => !ids.has(p.id)).map((p) => p.id),
        size: k,
        centroid: centroid(group)
      };
    }
  }
  return none;
}

/**
 * How far the nearest living teammate is. Used to tell a solo fight from a
 * traded one: a duel taken with nobody inside this range is a duel nobody can
 * follow up.
 */
export function nearestTeammate(player, mates) {
  let best = Infinity;
  for (const m of mates || []) {
    if (!m || m.id === player.id) continue;
    best = Math.min(best, dist2d(player, m));
  }
  return best;
}

/** A player is alone when no teammate is inside a two-player core radius. */
export const ALONE_DISTANCE = coreRadius(2);

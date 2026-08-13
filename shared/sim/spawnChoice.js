// ---------------------------------------------------------------------------
// shared/sim/spawnChoice.js
// Which spawn each bot starts on.
//
// This is a decision, not a roll. SIM-PLAN requirement 8: bots freely choose
// among available spawns, and 4.12 explains why it matters more than it looks.
// "The CT AWPer peeks banana at 1:45" is only learnable if the policy can take
// the spawn that makes the peek geometrically possible; leave spawn to chance
// and half the timing game becomes luck the network cannot influence.
//
// Two callers, one function:
//
//   the Playstyle AI picks a permutation as an action (7.4)
//   mimicry picks the permutation that best matches a recorded round's
//   freeze-end positions (10.3), which is what lets a copied round start on
//   the geometry the recording used
//
// Both are the same assignment problem, so both go through `assignSpawns`, and
// the only difference is the cost matrix.
// ---------------------------------------------------------------------------

/**
 * Hungarian algorithm (Jonker-Volgenant style augmenting path, O(n^3)).
 *
 * Small and exact rather than greedy, because greedy assignment on five bodies
 * against a dozen spawns is visibly wrong often enough to matter: it hands the
 * best spawn to whichever bot is first in the list and leaves the AWPer at the
 * back of spawn. The same routine is wanted by the clear partition (19.5) and
 * by the space field's cell assignment (14.37), so it lives here as a general
 * function rather than inside a spawn-specific helper.
 *
 * @param {number[][]} cost  rows x cols, rows <= cols, finite
 * @returns {number[]} for each row, the column it was assigned
 */
export function hungarian(cost) {
  const n = cost.length;
  if (!n) return [];
  const m = cost[0].length;
  if (m < n) throw new Error('hungarian: needs at least as many columns as rows');

  const INF = Infinity;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1).fill(-1);
  const way = new Int32Array(m + 1).fill(-1);

  for (let i = 0; i < n; i += 1) {
    p[m] = i;
    let j0 = m;
    const minv = new Float64Array(m + 1).fill(INF);
    const used = new Uint8Array(m + 1);

    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;

      for (let j = 0; j < m; j += 1) {
        if (used[j]) continue;
        const cur = cost[i0][j] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j = 0; j <= m; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== -1);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== m);
  }

  const out = new Array(n).fill(-1);
  for (let j = 0; j < m; j += 1) if (p[j] >= 0 && p[j] < n) out[p[j]] = j;
  return out;
}

/**
 * Assign bots to spawn points.
 *
 * @param {Array<object>} bots     one entry per body, in slot order
 * @param {Array<{id: string, x: number, y: number, z?: number}>} pool
 *   the side's available spawns
 * @param {(bot: object, spawn: object) => number} costFn
 *   lower is better; must be finite
 * @returns {Array<{bot: object, spawn: object}>}
 */
export function assignSpawns(bots, pool, costFn) {
  if (bots.length > pool.length) {
    // Refusing beats duplicating. Two bodies on one point is a round that
    // starts with a collision, and 14.3 already says a thin pool is a reason
    // not to run the map rather than a reason to improvise.
    throw new Error(`spawnChoice: ${bots.length} bots, only ${pool.length} spawns`);
  }
  const cost = bots.map((bot) => pool.map((spawn) => costFn(bot, spawn)));
  const picks = hungarian(cost);
  return bots.map((bot, i) => ({ bot, spawn: pool[picks[i]] }));
}

/**
 * Cost that reproduces a recorded round's starting geometry: squared distance
 * from each bot's tracked player's freeze-end position (10.3).
 */
export function mimicCost(targets) {
  return (bot, spawn) => {
    const t = targets[bot.slot];
    if (!t) return 0;
    return (t.x - spawn.x) ** 2 + (t.y - spawn.y) ** 2;
  };
}

/**
 * Cost that pulls each role toward the anchor it wants to reach first, by
 * geodesic distance rather than straight line, because on these maps the two
 * disagree exactly where it matters (SIM-PLAN 7.1).
 *
 * @param {import('./navGraph.js').NavGraph} graph
 * @param {Record<string, string>} roleAnchors  role -> anchor id
 * @param {(from: object, to: object) => number} distance  geodesic units
 */
export function roleCost(graph, roleAnchors, distance) {
  return (bot, spawn) => {
    const anchorId = roleAnchors[bot.role];
    if (!anchorId) return 0;
    const anchor = graph.anchor(anchorId);
    if (!anchor) return 0;
    const from = graph.nearestWalkable(spawn.x, spawn.y);
    if (!from) return 1e9;
    const d = distance(from, anchor);
    return Number.isFinite(d) ? d : 1e9;
  };
}

/**
 * A deterministic random permutation, for the baseline and for rounds where
 * nothing has an opinion. Uses the engine PRNG so it is reproducible.
 *
 * @param {Array<object>} bots
 * @param {Array<object>} pool
 * @param {import('./rng.js').Rng} rng
 */
export function randomSpawns(bots, pool, rng) {
  if (bots.length > pool.length) {
    throw new Error(`spawnChoice: ${bots.length} bots, only ${pool.length} spawns`);
  }
  const shuffled = rng.shuffle([...pool]);
  return bots.map((bot, i) => ({ bot, spawn: shuffled[i] }));
}

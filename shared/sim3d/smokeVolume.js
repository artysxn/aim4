// ---------------------------------------------------------------------------
// shared/sim3d/smokeVolume.js
// A CS2 smoke as what it actually is: a volume that floods the space it is in,
// not a ball drawn at a point.
//
// This is the thing that makes CS2 smokes behave differently from CS:GO's, and
// it is a mechanic before it is a look. One thrown in the open makes a squat
// dome. The same one thrown in a corridor runs down the corridor and does not
// bulge through the walls. One thrown at the top of stairs pours down them. All
// of that falls out of a single rule — a fixed VOLUME of smoke, flood-filled
// through whatever free space it can reach — and none of it falls out of a
// sphere with a radius.
//
// The cells are on a lattice so the fill is deterministic: the same throw makes
// the same cloud every time, which matters for a replay and for a lineup tool.
//
// Headless, like the rest of shared/sim3d: the renderer turns cells into
// something to look at (src/cs3d/nadeEffects.js), and the only thing this needs
// from the world is whether a point is inside geometry.
// ---------------------------------------------------------------------------

/** [docs] CS2's nominal smoke radius, units. */
export const SMOKE_RADIUS = 144;

/**
 * Lattice pitch. Small enough that a 144-unit cloud is nine cells across and
 * can round a corner convincingly; large enough that the fill is a few hundred
 * cells rather than a few thousand.
 */
export const SMOKE_CELL = 32;

/**
 * [guessed] How much flatter than wide a free-floating cloud sits.
 *
 * A CS2 smoke in the open is a squat dome, not a ball. The fill measures
 * distance with the vertical axis stretched by this, so climbing costs more
 * budget than spreading and the cloud settles wide. It does not stop smoke
 * going up a stairwell — that is free space and the budget will spend itself
 * there when there is nowhere flatter to go.
 */
export const SMOKE_SQUAT = 1.35;

/** [guessed] How far from the pop a cell may be, as a multiple of the radius. */
const SMOKE_REACH = 2.4;

/**
 * How many cells out to look for somewhere to start when the pop itself reports
 * solid. Three is two cells further than a wall-hugging canister needs and
 * still cheap: the search is a shell walk that stops at the first hit.
 */
const SEED_SEARCH = 3;

/** [guessed] Seconds a smoke stands, from the pop. Community-measured. */
export const SMOKE_SECONDS = 18;
/** [guessed] Seconds the volume takes to fill out. */
export const SMOKE_BLOOM = 1.4;
/** [guessed] ...and to thin away at the end. */
export const SMOKE_FADE = 1.6;

/**
 * [guessed] Seconds a cell an HE blew out takes to fill back in.
 *
 * A well-placed HE opens a hole in a smoke and the smoke closes it again — the
 * one-way-out trick. The hole is real and so is the refill; the three seconds
 * is a reading of how long that gap is usable.
 */
export const SMOKE_REFILL = 3;

/**
 * [guessed] How long a blown-out cell takes to knit back once its hold runs
 * out, seconds. Short next to SMOKE_REFILL on purpose: the hole should be a
 * hole for most of its life and then close, rather than fading back the whole
 * way through.
 */
export const SMOKE_KNIT = 1.2;

/**
 * [docs] How far an HE clears smoke around itself.
 *
 * Note this is a RADIUS, not the hole you see. The renderer used to draw a
 * markedly smaller one — a card is far wider than the lattice, so a card
 * seated outside the cleared sphere still reached back into it and filled the
 * hole in. That is fixed where it belongs, in src/cs3d/smokeCards.js, by
 * clipping a surviving card so it cannot cross the boundary; raising this
 * instead was tried and is wrong, because anything past the cloud's own ~144
 * radius deletes a centred smoke outright rather than carving it.
 */
export const SMOKE_PUSH_RADIUS = 150;

/**
 * How many cells a full smoke is worth: the volume of the nominal sphere, in
 * lattice cells. The whole point is that this is conserved — a cloud squeezed
 * into a corridor is longer because it is not allowed to be as wide.
 */
export function smokeBudget(radius = SMOKE_RADIUS, cell = SMOKE_CELL) {
  return Math.max(1, Math.round(((4 / 3) * Math.PI * radius ** 3) / cell ** 3));
}

/**
 * The world, as a smoke sees it. One method, so a test can hand over a box and
 * the renderer can hand over the map's BVH.
 *
 * @typedef {{ solidAt(x: number, y: number, z: number, half: number): boolean }} SmokeWorld
 */

const NEIGHBOURS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1]
];

/**
 * Flood a smoke through the space it can reach.
 *
 * Breadth-first from the pop, cheapest cell first, so the cloud fills outward
 * evenly and stops the moment the budget runs out. Cost is squat-weighted
 * distance from the origin, which is what gives an unobstructed cloud its dome
 * and lets a constrained one run.
 *
 * @param {object} o
 * @param {{x,y,z}} o.origin   where the canister stopped, Source frame
 * @param {SmokeWorld} [o.world]
 * @param {number} [o.radius]
 * @param {number} [o.cell]
 * @returns {{ cells: {x,y,z,d,t}[], origin, cell, radius, budget, seconds, age, cleared: Map }}
 */
export function buildSmokeVolume({ origin, world = null, radius = SMOKE_RADIUS, cell = SMOKE_CELL } = {}) {
  const budget = smokeBudget(radius, cell);
  const half = cell * 0.5;
  // The pop is on the ground; the cloud's body sits above it. Starting half a
  // radius up stops the fill wasting its first ring trying to get out of the
  // floor.
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z + radius * 0.35;
  const key = (i, j, k) => `${i},${j},${k}`;
  const at = (i, j, k) => ({ x: ox + i * cell, y: oy + j * cell, z: oz + k * cell });
  const cost = (i, j, k) => Math.sqrt((i * cell) ** 2 + (j * cell) ** 2 + (k * cell * SMOKE_SQUAT) ** 2);
  const reach = radius * SMOKE_REACH;

  // Where the fill actually starts. Usually the pop, but the pop is a POINT and
  // `solidAt` asks about a box nearly a cell wide, so a canister that came to
  // rest against a wall, in a corner or under a low ceiling reports its own
  // origin solid. That used to end the fill on its first step — the seed was
  // rejected, nothing was ever queued, and the whole cloud collapsed to the
  // single fallback cell. Measured on Nuke: inside 25 units of a wall, every
  // smoke came out one cell big.
  //
  // So walk out to the nearest cell that is free and start there. Cost is still
  // measured from the original origin, so the cloud keeps its size and its
  // centre of mass only shifts by however far it had to step.
  const seed = (() => {
    if (!world) return { i: 0, j: 0, k: 0 };
    const free = (i, j, k) => {
      const p = at(i, j, k);
      return !world.solidAt(p.x, p.y, p.z, half);
    };
    if (free(0, 0, 0)) return { i: 0, j: 0, k: 0 };
    let best = null;
    for (let r = 1; r <= SEED_SEARCH; r++) {
      for (let i = -r; i <= r; i++) {
        for (let j = -r; j <= r; j++) {
          for (let k = -r; k <= r; k++) {
            // Shell only: the inside was covered by a smaller r.
            if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
            if (!free(i, j, k)) continue;
            const d = cost(i, j, k);
            if (!best || d < best.d) best = { i, j, k, d };
          }
        }
      }
      if (best) return best;
    }
    return null;
  })();

  const cells = [];
  // A simple sorted frontier: the cell counts are in the hundreds, so an array
  // kept in order beats a heap in both clarity and, at this size, speed.
  const seen = new Set();
  const frontier = [];
  if (seed) {
    seen.add(key(seed.i, seed.j, seed.k));
    frontier.push({ i: seed.i, j: seed.j, k: seed.k, d: cost(seed.i, seed.j, seed.k) });
  }
  while (frontier.length && cells.length < budget) {
    let best = 0;
    for (let n = 1; n < frontier.length; n++) if (frontier[n].d < frontier[best].d) best = n;
    const c = frontier.splice(best, 1)[0];
    const p = at(c.i, c.j, c.k);
    if (world && world.solidAt(p.x, p.y, p.z, half)) continue;
    cells.push({ x: p.x, y: p.y, z: p.z, i: c.i, j: c.j, k: c.k, d: c.d, t: 0 });
    for (const [di, dj, dk] of NEIGHBOURS) {
      const i = c.i + di;
      const j = c.j + dj;
      const k = c.k + dk;
      const kk = key(i, j, k);
      if (seen.has(kk)) continue;
      const d = cost(i, j, k);
      if (d > reach) continue;
      seen.add(kk);
      frontier.push({ i, j, k, d });
    }
  }
  // When the fill found nothing at all (a smoke that came to rest inside
  // geometry), keep one cell so there is something to draw.
  if (!cells.length) cells.push({ x: ox, y: oy, z: oz, i: 0, j: 0, k: 0, d: 0, t: 0 });

  // Each cell appears in order of cost, which is what staggers the bloom: the
  // far side of a cloud arrives a beat after the near side.
  const far = cells[cells.length - 1].d || 1;
  for (const c of cells) c.t = (c.d / far) * SMOKE_BLOOM;

  return {
    cells,
    origin: { x: ox, y: oy, z: oz },
    cell,
    radius,
    budget,
    seconds: SMOKE_SECONDS,
    age: 0,
    /** cell index → seconds left before it fills back in. */
    cleared: new Map()
  };
}

/**
 * An HE goes off in the smoke: clear a sphere of it.
 *
 * @param {object} vol
 * @param {{x,y,z}} at
 * @param {number} [radius]
 * @returns {number} how many cells were blown out
 */
export function pushSmoke(vol, at, radius = SMOKE_PUSH_RADIUS) {
  if (!vol) return 0;
  let n = 0;
  for (let idx = 0; idx < vol.cells.length; idx++) {
    const c = vol.cells[idx];
    const d = Math.hypot(c.x - at.x, c.y - at.y, c.z - at.z);
    if (d > radius) continue;
    // Everything inside the radius goes; what varies with distance is how long
    // it STAYS gone. The knit window is added on top rather than eaten out of
    // the hold, so a cell at the rim still clears completely and simply starts
    // knitting back at once — leave it out and the rim never fully opens, which
    // is how this ended up as a soft cone with a hole only at dead centre.
    const hold = SMOKE_KNIT + SMOKE_REFILL * (1 - d / radius);
    if ((vol.cleared.get(idx) || 0) < hold) vol.cleared.set(idx, hold);
    n++;
  }
  return n;
}

/**
 * Advance a smoke: age it, and knit the holes back together.
 * @returns {boolean} true while it is still standing
 */
export function stepSmokeVolume(vol, dt) {
  vol.age += dt;
  if (vol.cleared.size) {
    for (const [idx, left] of vol.cleared) {
      const next = left - dt;
      if (next <= 0) vol.cleared.delete(idx);
      else vol.cleared.set(idx, next);
    }
  }
  return vol.age < vol.seconds;
}

/**
 * How opaque a cell is right now: 0 while it has yet to bloom in or has been
 * blown out, 1 in the body of a standing cloud.
 */
export function cellOpacity(vol, idx) {
  const c = vol.cells[idx];
  if (vol.age < c.t) return 0;
  const cleared = vol.cleared.get(idx);
  if (cleared) {
    // Gone, then knitting back — and the knit is the LAST SMOKE_KNIT seconds of
    // the hold, not the whole of it. Spreading it over the full hold instead
    // made the opacity come out as exactly `distance / radius`: a soft cone
    // with a hole only at the dead centre, when what an HE does is take the
    // whole sphere out at once and let the rim close first.
    const back = 1 - Math.min(1, cleared / SMOKE_KNIT);
    if (back <= 0) return 0;
    return back * fade(vol);
  }
  const bloom = Math.min(1, (vol.age - c.t) / 0.45);
  return bloom * fade(vol);
}

function fade(vol) {
  const left = vol.seconds - vol.age;
  return left < SMOKE_FADE ? Math.max(0, left / SMOKE_FADE) : 1;
}

/** Is this point inside the standing smoke? What a sight line has to ask. */
export function smokeBlocks(vol, x, y, z) {
  const half = vol.cell * 0.6;
  for (let idx = 0; idx < vol.cells.length; idx++) {
    const c = vol.cells[idx];
    if (Math.abs(c.x - x) > half || Math.abs(c.y - y) > half || Math.abs(c.z - z) > half) continue;
    if (cellOpacity(vol, idx) > 0.35) return true;
  }
  return false;
}

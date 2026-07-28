// ---------------------------------------------------------------------------
// replays/zones/controlField.js
// Hidden accumulation field for map possession.
//
// Vision is vector — cones are exact polygons — but "held for N seconds" is a
// per-location meter, so it needs a field to land in. That field is this: flat
// typed arrays indexed `iy * cols + ix`, with no ids, no strings and no Maps.
// It is never drawn as cells; the renderer traces contours out of it.
//
// Exposure is measured in seconds. A visibility polygon is exact, so coverage
// is binary and there is no partial-cone weighting to carry around.
//
// DOM-free: `walkable` is built from a caller-supplied predicate.
// ---------------------------------------------------------------------------

import { RADAR_SIZE, calibrationFor, worldToRadar } from '../viewer/mapCalibration.js';

/** World-unit edge length of one accumulation cell. */
export const CELL_WORLD = 32;

/** Soft nearness: cells within this world radius of a player's feet. */
export const FOOT_NEAR_WORLD = 48;

/** Cell classes, matching the six paint colors. */
export const CLASS_EMPTY = 0;
export const CLASS_T = 1;
export const CLASS_CT = 2;
export const CLASS_CONTESTED = 3;

export const SIDE_NONE = 0;
export const SIDE_T = 1;
export const SIDE_CT = 2;

/**
 * @typedef {{
 *   mapCode: string, cell: number, area: number,
 *   originX: number, originY: number,
 *   cols: number, rows: number, count: number,
 *   walkable: Uint8Array, walkableCount: number, walkableArea: number
 * }} FieldGeometry
 */

/**
 * @typedef {FieldGeometry & {
 *   tExp: Float32Array, ctExp: Float32Array,
 *   tLast: Int32Array, ctLast: Int32Array,
 *   owner: Uint8Array,
 *   retreatBudget: number,
 *   gen: number
 * }} ControlField
 */

/** @type {Map<string, FieldGeometry>} */
const geometryCache = new Map();

/**
 * Build (or reuse) the cell lattice for a map.
 * @param {string} mapCode
 * @param {{ isWalkableWorld: (x:number,y:number)=>boolean } | null} los
 * @returns {FieldGeometry | null}
 */
export function getFieldGeometry(mapCode, los) {
  if (!mapCode || !los?.isWalkableWorld) return null;
  const hit = geometryCache.get(mapCode);
  if (hit) return hit;

  const cal = calibrationFor(mapCode);
  const cell = CELL_WORLD;
  const worldSpan = RADAR_SIZE * cal.scale;
  const originX = cal.posX;
  const originY = cal.posY - worldSpan;
  const cols = Math.ceil(worldSpan / cell);
  const rows = cols;
  const count = cols * rows;

  const walkable = new Uint8Array(count);
  const scratch = {};
  let walkableCount = 0;
  for (let iy = 0; iy < rows; iy++) {
    const cy = originY + (iy + 0.5) * cell;
    const row = iy * cols;
    for (let ix = 0; ix < cols; ix++) {
      const cx = originX + (ix + 0.5) * cell;
      worldToRadar(mapCode, cx, cy, scratch);
      if (scratch.x < 0 || scratch.y < 0 || scratch.x >= RADAR_SIZE || scratch.y >= RADAR_SIZE) {
        continue;
      }
      if (!los.isWalkableWorld(cx, cy)) continue;
      walkable[row + ix] = 1;
      walkableCount++;
    }
  }
  if (!walkableCount) return null;

  /** @type {FieldGeometry} */
  const geom = {
    mapCode,
    cell,
    area: cell * cell,
    originX,
    originY,
    cols,
    rows,
    count,
    walkable,
    walkableCount,
    walkableArea: walkableCount * cell * cell
  };
  geometryCache.set(mapCode, geom);
  return geom;
}

/** Fresh mutable state over a shared lattice. */
export function createControlField(geom) {
  if (!geom) return null;
  return {
    ...geom,
    tExp: new Float32Array(geom.count),
    ctExp: new Float32Array(geom.count),
    tLast: new Int32Array(geom.count).fill(-1),
    ctLast: new Int32Array(geom.count).fill(-1),
    owner: new Uint8Array(geom.count),
    retreatBudget: 0,
    gen: 0
  };
}

export function resetControlField(field) {
  if (!field) return;
  field.tExp.fill(0);
  field.ctExp.fill(0);
  field.tLast.fill(-1);
  field.ctLast.fill(-1);
  field.owner.fill(SIDE_NONE);
  field.retreatBudget = 0;
  field.gen++;
}

/** @returns {number} cell index, or -1 outside the lattice */
export function cellIndexAt(geom, x, y) {
  if (!geom) return -1;
  const ix = Math.floor((x - geom.originX) / geom.cell);
  const iy = Math.floor((y - geom.originY) / geom.cell);
  if (ix < 0 || iy < 0 || ix >= geom.cols || iy >= geom.rows) return -1;
  return iy * geom.cols + ix;
}

/**
 * Walkable cells within `radius` of a world point, plus the cell underfoot.
 * Writes indices into `out` so foot presence allocates nothing per tick.
 * @returns {number} how many indices were written
 */
export function cellsNearInto(geom, x, y, radius, out) {
  if (!geom) return 0;
  const r = Math.max(0, radius);
  const { cell, originX, originY, cols, rows, walkable } = geom;
  const ix0 = Math.max(0, Math.floor((x - r - originX) / cell));
  const ix1 = Math.min(cols - 1, Math.floor((x + r - originX) / cell));
  const iy0 = Math.max(0, Math.floor((y - r - originY) / cell));
  const iy1 = Math.min(rows - 1, Math.floor((y + r - originY) / cell));
  const r2 = r * r;
  const under = cellIndexAt(geom, x, y);
  const cap = out.length;
  let n = 0;

  for (let iy = iy0; iy <= iy1; iy++) {
    const cy = originY + (iy + 0.5) * cell;
    const dy = cy - y;
    const row = iy * cols;
    for (let ix = ix0; ix <= ix1; ix++) {
      const idx = row + ix;
      if (!walkable[idx]) continue;
      if (idx === under) continue;
      const cx = originX + (ix + 0.5) * cell;
      const dx = cx - x;
      if (dx * dx + dy * dy > r2) continue;
      if (n < cap) out[n++] = idx;
    }
  }
  // Underfoot always counts, even standing on a cell the radar calls solid.
  if (under >= 0 && n < cap) out[n++] = under;
  return n;
}

let xsScratch = new Float64Array(256);

/**
 * Add `dt` seconds of exposure to every walkable cell inside a cone polygon.
 *
 * Scanline fill in cell space: one crossing pass per row, spans filled with an
 * integer inner loop. Cost is proportional to covered cells, not to range.
 *
 * @param {ControlField} field
 * @param {Float32Array} ring  world-space polygon [x,y,...]
 * @param {1|2} side
 * @param {number} dt  seconds
 * @param {number} tick
 */
export function rasterizeConeInto(field, ring, side, dt, tick) {
  if (!field || !ring) return;
  const n = ring.length / 2;
  if (n < 3 || dt <= 0) return;
  const exp = side === SIDE_T ? field.tExp : field.ctExp;
  const last = side === SIDE_T ? field.tLast : field.ctLast;
  const { cell, originX, originY, cols, rows, walkable } = field;
  const inv = 1 / cell;

  if (xsScratch.length < n) xsScratch = new Float64Array(n * 2);
  const xs = xsScratch;

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const cy = (ring[i * 2 + 1] - originY) * inv;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }
  const iy0 = Math.max(0, Math.floor(minY - 0.5));
  const iy1 = Math.min(rows - 1, Math.ceil(maxY - 0.5));

  for (let iy = iy0; iy <= iy1; iy++) {
    const yc = iy + 0.5;
    let nx = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yj = (ring[j * 2 + 1] - originY) * inv;
      const yi = (ring[i * 2 + 1] - originY) * inv;
      if (yj > yc === yi > yc) continue;
      const xj = (ring[j * 2] - originX) * inv;
      const xi = (ring[i * 2] - originX) * inv;
      xs[nx++] = xj + ((yc - yj) / (yi - yj)) * (xi - xj);
    }
    if (nx < 2) continue;
    // Insertion sort: a scanline crosses a cone two to a handful of times, and
    // `subarray().sort()` would allocate a view per row — 600k of them over a
    // full round.
    for (let a = 1; a < nx; a++) {
      const v = xs[a];
      let b = a - 1;
      while (b >= 0 && xs[b] > v) {
        xs[b + 1] = xs[b];
        b--;
      }
      xs[b + 1] = v;
    }

    const row = iy * cols;
    for (let k = 0; k + 1 < nx; k += 2) {
      let xa = Math.ceil(xs[k] - 0.5);
      let xb = Math.floor(xs[k + 1] - 0.5);
      if (xa < 0) xa = 0;
      if (xb > cols - 1) xb = cols - 1;
      for (let ix = xa; ix <= xb; ix++) {
        const idx = row + ix;
        if (!walkable[idx]) continue;
        exp[idx] += dt;
        last[idx] = tick;
      }
    }
  }
}

/**
 * Add exposure to a disc — a player's own footprint.
 *
 * Standing somewhere holds it, whichever way you happen to be looking, so feet
 * claim into the same field as vision. That also makes the field the single
 * owner of soft control, which is what lets it decay uniformly.
 *
 * @param {ControlField} field
 * @param {number} x @param {number} y @param {number} radius
 * @param {1|2} side @param {number} dt @param {number} tick
 */
export function stampDiscInto(field, x, y, radius, side, dt, tick) {
  if (!field || dt <= 0) return;
  const exp = side === SIDE_T ? field.tExp : field.ctExp;
  const last = side === SIDE_T ? field.tLast : field.ctLast;
  const { cell, originX, originY, cols, rows, walkable } = field;
  const ix0 = Math.max(0, Math.floor((x - radius - originX) / cell));
  const ix1 = Math.min(cols - 1, Math.floor((x + radius - originX) / cell));
  const iy0 = Math.max(0, Math.floor((y - radius - originY) / cell));
  const iy1 = Math.min(rows - 1, Math.floor((y + radius - originY) / cell));
  const r2 = radius * radius;
  const under = cellIndexAt(field, x, y);

  for (let iy = iy0; iy <= iy1; iy++) {
    const cy = originY + (iy + 0.5) * cell;
    const dy = cy - y;
    const row = iy * cols;
    for (let ix = ix0; ix <= ix1; ix++) {
      const idx = row + ix;
      if (!walkable[idx] && idx !== under) continue;
      const cx = originX + (ix + 0.5) * cell;
      const dx = cx - x;
      if (dx * dx + dy * dy > r2 && idx !== under) continue;
      exp[idx] += dt;
      last[idx] = tick;
    }
  }
}

/** Distance stand-in for "no living player can reach this". */
const DIST_FAR = 0x3fffffff;

/** Reusable working state for the region pass. */
let decayScratch = null;

function decayScratchFor(count) {
  if (!decayScratch || decayScratch.label.length !== count) {
    decayScratch = {
      label: new Int32Array(count),
      stack: new Int32Array(count),
      queue: new Int32Array(count),
      prevOwner: new Uint8Array(count),
      tDist: new Int32Array(count),
      ctDist: new Int32Array(count),
      cleared: new Uint8Array(count),
      /** @type {number[]} */
      candidates: [],
      /** @type {number[]} */
      frontier: []
    };
  }
  return decayScratch;
}

/**
 * Geodesic distance, in cells, from the nearest living player of one side.
 *
 * Walked over the map rather than measured straight-line, so a spot just
 * through a wall is correctly far away.
 */
function buildPlayerDistance(field, anchors, side, dist, queue) {
  const { cols, rows, walkable } = field;
  dist.fill(DIST_FAR);
  let head = 0;
  let tail = 0;

  for (const a of anchors || []) {
    if (a.side !== side) continue;
    const i = cellIndexAt(field, a.x, a.y);
    if (i < 0 || dist[i] === 0) continue;
    dist[i] = 0;
    queue[tail++] = i;
  }

  while (head < tail) {
    const i = queue[head++];
    const d = dist[i] + 1;
    const ix = i % cols;
    const iy = (i / cols) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = iy + dy;
      if (ny < 0 || ny >= rows) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = ix + dx;
        if (nx < 0 || nx >= cols) continue;
        const j = ny * cols + nx;
        if (!walkable[j] || dist[j] <= d) continue;
        dist[j] = d;
        queue[tail++] = j;
      }
    }
  }
}

/** Walkable neighbor with owner === SIDE_NONE (outer neutral border only). */
function touchesNeutral(field, i, owners) {
  const { cols, rows, walkable } = field;
  const ix = i % cols;
  const iy = (i / cols) | 0;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = iy + dy;
    if (ny < 0 || ny >= rows) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = ix + dx;
      if (nx < 0 || nx >= cols) continue;
      const j = ny * cols + nx;
      if (walkable[j] && owners[j] === SIDE_NONE) return true;
    }
  }
  return false;
}

function cellDist(own, i, tDist, ctDist) {
  return own === SIDE_T ? tDist[i] : ctDist[i];
}

function cellLast(own, i, tLast, ctLast) {
  return own === SIDE_T ? tLast[i] : ctLast[i];
}

function compareFarOldest(a, b, owner, tDist, ctDist, tLast, ctLast) {
  const ownA = owner[a];
  const ownB = owner[b];
  const distA = cellDist(ownA, a, tDist, ctDist);
  const distB = cellDist(ownB, b, tDist, ctDist);
  if (distB !== distA) return distB - distA;
  return cellLast(ownA, a, tLast, ctLast) - cellLast(ownB, b, tLast, ctLast);
}

/**
 * Retire soft control nobody has held for a while.
 *
 * Ownership that is never revisited would otherwise sit on the map untouched
 * for the rest of the round. Three things decide what goes, in this order:
 *
 *   1. How long ago that cell was last checked. Per cell, not per region — a
 *      player at one end of a long corridor must not keep the far end alive.
 *   2. How far it is from the nearest living player of its own side, walked
 *      over the map. Near ground gets a little grace past the minimum; far
 *      ground goes first.
 *   3. Peel from the outer neutral tip as a wavefront: start at the furthest
 *      ready edge, then spend the cell budget advancing inward — never jumping
 *      to a disconnected near-side edge or eating out of interior holes.
 *
 * Cells land on neutral — never contested, since nobody is fighting over them.
 *
 * @param {ControlField} field
 * @param {number} tick
 * @param {number} dt  seconds since the previous pass
 * @param {{ holdTicks: number, graceTicks: number, graceRangeCells: number, retreatCellsPerSecond: number }} rules
 * @param {Array<{ x: number, y: number, side: 1|2 }>} anchors  living players
 */
export function decaySoftControl(field, tick, dt, rules, anchors = null) {
  const { holdTicks, graceTicks, graceRangeCells, retreatCellsPerSecond } = rules;
  const { owner, tLast, ctLast, walkable, cols, rows, count } = field;
  const s = decayScratchFor(count);
  const { queue, prevOwner, tDist, ctDist, cleared, candidates, frontier } = s;

  buildPlayerDistance(field, anchors, SIDE_T, tDist, queue);
  buildPlayerDistance(field, anchors, SIDE_CT, ctDist, queue);

  const isReady = (i, own) => {
    const last = cellLast(own, i, tLast, ctLast);
    if (last < 0) return true;
    const d = cellDist(own, i, tDist, ctDist);
    const near = d >= graceRangeCells ? 0 : 1 - d / graceRangeCells;
    return tick - last >= holdTicks + graceTicks * near;
  };

  prevOwner.set(owner);
  cleared.fill(0);
  candidates.length = 0;
  for (let i = 0; i < count; i++) {
    if (!walkable[i]) continue;
    const own = prevOwner[i];
    if (own === SIDE_NONE) continue;
    if (!isReady(i, own)) continue;
    if (!touchesNeutral(field, i, prevOwner)) continue;
    candidates.push(i);
  }
  if (!candidates.length) return;

  candidates.sort((a, b) => compareFarOldest(a, b, prevOwner, tDist, ctDist, tLast, ctLast));

  field.retreatBudget = (field.retreatBudget || 0) + retreatCellsPerSecond * dt;
  let budget = Math.floor(field.retreatBudget);
  if (budget < 1) return;
  field.retreatBudget -= budget;
  if (budget > count) budget = count;

  // Seed the wave at the furthest ready outer-edge cell(s) (same max distance).
  const tipDist = cellDist(prevOwner[candidates[0]], candidates[0], tDist, ctDist);
  frontier.length = 0;
  for (const i of candidates) {
    if (cellDist(prevOwner[i], i, tDist, ctDist) < tipDist) break;
    frontier.push(i);
  }

  let removed = 0;
  while (frontier.length && removed < budget) {
    frontier.sort((a, b) => compareFarOldest(a, b, prevOwner, tDist, ctDist, tLast, ctLast));
    const i = frontier.shift();
    if (owner[i] === SIDE_NONE || cleared[i]) continue;
    if (!touchesNeutral(field, i, owner)) continue;

    owner[i] = SIDE_NONE;
    cleared[i] = 1;
    removed++;

    const ix = i % cols;
    const iy = (i / cols) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = iy + dy;
      if (ny < 0 || ny >= rows) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = ix + dx;
        if (nx < 0 || nx >= cols) continue;
        const j = ny * cols + nx;
        if (!walkable[j] || cleared[j] || owner[j] === SIDE_NONE) continue;
        const own = owner[j];
        if (!isReady(j, own)) continue;
        if (!touchesNeutral(field, j, owner)) continue;
        frontier.push(j);
      }
    }
  }

  if (removed > 0) field.gen++;
}

/**
 * Hand a side any neutral pocket that only it surrounds.
 *
 * Cones leave gaps behind cover, so claimed ground comes out speckled with
 * little holes that read as damage rather than as terrain. A pocket enclosed by
 * one side alone was never really neutral.
 *
 * @param {ControlField} field
 * @param {number} maxCells  largest pocket to absorb
 * @returns {number} cells absorbed
 */
export function fillNeutralPockets(field, maxCells) {
  const { owner, walkable, cols, rows, count } = field;
  const s = decayScratchFor(count);
  const { label, stack } = s;
  label.fill(-1);
  let absorbed = 0;

  for (let start = 0; start < count; start++) {
    if (label[start] >= 0 || !walkable[start] || owner[start] !== SIDE_NONE) continue;

    let top = 0;
    let n = 0;
    let touching = SIDE_NONE;
    let mixed = false;
    stack[top++] = start;
    label[start] = start;
    const members = [];

    while (top > 0) {
      const i = stack[--top];
      members.push(i);
      n++;
      if (n > maxCells) mixed = true;
      const ix = i % cols;
      const iy = (i / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = iy + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = ix + dx;
          if (nx < 0 || nx >= cols) continue;
          const j = ny * cols + nx;
          if (!walkable[j]) continue;
          if (owner[j] !== SIDE_NONE) {
            if (touching === SIDE_NONE) touching = owner[j];
            else if (touching !== owner[j]) mixed = true;
            continue;
          }
          if (label[j] >= 0) continue;
          label[j] = start;
          stack[top++] = j;
        }
      }
    }

    if (mixed || touching === SIDE_NONE || n > maxCells) continue;
    for (const i of members) owner[i] = touching;
    absorbed += members.length;
  }

  if (absorbed > 0) field.gen++;
  return absorbed;
}

/**
 * Decay stale meters and promote ownership. One pass over the lattice.
 *
 * Mirrors the old per-hit rules: the owner makes no progress against itself,
 * and an owner actively looking at a cell wipes the enemy's contest meter, so
 * a watched angle cannot be taken slowly.
 *
 * @param {ControlField} field
 * @param {number} tick
 * @param {object} rules
 * @param {number} rules.decayTicks
 * @param {number} rules.neutralSeconds
 * @param {number} rules.flipSeconds
 */
export function resolveOwners(field, tick, { decayTicks, neutralSeconds, flipSeconds }) {
  const { tExp, ctExp, tLast, ctLast, owner, walkable, count } = field;
  let changed = false;

  for (let i = 0; i < count; i++) {
    if (!walkable[i]) continue;
    if (tExp[i] > 0 && tick - tLast[i] > decayTicks) tExp[i] = 0;
    if (ctExp[i] > 0 && tick - ctLast[i] > decayTicks) ctExp[i] = 0;

    const own = owner[i];
    if (own === SIDE_T) {
      if (tLast[i] === tick) ctExp[i] = 0;
      tExp[i] = 0;
      if (ctExp[i] >= flipSeconds) {
        owner[i] = SIDE_CT;
        ctExp[i] = 0;
        changed = true;
      }
    } else if (own === SIDE_CT) {
      if (ctLast[i] === tick) tExp[i] = 0;
      ctExp[i] = 0;
      if (tExp[i] >= flipSeconds) {
        owner[i] = SIDE_T;
        tExp[i] = 0;
        changed = true;
      }
    } else {
      const t = tExp[i];
      const ct = ctExp[i];
      if (t >= neutralSeconds && t >= ct) {
        owner[i] = SIDE_T;
        tExp[i] = 0;
        ctExp[i] = 0;
        changed = true;
      } else if (ct >= neutralSeconds) {
        owner[i] = SIDE_CT;
        tExp[i] = 0;
        ctExp[i] = 0;
        changed = true;
      }
    }
  }

  // Bumped every resolve, not only on flips: the contour cache keys off this
  // and contested depends on the meters, which move every stride.
  field.gen++;
  return changed;
}

/**
 * Visual class of a cell from claim state alone (callers layer feet on top).
 *
 * Contested means both sides are actually pulling on it. One-sided progress
 * across neutral ground is just someone taking space, and the old rule that
 * painted it red only looked sane because a single cone fired every 2.5s —
 * with all ten firing it would wash the map.
 */
export function classifyCell(field, i) {
  const tBusy = field.tExp[i] > 0;
  const ctBusy = field.ctExp[i] > 0;
  const own = field.owner[i];
  if (tBusy && ctBusy) return CLASS_CONTESTED;
  if (own === SIDE_T && ctBusy) return CLASS_CONTESTED;
  if (own === SIDE_CT && tBusy) return CLASS_CONTESTED;
  if (own === SIDE_T) return CLASS_T;
  if (own === SIDE_CT) return CLASS_CT;
  return CLASS_EMPTY;
}


/** Copy the mutable state for seek keyframes. */
export function snapshotField(field, tick) {
  return {
    tick,
    tExp: field.tExp.slice(),
    ctExp: field.ctExp.slice(),
    tLast: field.tLast.slice(),
    ctLast: field.ctLast.slice(),
    owner: field.owner.slice(),
    retreatBudget: field.retreatBudget
  };
}

export function restoreField(field, snap) {
  field.tExp.set(snap.tExp);
  field.ctExp.set(snap.ctExp);
  field.tLast.set(snap.tLast);
  field.ctLast.set(snap.ctLast);
  field.owner.set(snap.owner);
  field.retreatBudget = snap.retreatBudget;
  field.gen++;
}

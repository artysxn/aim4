// ---------------------------------------------------------------------------
// replays/zones/visibilityPolygon.js
// Exact FOV visibility polygon by angular sweep.
//
// Replaces point-sampling the wedge interior. Candidate walls come from the
// bucket index, every wall endpoint inside the FOV contributes a sweep angle,
// and a pair of rays straddling each angle picks up whatever is nearest.
// Output is a closed world-space ring: viewer at [0], then hits in angular
// order.
//
// Cost scales with visible corners, not with range — a long open sightline is
// cheap precisely because it has nothing to hit.
//
// DOM-free on purpose so it can be exercised from Node.
// ---------------------------------------------------------------------------

import { queryBounds } from './mapSegments.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** Angular bins across the FOV; a ray only tests the walls in its own bin. */
const BIN_COUNT = 64;
/** Straddle offset either side of each corner, radians. */
const ANGLE_EPS = 1e-4;
/**
 * Sweep angles closer than this collapse into one. Must stay above
 * 2 * ANGLE_EPS or straddle rays from neighbouring corners would interleave
 * and the ring would stop being angularly sorted.
 */
const ANGLE_MERGE = 3e-4;
/** Max spacing along an unobstructed far edge so it reads as an arc. */
const ARC_STEP = 4 * DEG;
/** Sides used when a smoke cloud is fed in as an occluder. */
const SMOKE_SIDES = 16;
/** Hard ceiling on candidate walls per cast. */
const MAX_CANDIDATES = 8192;

const scratchSegs = new Float32Array(MAX_CANDIDATES * 4);
const liveSeg = new Int32Array(MAX_CANDIDATES);
const liveBin0 = new Int32Array(MAX_CANDIDATES);
const liveBin1 = new Int32Array(MAX_CANDIDATES);
const binStart = new Int32Array(BIN_COUNT + 1);
const binCursor = new Int32Array(BIN_COUNT);
/**
 * Grows on demand. A wall close to the viewer spans many bins, so the total is
 * not bounded by the candidate count — and an undersized buffer would drop
 * segments silently (typed arrays ignore out-of-range writes), which shows up
 * as sight leaking through a wall.
 */
let binItems = new Int32Array(MAX_CANDIDATES * 4);
const angles = new Float64Array(MAX_CANDIDATES * 2 + 8);
/** (angle, distance) pairs in sweep order. */
const hits = new Float64Array((MAX_CANDIDATES * 4 + 32) * 2);

let queryStamp = 0;

/** Wrap to [-PI, PI). */
function wrapPi(a) {
  let v = (a + Math.PI) % TAU;
  if (v < 0) v += TAU;
  return v - Math.PI;
}

const boundsScratch = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

/**
 * World AABB of a wedge: origin, both edge tips, and any cardinal direction the
 * span sweeps past — that is where the arc bulges out beyond the chord.
 */
function wedgeBounds(ox, oy, center, half, maxDist, out) {
  let minX = ox;
  let maxX = ox;
  let minY = oy;
  let maxY = oy;
  const consider = (a) => {
    const x = ox + Math.cos(a) * maxDist;
    const y = oy + Math.sin(a) * maxDist;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  consider(center - half);
  consider(center + half);
  for (let k = 0; k < 4; k++) {
    const card = k * (Math.PI / 2);
    if (Math.abs(wrapPi(card - center)) <= half) consider(card);
  }
  out.minX = minX;
  out.maxX = maxX;
  out.minY = minY;
  out.maxY = maxY;
  return out;
}

/**
 * Nearest hit along a ray, testing only the walls binned at this angle.
 * @returns {number} distance, or `maxDist` when nothing blocks
 */
function castRay(ox, oy, dx, dy, maxDist, bin) {
  let best = maxDist;
  const end = binStart[bin + 1];
  for (let k = binStart[bin]; k < end; k++) {
    const o = binItems[k] * 4;
    const px = scratchSegs[o];
    const py = scratchSegs[o + 1];
    const ex = scratchSegs[o + 2] - px;
    const ey = scratchSegs[o + 3] - py;
    const denom = dx * ey - dy * ex;
    if (denom > -1e-12 && denom < 1e-12) continue;
    const wx = px - ox;
    const wy = py - oy;
    const t = (wx * ey - wy * ex) / denom;
    if (t <= 1e-6 || t >= best) continue;
    const s = (wx * dy - wy * dx) / denom;
    if (s < 0 || s > 1) continue;
    best = t;
  }
  return best;
}

/**
 * Visibility polygon for one viewer's FOV cone.
 *
 * @param {object} args
 * @param {number} args.ox @param {number} args.oy   viewer world position
 * @param {number} args.yawDeg                        view angle, degrees
 * @param {number} args.halfFovDeg                    half-angle of the cone
 * @param {number} args.maxDist                       world-unit range cap
 * @param {Array<object|null>} args.sources           SegmentIndex list to query
 * @param {Array<{x:number,y:number}>} [args.smokes]  clouds, as extra occluders
 * @param {number} [args.smokeRadius]
 * @returns {Float32Array} ring [x,y,...] starting at the viewer
 */
export function visibilityCone({
  ox,
  oy,
  yawDeg,
  halfFovDeg,
  maxDist,
  sources,
  smokes = null,
  smokeRadius = 0
}) {
  const center = yawDeg * DEG;
  const half = halfFovDeg * DEG;

  // ---- gather candidate walls -------------------------------------------
  const b = wedgeBounds(ox, oy, center, half, maxDist, boundsScratch);
  queryStamp++;
  let nSegs = 0;
  for (const src of sources || []) {
    if (!src) continue;
    nSegs = queryBounds(src, b.minX, b.minY, b.maxX, b.maxY, scratchSegs, nSegs, queryStamp);
  }

  // Smokes are ordinary occluders, so nothing downstream special-cases them.
  if (smokes?.length && smokeRadius > 0) {
    const reach = maxDist + smokeRadius;
    for (const s of smokes) {
      const sdx = s.x - ox;
      const sdy = s.y - oy;
      if (sdx * sdx + sdy * sdy > reach * reach) continue;
      if (nSegs + SMOKE_SIDES > MAX_CANDIDATES) break;
      let prevX = s.x + smokeRadius;
      let prevY = s.y;
      for (let i = 1; i <= SMOKE_SIDES; i++) {
        const a = (i / SMOKE_SIDES) * TAU;
        const nx = s.x + Math.cos(a) * smokeRadius;
        const ny = s.y + Math.sin(a) * smokeRadius;
        const o = nSegs * 4;
        scratchSegs[o] = prevX;
        scratchSegs[o + 1] = prevY;
        scratchSegs[o + 2] = nx;
        scratchSegs[o + 3] = ny;
        nSegs++;
        prevX = nx;
        prevY = ny;
      }
    }
  }

  // ---- keep what the cone can see, bin it, collect sweep angles ----------
  binStart.fill(0);
  const binScale = BIN_COUNT / (half * 2);
  let nLive = 0;
  let nAngles = 0;
  angles[nAngles++] = -half;
  angles[nAngles++] = half;

  for (let s = 0; s < nSegs; s++) {
    const o = s * 4;
    const r0 = wrapPi(Math.atan2(scratchSegs[o + 1] - oy, scratchSegs[o] - ox) - center);
    const r1 = wrapPi(Math.atan2(scratchSegs[o + 3] - oy, scratchSegs[o + 2] - ox) - center);
    let lo;
    let hi;
    if (Math.abs(r1 - r0) > Math.PI) {
      // Spans the viewer's back, which only happens when the viewer sits
      // almost on the segment's own line. Widen to the whole FOV rather than
      // reason about the split arc; such rays miss on the t > 0 test anyway.
      lo = -half;
      hi = half;
    } else {
      lo = r0 < r1 ? r0 : r1;
      hi = r0 < r1 ? r1 : r0;
      if (hi < -half || lo > half) continue;
      if (lo < -half) lo = -half;
      if (hi > half) hi = half;
    }

    let i0 = ((lo + half) * binScale) | 0;
    let i1 = ((hi + half) * binScale) | 0;
    if (i0 < 0) i0 = 0;
    if (i1 > BIN_COUNT - 1) i1 = BIN_COUNT - 1;
    liveSeg[nLive] = s;
    liveBin0[nLive] = i0;
    liveBin1[nLive] = i1;
    nLive++;
    for (let i = i0; i <= i1; i++) binStart[i + 1]++;

    if (r0 > -half && r0 < half) angles[nAngles++] = r0;
    if (r1 > -half && r1 < half) angles[nAngles++] = r1;
  }

  for (let i = 0; i < BIN_COUNT; i++) binStart[i + 1] += binStart[i];
  if (binStart[BIN_COUNT] > binItems.length) {
    binItems = new Int32Array(binStart[BIN_COUNT] * 2);
  }
  binCursor.set(binStart.subarray(0, BIN_COUNT));
  for (let k = 0; k < nLive; k++) {
    const s = liveSeg[k];
    const i1 = liveBin1[k];
    for (let i = liveBin0[k]; i <= i1; i++) binItems[binCursor[i]++] = s;
  }

  // ---- sweep -------------------------------------------------------------
  const sweep = angles.subarray(0, nAngles);
  sweep.sort();

  let nHits = 0;
  let prevAngle = -Infinity;
  const emit = (r) => {
    const a = center + r;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let bin = ((r + half) * binScale) | 0;
    if (bin < 0) bin = 0;
    if (bin > BIN_COUNT - 1) bin = BIN_COUNT - 1;
    const d = castRay(ox, oy, dx, dy, maxDist, bin);
    hits[nHits * 2] = r;
    hits[nHits * 2 + 1] = d;
    nHits++;
  };

  for (let i = 0; i < nAngles; i++) {
    const r = sweep[i];
    if (r - prevAngle < ANGLE_MERGE) continue;
    prevAngle = r;
    const lo = r - ANGLE_EPS < -half ? -half : r - ANGLE_EPS;
    const hi = r + ANGLE_EPS > half ? half : r + ANGLE_EPS;
    emit(lo);
    if (hi > lo) emit(hi);
  }

  // ---- ring, with the open far edge rounded out --------------------------
  const farLimit = maxDist - 1e-3;
  let ringLen = 1 + nHits;
  for (let i = 1; i < nHits; i++) {
    if (hits[(i - 1) * 2 + 1] < farLimit || hits[i * 2 + 1] < farLimit) continue;
    const gap = hits[i * 2] - hits[(i - 1) * 2];
    if (gap > ARC_STEP) ringLen += Math.ceil(gap / ARC_STEP) - 1;
  }

  const ring = new Float32Array(ringLen * 2);
  ring[0] = ox;
  ring[1] = oy;
  let w = 1;
  const put = (r, d) => {
    const a = center + r;
    ring[w * 2] = ox + Math.cos(a) * d;
    ring[w * 2 + 1] = oy + Math.sin(a) * d;
    w++;
  };

  for (let i = 0; i < nHits; i++) {
    const r = hits[i * 2];
    const d = hits[i * 2 + 1];
    if (i > 0) {
      const pr = hits[(i - 1) * 2];
      const pd = hits[(i - 1) * 2 + 1];
      if (pd >= farLimit && d >= farLimit) {
        const gap = r - pr;
        const steps = Math.ceil(gap / ARC_STEP);
        for (let k = 1; k < steps; k++) put(pr + (gap * k) / steps, maxDist);
      }
    }
    put(r, d);
  }

  return w * 2 === ring.length ? ring : ring.subarray(0, w * 2);
}

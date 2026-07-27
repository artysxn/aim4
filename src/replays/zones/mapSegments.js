// ---------------------------------------------------------------------------
// replays/zones/mapSegments.js
// Wall segments for the visibility sweep.
//
// The radar PNG is the only map geometry there is, so occluders come from the
// same bitmasks the old point-sampling path consulted: non-walkable texels
// (void + building fill) plus the painted vision blocks. Elevated paint is a
// second set because it only blocks viewers who are not standing on it.
//
// Blocked/open boundaries on a bitmask are axis-aligned, so edges are read off
// directly and collinear runs merged. No contour tracing, no simplification
// tolerance — the result is exact at texel resolution.
// ---------------------------------------------------------------------------

import { RADAR_SIZE, calibrationFor } from '../viewer/mapCalibration.js';
import { ringArea, simplifyRing, traceMaskRings } from './maskContour.js';

/** Buckets per axis for the broad-phase index. */
const BUCKET_DIM = 64;
/**
 * Blocked blobs and open pockets at or under this texel count are erased.
 * Radar antialiasing leaves stray dark texels, and each survivor would become a
 * little occluding box that costs segments on every cast forever after.
 */
const MIN_BLOB_TEXELS = 4;
/**
 * Wall simplification tolerance, in radar texels. At 4.4-7 world units per
 * texel this shifts a wall by at most ~10 units, well inside one field cell,
 * and it is what keeps diagonals from exploding into staircases.
 */
const SIMPLIFY_TEXELS = 1.5;
/** Traced outlines smaller than this (texels²) are not real geometry. */
const MIN_RING_TEXELS = 6;

/**
 * @typedef {{
 *   segs: Float32Array,
 *   count: number,
 *   originX: number,
 *   originY: number,
 *   bucketSize: number,
 *   bucketStart: Int32Array,
 *   bucketItems: Int32Array,
 *   mark: Int32Array,
 *   gen: number
 * }} SegmentIndex
 */

/** @type {Map<string, { key: string, base: SegmentIndex|null, elevated: SegmentIndex|null }>} */
const segmentCache = new Map();

/**
 * Erase connected components smaller than `minSize`.
 * One flood fill visits each texel once, so this is O(texels) for the whole
 * mask regardless of how many blobs there are.
 *
 * @param {Uint8Array} mask
 * @param {0|1} value  component value to hunt for
 * @param {number} minSize
 * @param {Int32Array} stack  scratch, length >= mask.length
 * @param {Uint8Array} seen   scratch, length >= mask.length
 */
function dropSmallComponents(mask, value, minSize, stack, seen) {
  const w = RADAR_SIZE;
  const n = mask.length;
  seen.fill(0);
  /** Members of the current blob, kept only while it might be small enough. */
  const members = new Int32Array(minSize);

  for (let start = 0; start < n; start++) {
    if (seen[start] || mask[start] !== value) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let size = 0;

    while (top > 0) {
      const i = stack[--top];
      if (size < minSize) members[size] = i;
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0) {
        const j = i - 1;
        if (!seen[j] && mask[j] === value) { seen[j] = 1; stack[top++] = j; }
      }
      if (x < w - 1) {
        const j = i + 1;
        if (!seen[j] && mask[j] === value) { seen[j] = 1; stack[top++] = j; }
      }
      if (y > 0) {
        const j = i - w;
        if (!seen[j] && mask[j] === value) { seen[j] = 1; stack[top++] = j; }
      }
      if (y < w - 1) {
        const j = i + w;
        if (!seen[j] && mask[j] === value) { seen[j] = 1; stack[top++] = j; }
      }
    }

    if (size <= minSize) {
      const flipped = value === 1 ? 0 : 1;
      for (let k = 0; k < size; k++) mask[members[k]] = flipped;
    }
  }
}

/**
 * Read blocked/open boundaries off a bitmask as world-space segments.
 *
 * Boundaries are traced into closed rings and simplified before being emitted.
 * Following the cracks literally would turn every diagonal wall into a
 * staircase of single-texel steps — on Anubis that was four thousand segments
 * averaging sixteen units each, and the sweep pays for every corner. Simplified
 * rings give back the long edges the map was actually drawn with.
 *
 * @param {Uint8Array} blocked  1 = blocks sight
 * @param {{ posX: number, posY: number, scale: number }} cal
 * @returns {number[]} flat [x0,y0,x1,y1] quads in world units
 */
function extractSegments(blocked, cal) {
  const { posX, posY, scale } = cal;
  /** @type {number[]} */
  const out = [];

  for (const ring of traceMaskRings(blocked, RADAR_SIZE, RADAR_SIZE)) {
    const simple = simplifyRing(ring, SIMPLIFY_TEXELS);
    if (!simple) continue;
    if (ringArea(simple.x, simple.y) < MIN_RING_TEXELS) continue;
    const n = simple.x.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      out.push(
        simple.x[j] * scale + posX,
        posY - simple.y[j] * scale,
        simple.x[i] * scale + posX,
        posY - simple.y[i] * scale
      );
    }
  }

  return out;
}

/**
 * Bucket segments by world-space AABB into a CSR index.
 * @param {number[]} flat
 * @param {{ posX: number, posY: number, scale: number }} cal
 * @returns {SegmentIndex | null}
 */
function buildIndex(flat, cal) {
  const count = (flat.length / 4) | 0;
  if (!count) return null;

  const worldSpan = RADAR_SIZE * cal.scale;
  const originX = cal.posX;
  const originY = cal.posY - worldSpan;
  const bucketSize = worldSpan / BUCKET_DIM;
  const nBuckets = BUCKET_DIM * BUCKET_DIM;
  const segs = Float32Array.from(flat);

  const counts = new Int32Array(nBuckets + 1);
  const bx = new Int32Array(count * 4);

  for (let s = 0; s < count; s++) {
    const o = s * 4;
    const x0 = Math.min(segs[o], segs[o + 2]);
    const x1 = Math.max(segs[o], segs[o + 2]);
    const y0 = Math.min(segs[o + 1], segs[o + 3]);
    const y1 = Math.max(segs[o + 1], segs[o + 3]);
    const i0 = clampBucket(Math.floor((x0 - originX) / bucketSize));
    const i1 = clampBucket(Math.floor((x1 - originX) / bucketSize));
    const j0 = clampBucket(Math.floor((y0 - originY) / bucketSize));
    const j1 = clampBucket(Math.floor((y1 - originY) / bucketSize));
    bx[o] = i0;
    bx[o + 1] = i1;
    bx[o + 2] = j0;
    bx[o + 3] = j1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) counts[j * BUCKET_DIM + i + 1]++;
    }
  }

  for (let b = 0; b < nBuckets; b++) counts[b + 1] += counts[b];
  const bucketItems = new Int32Array(counts[nBuckets]);
  const cursor = counts.slice(0, nBuckets);

  for (let s = 0; s < count; s++) {
    const o = s * 4;
    for (let j = bx[o + 2]; j <= bx[o + 3]; j++) {
      for (let i = bx[o]; i <= bx[o + 1]; i++) {
        bucketItems[cursor[j * BUCKET_DIM + i]++] = s;
      }
    }
  }

  return {
    segs,
    count,
    originX,
    originY,
    bucketSize,
    bucketStart: counts,
    bucketItems,
    mark: new Int32Array(count),
    gen: 0
  };
}

function clampBucket(v) {
  if (v < 0) return 0;
  if (v > BUCKET_DIM - 1) return BUCKET_DIM - 1;
  return v;
}

/**
 * Append segments overlapping a world-space AABB to a scratch coordinate list.
 *
 * Coordinates are copied rather than indices returned, so several indices (and
 * smoke polygons, which have no index at all) can be gathered into one flat
 * candidate buffer the sweep treats uniformly. Dedupe within an index uses a
 * generation stamp, so repeat calls allocate nothing.
 *
 * @param {SegmentIndex|null} index
 * @param {number} minX @param {number} minY @param {number} maxX @param {number} maxY
 * @param {Float32Array} out  receives [x0,y0,x1,y1] quads
 * @param {number} written    segments `out` already holds
 * @param {number} stamp      generation for this query
 * @returns {number} new segment count in `out`
 */
export function queryBounds(index, minX, minY, maxX, maxY, out, written, stamp) {
  if (!index) return written;
  const { segs, bucketSize, originX, originY, bucketStart, bucketItems, mark } = index;
  const i0 = clampBucket(Math.floor((minX - originX) / bucketSize));
  const i1 = clampBucket(Math.floor((maxX - originX) / bucketSize));
  const j0 = clampBucket(Math.floor((minY - originY) / bucketSize));
  const j1 = clampBucket(Math.floor((maxY - originY) / bucketSize));
  let n = written;
  const cap = (out.length / 4) | 0;

  for (let j = j0; j <= j1; j++) {
    const rowBase = j * BUCKET_DIM;
    for (let i = i0; i <= i1; i++) {
      const b = rowBase + i;
      const end = bucketStart[b + 1];
      for (let k = bucketStart[b]; k < end; k++) {
        const s = bucketItems[k];
        if (mark[s] === stamp) continue;
        mark[s] = stamp;
        if (n >= cap) continue;
        const src = s * 4;
        const dst = n * 4;
        out[dst] = segs[src];
        out[dst + 1] = segs[src + 1];
        out[dst + 2] = segs[src + 2];
        out[dst + 3] = segs[src + 3];
        n++;
      }
    }
  }
  return n;
}

/**
 * Build (or reuse) wall segments for a map.
 *
 * `base` holds walls and vision blocks — always occluding. `elevated` is kept
 * apart so a viewer standing on elevated paint can simply skip it, matching the
 * old `elevatedDisabled` behaviour.
 *
 * @param {string} mapCode
 * @param {{ mask: Uint8Array } | null} los  from getRadarLos
 * @param {{ key?: string, visionMask?: Uint8Array, elevatedMask?: Uint8Array } | null} [layers]
 * @returns {{ base: SegmentIndex|null, elevated: SegmentIndex|null } | null}
 */
export function getMapSegments(mapCode, los, layers = null) {
  if (!mapCode || !los?.mask) return null;
  const key = `${mapCode}|${los.version ?? 0}|${layers?.key || ''}`;
  const hit = segmentCache.get(mapCode);
  if (hit && hit.key === key) return hit;

  const cal = calibrationFor(mapCode);
  const n = RADAR_SIZE * RADAR_SIZE;
  const stack = new Int32Array(n);
  const seen = new Uint8Array(n);

  const walkable = los.mask;
  const visionMask = layers?.visionMask || null;
  const blocked = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    blocked[i] = walkable[i] === 0 || (visionMask && visionMask[i] !== 0) ? 1 : 0;
  }
  dropSmallComponents(blocked, 1, MIN_BLOB_TEXELS, stack, seen);
  dropSmallComponents(blocked, 0, MIN_BLOB_TEXELS, stack, seen);
  const base = buildIndex(extractSegments(blocked, cal), cal);

  let elevated = null;
  const elevatedMask = layers?.elevatedMask || null;
  if (elevatedMask) {
    let any = false;
    for (let i = 0; i < n; i++) {
      if (elevatedMask[i] !== 0) { any = true; break; }
    }
    if (any) {
      const elev = Uint8Array.from(elevatedMask);
      dropSmallComponents(elev, 1, MIN_BLOB_TEXELS, stack, seen);
      elevated = buildIndex(extractSegments(elev, cal), cal);
    }
  }

  const entry = { key, base, elevated };
  segmentCache.set(mapCode, entry);
  return entry;
}

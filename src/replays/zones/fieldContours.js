// ---------------------------------------------------------------------------
// replays/zones/fieldContours.js
// Turn the accumulation field into fillable outlines.
//
// The field is a lattice, but nothing may ever look like one. Boundaries are
// followed as cracks between cells into closed rings, simplified out of their
// staircase, then given two rounds of Chaikin. Long walls stay straight,
// corners come out rounded, and every edge stays hard — no blur anywhere.
//
// Runs once per simulation stride, not per frame; the renderer just replays the
// cached paths.
// ---------------------------------------------------------------------------

import { ringArea, simplifyRing, traceMaskRings } from './maskContour.js';

/** Corner-cutting passes. 0 keeps the raw staircase, 2 reads as rounded. */
const SMOOTH_PASSES = 2;
/** Staircase tolerance in cells, applied before smoothing. */
const SIMPLIFY_CELLS = 0.75;
/** Rings under this many cells of area are noise. */
const MIN_RING_CELLS = 2;

/** @type {WeakMap<object, Uint8Array>} */
const maskCache = new WeakMap();

function maskFor(geom) {
  let m = maskCache.get(geom);
  if (!m) {
    m = new Uint8Array(geom.count);
    maskCache.set(geom, m);
  }
  return m;
}

/** Chaikin corner-cutting on a closed ring, then out to world units. */
function smoothToWorld(ring, originX, originY, cell) {
  let sx = ring.x;
  let sy = ring.y;
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const m = sx.length;
    const nx = new Array(m * 2);
    const ny = new Array(m * 2);
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      nx[i * 2] = sx[i] * 0.75 + sx[j] * 0.25;
      ny[i * 2] = sy[i] * 0.75 + sy[j] * 0.25;
      nx[i * 2 + 1] = sx[i] * 0.25 + sx[j] * 0.75;
      ny[i * 2 + 1] = sy[i] * 0.25 + sy[j] * 0.75;
    }
    sx = nx;
    sy = ny;
  }
  const out = new Float32Array(sx.length * 2);
  for (let i = 0; i < sx.length; i++) {
    out[i * 2] = originX + sx[i] * cell;
    out[i * 2 + 1] = originY + sy[i] * cell;
  }
  return out;
}

/**
 * World-space outlines around the set cells of a mask.
 * @returns {Float32Array[]}
 */
function contoursOfMask(geom, mask) {
  const { cols, rows, originX, originY, cell } = geom;
  /** @type {Float32Array[]} */
  const out = [];
  for (const ring of traceMaskRings(mask, cols, rows)) {
    const simple = simplifyRing(ring, SIMPLIFY_CELLS);
    if (!simple) continue;
    if (ringArea(simple.x, simple.y) < MIN_RING_CELLS) continue;
    out.push(smoothToWorld(simple, originX, originY, cell));
  }
  return out;
}

/**
 * Outlines for each control class.
 *
 * `key` is whatever the caller can cheaply compute that changes when the
 * classification does — the field generation plus the soft-ownership cursor,
 * typically. Both only move once per simulation stride, so playback frames
 * between strides replay cached paths instead of re-tracing.
 *
 * @param {object} geom  FieldGeometry
 * @param {(i: number) => number} classifyAt
 * @param {number[]} classes  class values to trace
 * @param {{ key: string, rings: Map<number, Float32Array[]>|null }} cache
 * @param {string} key
 * @returns {Map<number, Float32Array[]>}
 */
export function contoursFor(geom, classifyAt, classes, cache, key) {
  if (cache && cache.key === key && cache.rings) return cache.rings;

  const mask = maskFor(geom);
  /** @type {Map<number, Float32Array[]>} */
  const out = new Map();

  for (const target of classes) {
    mask.fill(0);
    let any = false;
    for (let i = 0; i < geom.count; i++) {
      if (!geom.walkable[i]) continue;
      if (classifyAt(i) !== target) continue;
      mask[i] = 1;
      any = true;
    }
    out.set(target, any ? contoursOfMask(geom, mask) : []);
  }

  if (cache) {
    cache.key = key;
    cache.rings = out;
  }
  return out;
}

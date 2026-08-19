// ---------------------------------------------------------------------------
// src/cs3d/sunlight.js
// Is the player standing in the sun, and how hard.
//
// The map already knows. `shadowmask.webp` is the compiler's own answer to
// "does the sun reach this surface" — one channel, charted against the same
// lightmap UVs the world renders with, and materials.js gates the analytic sun
// on exactly this (`vis = texture(sun.mask, uv1).r`). So the question "am I in
// the sun" only has to become "what does the mask say about the floor I am
// standing on": trace down to it, read its uv1, sample the mask.
//
// The obvious alternative — trace from the eye TOWARD the sun against the
// collision hull — does not work, and it is worth writing down why. The hull is
// what stops a player, not what stops light. Beyond the tool brushes (`sky` is
// an invisible lid over the whole map, `playerclip` fences it), it carries
// nodraw sealing brushes that are `solid` and indistinguishable from real
// geometry: Nuke has a 1932x960 metal slab 600 units over the yard that the
// light bake ignores and the renderer never draws. Three of five spots measured
// outdoors, in plain sun, reported shade because of that one brush.
//
// Indoors the sun is not switched off but turned down (INDOOR): a gun that goes
// black in a doorway reads as a bug, and CS2's interiors carry a lot of bounced
// daylight. That number is a deliberate cheat, not a measurement.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { packFetchOk } from './packFetch.js';

/** The share of the sun a surface the mask calls shadowed still gets. */
export const INDOOR = 0.2;
/** Seconds the shade blend takes. A doorway should fade, not switch. */
export const EASE = 0.15;
/** Seconds between floor probes. The answer changes at walking pace. */
export const PROBE = 0.08;
/** How far above the feet the probe starts, and how far down it looks. */
const PROBE_UP = 40;
const PROBE_DOWN = 400;
/** Cache cell, in units. One probe answers for everything inside it. */
const CELL = 48;

const _from = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _box = new THREE.Box3();

export class SunTracker {
  constructor() {
    /** {red: Uint8Array, width, height} — the shadow mask, one byte a texel. */
    this.mask = null;
    /** [{o, box}] for the drawn world, tallest first. */
    this._batches = null;
    this._root = null;
    this._ray = new THREE.Raycaster(new THREE.Vector3(), _down.clone(), 0, PROBE_DOWN);
    this._cache = new Map();
    /** Smoothed 0..1: how much sun reaches the tracked point. */
    this.factor = 1;
    this._target = 1;
    this._acc = PROBE;
  }

  /** The mask, decoded to one byte a texel (see `loadShadowMask`). */
  setMask(mask) {
    this.mask = mask && mask.red ? mask : null;
    this._cache.clear();
  }

  /** The drawn world. Call again whenever tiles arrive: the cache is stale. */
  setWorld(root) {
    this._root = root || null;
    this._batches = null;
    this._cache.clear();
  }

  _collect() {
    const list = [];
    this._root?.traverse((o) => {
      if (!o.isMesh && !o.isBatchedMesh) return;
      if (o.name === 'phys-placeholder') return;
      if (!o.geometry?.attributes?.uv1) return; // no chart, nothing to look up
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      list.push({ o, box: o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld) });
    });
    // Tallest first, so the loop below can stop once nothing left can be nearer.
    list.sort((a, b) => b.box.max.y - a.box.max.y);
    this._batches = list;
    return list;
  }

  /**
   * The mask's value for the floor under `point`, 0..1, or null when there is
   * no floor (or no mask) to read.
   *
   * Not free — the batches carry no BVH, so this is a brute-force ray against
   * the few whose bounds span the column, a handful of milliseconds. Hence the
   * cell cache: a player runs through the same 48-unit cell for several frames,
   * and the map does not move.
   */
  floorSun(point) {
    if (!this.mask) return null;
    const key = `${Math.floor(point.x / CELL)},${Math.floor(point.y / CELL)},${Math.floor(point.z / CELL)}`;
    const hit = this._cache.get(key);
    if (hit !== undefined) return hit;
    const batches = this._batches || this._collect();
    _from.copy(point).setY(point.y + PROBE_UP);
    this._ray.set(_from, _down);
    this._ray.near = 0;
    this._ray.far = PROBE_DOWN;
    let best = null;
    for (const b of batches) {
      _box.copy(b.box);
      if (_from.x < _box.min.x || _from.x > _box.max.x || _from.z < _box.min.z || _from.z > _box.max.z) continue;
      if (_box.max.y < _from.y - PROBE_DOWN || _box.min.y > _from.y) continue;
      // Sorted tallest first: once one is found, a batch that cannot reach
      // above the hit cannot hold a nearer floor.
      if (best && _box.max.y < _from.y - best.distance) break;
      const h = this._ray.intersectObject(b.o, false)[0];
      if (h && h.uv1 && (!best || h.distance < best.distance)) best = h;
    }
    const value = best ? this.sample(best.uv1.x, best.uv1.y) : null;
    this._cache.set(key, value);
    return value;
  }

  /** The mask at a lightmap UV. `flipY` is false on the GPU's copy, so v is not flipped. */
  sample(u, v) {
    const { red, width, height } = this.mask;
    const x = Math.min(width - 1, Math.max(0, Math.round(u * width)));
    const y = Math.min(height - 1, Math.max(0, Math.round(v * height)));
    return red[y * width + x] / 255;
  }

  /**
   * Advance the blend, re-probing at most every PROBE seconds.
   * @param {number} dt
   * @param {THREE.Vector3} point  the player's FEET; in the air, the floor below
   * @returns {number} the smoothed 0..1 factor
   */
  update(dt, point) {
    this._acc += dt;
    if (point && this._acc >= PROBE) {
      this._acc = 0;
      const vis = this.floorSun(point);
      // No mask, or nothing under the player: assume open sky. Better to miss
      // a shadow than to darken a gun in the middle of a sunlit yard.
      this._target = vis === null ? 1 : INDOOR + (1 - INDOOR) * vis;
    }
    this.factor += (this._target - this.factor) * (1 - Math.exp(-Math.max(0, dt) / EASE));
    return this.factor;
  }
}

/**
 * Decode the pack's shadow mask to one byte a texel.
 *
 * The renderer uploads this same file as a texture; this is the CPU's copy,
 * red channel only, so a floor lookup is an array index. 4096² is 16 MB and
 * worth it: downscaling a CHART atlas bleeds one surface's shadow onto its
 * neighbour, and charts are not laid out with any spatial coherence.
 */
export async function loadShadowMask(base, sm, versionQuery = '') {
  if (!sm?.file) return null;
  const res = await packFetchOk(`${base}/${sm.file}${versionQuery}`, 'shadowmask');
  const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const red = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < red.length; i++, p += 4) red[i] = rgba[p];
  return { red, width, height };
}

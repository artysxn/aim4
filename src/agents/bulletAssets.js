// ---------------------------------------------------------------------------
// src/agents/bulletAssets.js
// The streak CS2 draws its tracers with, for the trainer's WebGL scene.
//
// One texture and one block of numbers out of `bullets/manifest.json`
// (`scripts/cs3d-decals.mjs` pulls both from `materials/effects/spark` and the
// weapon tracer `.vpcf` files). The map explorer's reader is
// `src/cs3d/bulletPack.js`; this is the same pack on the other renderer, and
// it takes only the tracer — the trainer draws no impact decals.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { packBase, readManifest, packVersionQuery } from './packBase.js';
import { loadWithRetry } from '../cs3d/packFetch.js';

export const BULLETS_PACK_VERSION = 1;

/**
 * The tracer texture and the particle system's own constants.
 *
 * `load()` never rejects: no pack means no streaks, not a trainer that will
 * not start.
 */
export class BulletAssets {
  constructor({ base } = {}) {
    this.base = base || `${packBase()}/bullets`;
    this.manifest = null;
    /** `materials/effects/spark`, the ribbon itself. */
    this.tracer = null;
    this.ready = false;
    this.failed = null;
    this._loading = null;
  }

  load() {
    if (this._loading) return this._loading;
    this._loading = this._load().then(
      () => (this.ready = true),
      (e) => {
        this.failed = e;
        console.warn('aim4: bullet pack unavailable, tracers stay on the built-in line —', e.message || e);
        return false;
      }
    );
    return this._loading;
  }

  async _load() {
    const { manifest, base } = await readManifest('bullets', BULLETS_PACK_VERSION, this.base.replace(/\/bullets$/, ''));
    this.manifest = manifest;
    this.base = base;
    if (!manifest.tracer?.texture) throw new Error('bullets pack has no tracer');
    const loader = new THREE.TextureLoader();
    const tex = await loadWithRetry(loader, `${base}/${manifest.tracer.texture}${packVersionQuery(manifest)}`);
    tex.colorSpace = THREE.SRGBColorSpace;
    // The streak is stretched along the bullet: it clamps across u and down v.
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tracer = tex;
  }
}

let shared = null;
export function sharedBulletAssets() {
  if (!shared) shared = new BulletAssets();
  return shared;
}
/** Test seam: install a stub pack (and clear it with no argument). */
export function setSharedBulletAssets(assets) {
  shared = assets || null;
}

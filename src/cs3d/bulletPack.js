// ---------------------------------------------------------------------------
// src/cs3d/bulletPack.js
// The pack of everything a bullet leaves behind, loaded once per page:
// CS2's impact decals (atlas + groups + sizes) and the streak its tracers are
// drawn with. Built by scripts/cs3d-decals.mjs into
// `server/data/cs3d/pack/bullets/`.
//
// Split out from its two consumers — src/cs3d/decals.js and
// src/cs3d/tracers.js — for the same reason the map pack is: they are two
// renderers over one download, and neither should be able to start a second
// fetch of the same manifest.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { SURFACES } from '../../shared/sim3d/surfaces.js';
import { assetBase } from './mapLoader.js';

export const BULLETS_PACK_VERSION = 1;

/**
 * The decal atlas, the group table, and the tracer texture.
 * `load()` is idempotent and never rejects: a missing pack means bullets stop
 * marking walls, not a page that will not start.
 */
export class BulletAssets {
  constructor({ base } = {}) {
    this.base = base || `${assetBase()}/bullets`;
    this.manifest = null;
    /** RGBA: the decal's colour, its shape in alpha. */
    this.color = null;
    /** Tangent-space normals for the same cells, so a hole has relief. */
    this.normal = null;
    /** `materials/effects/spark` — the tracer ribbon. */
    this.tracer = null;
    this.ready = false;
    this.failed = null;
    this._loading = null;
    this._picks = {};
    /** `?v=` cache-buster for everything but the manifest. See `_load`. */
    this._v = '';
  }

  load() {
    if (this._loading) return this._loading;
    this._loading = this._load().catch((e) => {
      this.failed = e;
      console.warn('cs3d: bullet pack unavailable — no decals, no tracers', e);
      return null;
    });
    return this._loading;
  }

  async _load() {
    // `manifest.json` by name: server/cs3d/routes.js caches everything else in
    // a pack for a year as immutable and this one for a minute, so the name is
    // what makes a re-pack visible at all. The atlases then carry the
    // manifest's own stamp as a query, which is how the other packs do it.
    const res = await fetch(`${this.base}/manifest.json`);
    if (!res.ok) throw new Error(`bullets manifest ${res.status}`);
    const manifest = await res.json();
    this._v = `?v=${encodeURIComponent(manifest.generated || String(manifest.version))}`;
    const [color, normal, tracer] = await Promise.all([
      loadTexture(`${this.base}/${manifest.atlas.color}${this._v}`),
      loadTexture(`${this.base}/${manifest.atlas.normal}${this._v}`),
      manifest.tracer ? loadTexture(`${this.base}/${manifest.tracer.texture}${this._v}`) : null
    ]);
    // The colour sheets are authored in sRGB. The normal sheet is DATA and must
    // not be decoded — that is the difference between relief and a blue wash.
    color.colorSpace = THREE.SRGBColorSpace;
    normal.colorSpace = THREE.NoColorSpace;
    for (const t of [color, normal]) {
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = 4;
      t.minFilter = THREE.LinearMipmapLinearFilter;
    }
    if (tracer) {
      tracer.colorSpace = THREE.SRGBColorSpace;
      // The streak is stretched along the bullet, so it repeats down v and
      // clamps across u.
      tracer.wrapS = THREE.ClampToEdgeWrapping;
      tracer.wrapT = THREE.ClampToEdgeWrapping;
    }

    this.manifest = manifest;
    this.color = color;
    this.normal = normal;
    this.tracer = tracer;
    // Group weights, prefix-summed once so a pick is a walk over a handful of
    // rows rather than a sum every shot. The weights are the game's own
    // `m_flProbability` out of decalgroups.vdata.
    for (const [group, rows] of Object.entries(manifest.groups || {})) {
      let sum = 0;
      const cum = rows.map((r) => {
        sum += r.weight || 1;
        return { cell: r.cell, upto: sum };
      });
      this._picks[group] = { cum, total: sum };
    }
    this.ready = true;
    return this;
  }

  /**
   * The decal group a surface belongs to.
   *
   * The route is surface name → the game material letter the surface table
   * carries → the group. `grazing` asks for the `_Grazing` variant and falls
   * back to the straight-on one where CS2 does not author it (only six groups
   * have a grazing set).
   */
  groupFor(surfaceName, grazing = false) {
    const m = this.manifest;
    if (!m) return null;
    const letter = SURFACES[String(surfaceName || '').toLowerCase()]?.material;
    const base = (letter !== undefined && m.surfaceGroup[letter]) || m.defaultGroup;
    if (grazing) {
      const g = base + (m.grazingSuffix || '_Grazing');
      if (this._picks[g]) return g;
    }
    return this._picks[base] ? base : m.defaultGroup;
  }

  /** One decal cell out of a group, by the game's weights. */
  pick(group, r = Math.random()) {
    const p = this._picks[group];
    if (!p || !p.cum.length) return null;
    const t = r * p.total;
    for (const row of p.cum) if (t <= row.upto) return row.cell;
    return p.cum[p.cum.length - 1].cell;
  }

  /** What the cell asks to be drawn at: size, variance, projection depth. */
  spec(cell) {
    return this.manifest?.decals?.[cell] || null;
  }

  /**
   * The cell's box in atlas UV space, inset by the pack's gutter.
   *
   * The decal is drawn smaller than its cell so the mip chain has somewhere to
   * blur into that is not the next decal (scripts/cs3d-decals.mjs GUTTER); the
   * box returned here is the part the decal actually occupies, so the caller
   * maps its 0-1 across that and never sees the margin.
   */
  cellUv(cell) {
    const { cols, rows, cell: size, gutter = 0 } = this.manifest.atlas;
    const W = cols * size;
    const H = rows * size;
    const cx = (cell % cols) * size + gutter;
    const cy = Math.floor(cell / cols) * size + gutter;
    const inner = size - gutter * 2;
    return {
      u0: cx / W,
      // Image rows run down and texture v runs up, so the cell's TOP edge in
      // pixels is its high v.
      v0: 1 - (cy + inner) / H,
      du: inner / W,
      dv: inner / H
    };
  }

  dispose() {
    this.color?.dispose();
    this.normal?.dispose();
    this.tracer?.dispose();
  }
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, reject);
  });
}

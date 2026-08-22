// ---------------------------------------------------------------------------
// src/cs3d/fpsView.js
// The flat view (V): the map as untextured greys, shaded by how much of the
// world each material covers, still lit by the live sun. A performance mode
// first and a readability mode second — with every texture and every baked
// lighting input out of the frame, what is left is the shape of the level and
// the shadows falling across it.
//
// Why area and not triangle count. The obvious proxy is wrong here: Nuke's
// `metal_pipe_001` carries 255k triangles strung around the map and covers less
// ground than the two triangles under the hangar. Shading by triangle count
// paints the pipes black and the floor white, which is backwards. So the loader
// measures real world-space area per material as tiles arrive
// (mapLoader.js surfaceArea) and this file ramps over the log of it.
//
// Log, and over the full range rather than a percentile window. The areas span
// eleven and 29 million square units on Nuke — six orders of magnitude — so a
// linear fit puts everything but the ground in one shade. An early version also
// quantized to five steps, which is what made the merely-large surfaces
// indistinguishable from the enormous ones: 65 materials came out the same
// grey. The ramp is continuous now and anchored at the true extremes, so the
// largest surface in the map is the darkest thing in it and the smallest is the
// brightest, with everything in between placed by its own size.
//
// Light. The baked inputs go — no lightmap atlas, no baked shadow mask, no sky
// probe — but the dynamic sun stays, with its shadow map, because the shadows
// are half of what makes a flat world readable. Two changes make it behave:
// the sun is forced white (a warm one tints every grey) and the sun and a fill
// ambient are rescaled so that a surface facing the sun renders its authored
// grey exactly and a surface in shadow renders a fixed fraction of it. That
// keeps the ramp meaning the same thing in light and in shade, on every map,
// whatever exposure the map itself was calibrated to.
//
// What gets dropped rather than flattened. A cut-out material without its alpha
// is a solid slab: the chainlink fences, the treelines, the railing cards and
// the glass would each become a wall. Those, the decals and the effect cards
// are not drawn at all. On Nuke that is 62 of 369 materials and 1.2% of the
// triangles, so nothing structural leaves — the fences that are real modelled
// geometry stay, because they are opaque.
//
// The performance, in the order it matters:
//   - one render pass instead of two. The normal path draws the 3D skybox,
//     clears depth, then draws the map (see main.js drawScene); with the
//     skybox gone there is nothing to keep in front of anything.
//   - no bloom composite, so no HDR target and no fullscreen pass.
//   - Lambert throughout: no texture fetches, no lightmap or shadow-mask
//     sample, no normal/ORM, no probe reflection, no tone mapping.
//   - the 3D skybox's own geometry (35 materials on Nuke) never draws.
// The shadow pass is the one cost this view keeps, deliberately.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
// The ramp itself — the greys, the drop rule and the log fit — is
// shared/cs3d/flatGreys.js, because scripts/gen-trainer-map.mjs bakes the same
// shading into the aim trainer's ported maps and the two must not drift.
import { SKY_GREY, greyRamp } from '../../shared/cs3d/flatGreys.js';

/**
 * How the one unit of light a fully-lit surface receives is split between the
 * sun and the fill. They sum to 1 on purpose: a surface facing the sun then
 * renders exactly the grey the ramp gave it, and one in shadow renders
 * AMBIENT_SHARE of it — dim enough to read as shadow, bright enough that the
 * ramp is still legible down there.
 *
 * Both are multiplied by π because three's lighting divides by it
 * (BRDF_Lambert = albedo / π), so π units of irradiance is what puts an albedo
 * of 1 on screen at 1.0.
 */
const SUN_SHARE = 0.55;
const AMBIENT_SHARE = 0.45;

export class FpsView {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.WebGPURenderer} o.renderer
   * @param {() => import('./mapLoader.js').MapPack|null} o.getPack
   * @param {() => object|null} o.getLighting
   * @param {(on: boolean) => void} [o.onChange]
   */
  constructor({ scene, renderer, getPack, getLighting, onChange }) {
    this.scene = scene;
    this.renderer = renderer;
    this.getPack = getPack;
    this.getLighting = getLighting;
    this.onChange = onChange || (() => {});
    this.on = false;
    this._sky = new THREE.Color(SKY_GREY);
    this._ambient = new THREE.AmbientLight(0xffffff, AMBIENT_SHARE * Math.PI);
    this._saved = null;
    this._receive = [];
  }

  get enabled() {
    return this.on;
  }

  toggle() {
    this.setEnabled(!this.on);
  }

  setEnabled(on) {
    if (on === this.on) return;
    const pack = this.getPack();
    // Nothing to flatten before the manifest lands, and the ramp has no
    // materials to fit itself to.
    if (on && !pack?.manifest) return;
    this.on = on;
    if (on) this._enter(pack);
    else this._exit(pack);
    this.onChange(on);
  }

  _enter(pack) {
    const lighting = this.getLighting();
    const scene = this.scene;
    const sun = lighting?.sun || null;
    this._saved = {
      background: scene.background,
      backgroundIntensity: scene.backgroundIntensity,
      environment: scene.environment,
      toneMapping: this.renderer.toneMapping,
      dome: lighting?.dome ? lighting.dome.visible : null,
      sky3d: pack.sky3d ? pack.sky3d.visible : null,
      sunColor: sun ? sun.color.clone() : null,
      sunIntensity: sun ? sun.intensity : null
    };
    pack.materials?.setFlat(this._greys(pack));
    pack.setTintsEnabled(false);

    // The sky, in three parts: the map's equirect background, the procedural
    // dome that stands in for it, and the 3D skybox's own geometry.
    scene.background = this._sky;
    scene.backgroundIntensity = 1;
    if (lighting?.dome) lighting.dome.visible = false;
    if (pack.sky3d) pack.sky3d.visible = false;

    // The probe is the sky, and the sky here is a flat grey lid; leaving the
    // real one bound would put its blue back into every surface.
    scene.environment = null;
    if (sun) {
      sun.color.set(0xffffff);
      sun.intensity = SUN_SHARE * Math.PI;
    }
    scene.add(this._ambient);

    // Lightmapped geometry is built not to receive the dynamic sun's shadows,
    // because normally its shadows are in the bake. With the bake gone, the
    // whole world has to take them from the shadow map instead — including the
    // batches that have not streamed in yet, hence the flag on the pack.
    pack.forceReceiveShadow = true;
    this._receive = [];
    for (const b of pack.batches.values()) {
      if (b.parent === pack.sky3d) continue;
      this._receive.push([b, b.receiveShadow]);
      b.receiveShadow = true;
    }
    lighting?.markShadowDirty();

    // Straight through, so a lit grey is the grey that was asked for. The
    // normal path either tone maps in the materials or bakes the map's LUT into
    // the bloom composite, and both would put the ramp somewhere else on every
    // map. Safe because the shares above cap a fully-lit surface at its albedo.
    this.renderer.toneMapping = THREE.NoToneMapping;
  }

  _exit(pack) {
    const lighting = this.getLighting();
    const s = this._saved;
    pack?.materials?.setFlat(null);
    pack?.setTintsEnabled(true);
    if (pack) pack.forceReceiveShadow = false;
    for (const [b, was] of this._receive) b.receiveShadow = was;
    this._receive = [];
    this._ambient.removeFromParent();
    if (!s) return;
    this.scene.background = s.background;
    this.scene.backgroundIntensity = s.backgroundIntensity;
    this.scene.environment = s.environment;
    this.renderer.toneMapping = s.toneMapping;
    if (lighting?.dome && s.dome !== null) lighting.dome.visible = s.dome;
    if (pack?.sky3d && s.sky3d !== null) pack.sky3d.visible = s.sky3d;
    if (lighting?.sun) {
      if (s.sunColor) lighting.sun.color.copy(s.sunColor);
      if (s.sunIntensity !== null) lighting.sun.intensity = s.sunIntensity;
    }
    lighting?.markShadowDirty();
    this._saved = null;
  }

  /**
   * A grey per material id (shared/cs3d/flatGreys.js).
   *
   * Recomputed on every toggle rather than cached: with the map still
   * streaming, the areas are still growing. A map baked for the aim trainer has
   * no such problem — it runs the same ramp once over the finished map.
   *
   * @returns {Map<number, number|null>} id → grey hex, or null for "not drawn"
   */
  _greys(pack) {
    return greyRamp(pack.manifest.materials, (id) => pack.matArea.get(id) || 0);
  }
}

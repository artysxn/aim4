// ---------------------------------------------------------------------------
// src/cs3d/bodyShadows.js
// The shadow a player casts on the map.
//
// The map takes its sun from the bake: the analytic sun times the baked
// visibility mask (materials.js), and none of it reads the live shadow map,
// because a static wall's shadow is sharper and cheaper out of the mask. That
// left nothing on the ground under a player: bodies were lit by the sun and
// cast no shadow onto the world, which is the most "pasted on" thing a scene
// can do, and the game does not do it.
//
// So the bodies get a shadow map of their own: a small depth pass from the
// sun's direction with nothing in it but the players, redrawn every frame
// because they are the only things in it and they move. The world's sun term
// multiplies by it (`sunShade` on the material library), which is what the
// game does with its dynamic cascade over the baked sun.
//
// Only the sun is occluded. The bounce light in the lightmap stays, so a
// player's shadow on a sunlit floor comes out the same colour as the shadow
// of the wall beside it.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { add, float, positionWorld, texture, uniform, vec2, vec4 } from 'three/webgpu';

/** Layer the casters sit on (in addition to the default one). */
export const BODY_SHADOW_LAYER = 7;

/** Depth texels. 2048 over EXTENT×2 units is ~1.4 units a texel. */
const SIZE = 2048;
/**
 * Half-width of the area the pass covers, centred on the camera. A body much
 * further away than this is a few pixels tall and its shadow is under one.
 */
const EXTENT = 1400;
/** Depth bias, in the shadow's [0, 1] depth range. */
const BIAS = -0.0004;

const _up = new THREE.Vector3(0, 1, 0);
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _c = new THREE.Vector3();

export class BodyShadows {
  /** @param {THREE.WebGPURenderer} renderer  already `init()`ed */
  constructor(renderer) {
    this.renderer = renderer;
    this.light = new THREE.DirectionalLight();
    const s = this.light.shadow;
    s.mapSize.set(SIZE, SIZE);
    const cam = s.camera;
    cam.left = -EXTENT;
    cam.right = EXTENT;
    cam.top = EXTENT;
    cam.bottom = -EXTENT;
    cam.near = 1;
    cam.far = 2 * EXTENT + 8000;
    // The shadow matrix is built from this projection before the first render,
    // so it has to be in the renderer's depth convention from the start.
    if (renderer?.coordinateSystem !== undefined) cam.coordinateSystem = renderer.coordinateSystem;
    cam.updateProjectionMatrix();
    cam.layers.set(BODY_SHADOW_LAYER);

    this.depth = new THREE.DepthTexture(SIZE, SIZE);
    this.depth.compareFunction = THREE.LessCompare;
    // A linear comparison sampler filters each tap over 2×2 texels for free.
    this.depth.minFilter = THREE.LinearFilter;
    this.depth.magFilter = THREE.LinearFilter;
    this.target = new THREE.RenderTarget(SIZE, SIZE);
    this.target.depthTexture = this.depth;

    this.override = new THREE.NodeMaterial();
    this.override.fragmentNode = vec4(0, 0, 0, 1);
    this.override.name = 'BodyShadowDepth';

    this.toSun = new THREE.Vector3(0, 1, 0);
    /** 0 until the first pass has been drawn: an empty map shades nothing. */
    this.ready = uniform(0);
    this._node = null;
  }

  /** @param {THREE.Vector3|{x:number,y:number,z:number}} toSun  scene direction toward the sun */
  setSun(toSun) {
    if (!toSun) return;
    this.toSun.set(toSun.x, toSun.y, toSun.z).normalize();
  }

  /**
   * TSL: 1 where the sun reaches this fragment, 0 where a body is in the way.
   * One node, shared by every material that asks.
   */
  node() {
    if (this._node) return this._node;
    const matrix = uniform(this.light.shadow.matrix);
    const sc = matrix.mul(vec4(positionWorld, 1));
    const p = sc.xyz.div(sc.w);
    // The bias matrix maps NDC z from [-1, 1]; WebGPU's is [0, 1].
    const z = p.z.add(BIAS).mul(2).sub(1);
    const at = vec2(p.x, p.y.oneMinus());
    const inside = at.x
      .greaterThanEqual(0)
      .and(at.x.lessThanEqual(1))
      .and(at.y.greaterThanEqual(0))
      .and(at.y.lessThanEqual(1))
      .and(z.lessThanEqual(1));
    const t = 1.5 / SIZE;
    const tap = (dx, dy) => texture(this.depth, at.add(vec2(dx * t, dy * t))).compare(z);
    const pcf = add(tap(0, 0), tap(-1, -1), tap(1, -1), tap(-1, 1), tap(1, 1)).mul(1 / 5);
    const lit = inside.select(pcf, float(1));
    this._node = lit.mul(this.ready).add(this.ready.oneMinus());
    return this._node;
  }

  /**
   * Redraw the pass around the camera.
   *
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {THREE.Object3D[]} casters  body groups; their meshes are put on
   *   the caster layer and taken out of the main shadow map (which is only
   *   redrawn when the camera moves, so a body in it leaves its shadow behind)
   */
  update(scene, camera, casters) {
    const renderer = this.renderer;
    if (!renderer || !scene || !camera) return;
    let any = false;
    for (const group of casters) {
      if (!group || !group.visible || !group.parent) continue;
      any = true;
      group.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.layers.isEnabled(BODY_SHADOW_LAYER)) o.layers.enable(BODY_SHADOW_LAYER);
        o.castShadow = false;
      });
    }

    // Centre on the camera, snapped to whole texels in the light's own frame
    // so the shadow edges hold still while the camera moves. The basis is the
    // one Object3D.lookAt gives the shadow camera: z toward the sun, x =
    // up × z, y = z × x.
    const dir = this.toSun;
    _r.crossVectors(_up, dir);
    if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0);
    _r.normalize();
    _u.crossVectors(dir, _r);
    const texel = (2 * EXTENT) / SIZE;
    _c.copy(camera.position);
    const a = _c.dot(_r);
    const b = _c.dot(_u);
    _c.addScaledVector(_r, Math.round(a / texel) * texel - a);
    _c.addScaledVector(_u, Math.round(b / texel) * texel - b);

    const light = this.light;
    light.target.position.copy(_c);
    light.position.copy(_c).addScaledVector(dir, EXTENT + 4000);
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
    light.shadow.updateMatrices(light);

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevClear = renderer.autoClear;
    scene.overrideMaterial = this.override;
    scene.background = null;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    if (any) renderer.render(scene, light.shadow.camera);
    else renderer.clear();
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevClear;
    scene.background = prevBackground;
    scene.overrideMaterial = prevOverride;
    this.ready.value = 1;
  }

  dispose() {
    this.target.dispose();
    this.depth.dispose();
    this.override.dispose();
  }
}

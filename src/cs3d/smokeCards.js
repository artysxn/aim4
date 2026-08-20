// ---------------------------------------------------------------------------
// src/cs3d/smokeCards.js
// A smoke as one flat-coloured billboard per filled cell of the flood fill.
//
// This replaces the raymarched volume (src/cs3d/smokeVolume3d.js and the
// wall-clip pass that fed it). The volume was the more faithful thing on paper
// and the wrong thing in practice: it never read as a shape, and because it was
// a post pass it had to reconstruct, at half resolution, occlusion the depth
// buffer already knew exactly.
//
// WHAT THIS BUYS, and it is most of why the swap is worth it:
//
//   OCCLUSION IS FREE     These are ordinary transparent meshes in the scene
//                         pass. They depth-test against the world, so a crate
//                         in front of the cloud is in front of it and geometry
//                         behind it is behind it — both directions, at full
//                         resolution, with no depth copy of the map and no
//                         upsample. The whole `smokeDepth` pass goes away, and
//                         with it 393 draws and 3.7M triangles a frame.
//
//   THE GRADE IS FREE     Drawn inside the scene pass, so the map's tone map
//                         and LUT apply to the cloud the same way they apply
//                         to a wall. No compositing hook.
//
//   NO SORTING            The one thing that killed the ORIGINAL sprite cloud
//                         was `SpriteCardBatch.sort` permuting per-particle
//                         lighting every time the camera moved, which strobed.
//                         A single colour cannot strobe: `over`-blending the
//                         same rgb any number of times, in any order, gives
//                         that rgb — only the accumulated alpha varies, and
//                         `1 - Π(1 - aᵢ)` is order-independent too. So there is
//                         no sort here at all, and there is no per-card
//                         lighting to get shuffled.
//
// The fill itself is unchanged: shared/sim3d/smokeVolume.js still floods the
// space, which is the part that was always right. This only draws it.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraProjectionMatrix,
  modelViewMatrix,
  positionGeometry,
  texture,
  uniform,
  vec4
} from 'three/webgpu';
import { sourceToScene } from '../../shared/sim3d/units.js';

/**
 * How wide a card is, in fill-cell pitches.
 *
 * Well over 1 on purpose, and this is the number that decides whether a smoke
 * blocks vision. Cards have to overlap heavily: the sprite falls to nothing at
 * its rim, so each one contributes far under its peak along any given ray, and
 * the opacity comes from the depth of the stack rather than from any single
 * card. Dialled in-frame against a wall 130 units behind the cloud — at 2.1
 * the wall was still legible through the middle.
 */
const CARD_SPAN = 3.3;

/**
 * Alpha of one card at its centre. Opaque, because a smoke is a VISION BLOCK.
 *
 * This costs nothing in softness: the value is the sprite's PEAK, at the
 * card's exact middle, and the falloff carries it to zero at the rim. The
 * cloud's silhouette is as soft as the sprite is, no matter what this says.
 */
const CARD_ALPHA = 1;

/**
 * The HE displacement, matching nadeEffects' constants of the same name.
 * Blast positions arrive in SCENE units, already converted by the caller.
 */
const HE_PULL_RADIUS = 340;
const HE_PULL_SECONDS = 6;
const HE_PULL_MAX = 0.55;

/**
 * How much of a card's radius the soft rim occupies, 0..1.
 *
 * The edge hardness knob. 1 is the old behaviour — falloff over the whole
 * disc; 0.25 confines it to the outer quarter, which is four times harder.
 */
const EDGE_WIDTH = 0.25;

/**
 * Sprite resolution. Higher than the old falloff needed: the rim is now a
 * quarter as wide, so it has a quarter as many texels to be smooth across, and
 * at 64 the edge stair-stepped on a card that fills much of the screen.
 */
const SPRITE_PX = 256;

let _sprite = null;

/**
 * The card's alpha shape: a soft disc, baked once.
 *
 * Procedural rather than the game's sheet because `fx/fx.json` is not in the
 * asset bucket (the effects pack is the one pack that never got uploaded), and
 * a cloud that only exists when an optional pack is present is worse than a
 * cloud made of a falloff anyone can read. Swapping the real sheet in later is
 * a one-line change to `spriteTexture()` — nothing else here cares what the
 * alpha came from.
 *
 * FLAT to `1 - EDGE_WIDTH`, then a smoothstep to nothing. It used to be
 * `pow(1 - r, 1.6)`, which falls away across the entire radius: every card was
 * a soft blob and the cloud had no boundary you could point at, only a haze
 * that thinned until it stopped. Confining the whole transition to the outer
 * quarter makes the silhouette about four times tighter, and the flat core is
 * what lets the interior saturate without needing yet more overlap.
 */
function spriteTexture() {
  if (_sprite) return _sprite;
  const n = SPRITE_PX;
  const data = new Uint8Array(n * n);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const r = Math.min(1, Math.hypot(dx, dy));
      // 1 inside the core, 0 at the rim, smoothstepped across EDGE_WIDTH.
      const t = Math.min(1, Math.max(0, (1 - r) / EDGE_WIDTH));
      data[y * n + x] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  _sprite = tex;
  return tex;
}

/** Bake the sprite during the load rather than on the first throw. */
export function warmSmokeCards() {
  spriteTexture();
}

/**
 * One cloud's cards.
 *
 * `setCells` is called once at the pop (and again only when an HE knits the
 * fill back), `setFrame` every frame for the grow/fade curves.
 */
export class SmokeCards {
  constructor() {
    this.tint = uniform(new THREE.Color(1, 1, 1));
    /**
     * Per-card opacity and width, live so they can be dialled against the game
     * without a reload. `cardAlpha` is a shader uniform; `spanScale` is read by
     * `setCells`, so changing it needs a re-lay (`setCells(vol)`).
     */
    this.cardAlpha = uniform(CARD_ALPHA);
    this.spanScale = 1;
    /** Global 0..1 the curves drive: birth, death and the HE's thinning. */
    this.alpha = uniform(1);
    /** 0..1 reveal front. A card shows once the fill has reached it. */
    this.grow = uniform(1);

    // A unit quad, instanced. Not InstancedMesh: that carries a per-instance
    // matrix, and a billboard wants a centre and a size, not a basis.
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = 0;
    this.geometry = geo;
    this._capacity = 0;

    const centre = attribute('iCentre', 'vec3');
    const size = attribute('iSize', 'float');
    // Where this card sits in the fill order, 0..1. The reveal compares it to
    // `grow`, so the cloud unfolds the way it flooded instead of scaling up.
    const seat = attribute('iSeat', 'float');

    const mat = new THREE.NodeMaterial();
    // Billboard in VIEW space: the card's centre goes through the model-view
    // matrix as a point, then the quad's corner is added with no rotation, so
    // every card faces the camera without a per-instance basis or a CPU pass.
    const view = modelViewMatrix.mul(vec4(centre, 1));
    const corner = positionGeometry.xy.mul(size);
    mat.vertexNode = cameraProjectionMatrix.mul(
      vec4(view.x.add(corner.x), view.y.add(corner.y), view.z, view.w)
    );

    const cover = texture(spriteTexture(), positionGeometry.xy.add(0.5)).r;
    // `step`-free reveal: a card fades in over the last fifth of its approach,
    // so the fill front is soft rather than a ring of discs popping on.
    const born = seat.mul(-1).add(this.grow).mul(5).clamp(0, 1);
    mat.colorNode = vec4(this.tint, cover.mul(this.cardAlpha).mul(born).mul(this.alpha));
    mat.transparent = true;
    // Depth TESTED so the world occludes it, depth WRITE off so cards do not
    // occlude each other — the stack has to accumulate.
    mat.depthTest = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.toneMapped = true;
    mat.fog = false;
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    // The cards' own bounds are the instances', which three cannot see.
    this.mesh.frustumCulled = false;
    // After opaque world geometry, before the HE flash.
    this.mesh.renderOrder = 6;
  }

  _ensure(n) {
    if (n <= this._capacity) return;
    const cap = Math.max(64, n * 2);
    this.geometry.setAttribute('iCentre', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
    this.geometry.setAttribute('iSize', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    this.geometry.setAttribute('iSeat', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    this._capacity = cap;
  }

  /**
   * Lay a card on every filled cell.
   *
   * @param {{cells: {x,y,z,d}[], cell: number}} vol  from shared/sim3d/smokeVolume.js
   * @param {(i: number) => number} [weightOf]  0..1 per cell; the HE knit-back
   */
  setCells(vol, weightOf = null, blasts = null, holes = null) {
    const cells = vol.cells;
    this._ensure(cells.length);
    const c = this.geometry.getAttribute('iCentre');
    const s = this.geometry.getAttribute('iSize');
    const seat = this.geometry.getAttribute('iSeat');
    const span = vol.cell * CARD_SPAN * this.spanScale;
    let maxD = 1e-6;
    for (const cell of cells) if (cell.d > maxD) maxD = cell.d;

    let n = 0;
    for (let i = 0; i < cells.length; i++) {
      const w = weightOf ? weightOf(i) : 1;
      if (!(w > 0)) continue;
      const p = sourceToScene(cells[i].x, cells[i].y, cells[i].z);
      let x = p[0];
      let y = p[1];
      let z = p[2];
      // Every live blast drags this card towards itself and lets go over a few
      // seconds — the march's `uHE` displacement, done by moving the card
      // instead of the sample. Nearest-wins rather than summed: two blasts
      // either side would otherwise cancel and the smoke would sit still.
      if (blasts) {
        let best = 0;
        let bx = 0;
        let by = 0;
        let bz = 0;
        for (const b of blasts) {
          const dx = b.x - x;
          const dy = b.y - y;
          const dz = b.z - z;
          const d = Math.hypot(dx, dy, dz);
          if (d > HE_PULL_RADIUS || d < 1e-3) continue;
          const heal = Math.max(0, 1 - b.age / HE_PULL_SECONDS);
          const pull = HE_PULL_MAX * heal * (1 - d / HE_PULL_RADIUS);
          if (pull > best) {
            best = pull;
            bx = dx;
            by = dy;
            bz = dz;
          }
        }
        if (best > 0) {
          x += bx * best;
          y += by * best;
          z += bz * best;
        }
      }
      c.setXYZ(n, x, y, z);
      // The HE's knit-back shrinks a card back in rather than fading it, which
      // reads as the hole closing instead of the smoke going translucent.
      let half = span * w * 0.5;
      // ...and a card that SURVIVED next to the hole is clipped so its rim
      // cannot cross into it. Without this the hole you see is much smaller
      // than the hole the fill cleared — a card is 106 units wide against a
      // 32-unit lattice, so the first surviving ring reaches 53 units back in
      // and swallows most of a 150-unit carve. This is what makes the drawn
      // hole the same size as the one `smokedAt` reports.
      if (holes) {
        for (const h of holes) {
          const d = Math.hypot(h.x - x, h.y - y, h.z - z);
          const reach = d - h.r;
          if (reach < half) half = Math.max(0, reach);
        }
        if (half <= 0) continue;
      }
      s.setX(n, half * 2);
      seat.setX(n, cells[i].d / maxD);
      n++;
    }
    c.needsUpdate = true;
    s.needsUpdate = true;
    seat.needsUpdate = true;
    this.geometry.instanceCount = n;
  }

  /** The per-frame curves. */
  setFrame({ grow = 1, alpha = 1, tint = null }) {
    this.grow.value = grow;
    this.alpha.value = alpha;
    if (tint) this.tint.value.copy(tint);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.instanceCount = 0;
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// src/cs3d/decals.js
// Bullet holes: CS2's own impact decals, projected onto the wall they hit.
//
// The pack (scripts/cs3d-decals.mjs) ships 98 of the game's decals in one
// atlas, the groups they belong to with the game's own weights, and the world
// size each material asks for. This file is the runtime half: which decal a
// surface gets, where it sits, and how it is drawn.
//
// PROJECTED, NOT PASTED. A decal here is real geometry, clipped out of the
// wall it landed on — the triangles inside a 5×5×12-unit box around the
// impact, cut to that box, with the wall's own lightmap UVs carried through
// the cut. Three things follow from that and none of them work with a quad:
//
//   it never floats           a hole on a step, a pipe or a beveled trim
//                             follows the surface instead of hovering off it
//   it is lit like the wall   the clipped vertices keep `uv1`, so the decal
//                             samples the same baked irradiance and the same
//                             baked sun shadow as the texel underneath. A
//                             bullet hole in Nuke's dark ramp is dark. This is
//                             what CS2's own decal shader does — the material
//                             ships `F_SAMPLE_LIGHTMAP = 1`.
//   the cutoff is honest      every impact .vmat carries `g_flCutoffAngle` 60°
//                             with 5° of softness: a face more than 60° off
//                             the projection axis is not written at all, and
//                             the last 5° fade. That is why a hole does not
//                             smear around a corner onto the wall beside it.
//
// The one place this differs from the game: CS2 projects along the axis its
// decal system was handed, and picks a `_Grazing` material for a shallow hit;
// with a 60° cutoff a grazing projection along the BULLET would write nothing,
// so the axis here is the surface normal in both cases and the grazing variant
// is chosen by the incidence angle. Same textures, same sizes, and the streaks
// are rolled to point down the bullet's travel so they trail the right way.
//
// Storage is a vertex ring. One non-indexed buffer per lighting path, decals
// appended at a cursor, and the oldest overwritten when it wraps — which is
// both the cheapest thing to do and what a decal cap means anyway. Nothing is
// ever removed from the middle, so there is no compaction and no per-decal
// draw call: the whole ring is one mesh.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { attribute, float, normalMap, texture, uniform, vec2 } from 'three/webgpu';
import { Cs3dMaterial } from './materials.js';
import { sourceToScene } from '../../shared/sim3d/units.js';

/**
 * How many bullet holes are kept before the oldest goes.
 *
 * Source's `r_decals` is 2048 across the whole world; this counts VERTICES
 * because a projected decal is not a fixed number of them. 24k vertices is
 * roughly 1,000 holes on flat walls and fewer on busy geometry, which is the
 * right way round: a decal that cost more to cut also cost more to keep.
 */
const RING_VERTS = 24576;

/** A single impact may not eat more than this much of the ring. */
const MAX_VERTS_PER_DECAL = 240;

/**
 * [guessed] Past this angle between the bullet and the surface normal the
 * impact counts as grazing and takes the `_Grazing` variant of its group.
 * CS2 has the two material sets and no number in the files that says when it
 * swaps; 68° is where a hole stops reading as round.
 */
const GRAZING_ANGLE = 68;

/** Push the clipped vertices this far off the surface, units. */
const LIFT = 0.06;

/**
 * How long a bullet hole takes to open, seconds.
 *
 * CS2's decal system writes the hole in one frame — this is ours, and it is
 * short on purpose. Long enough that a burst reads as four separate impacts
 * rather than four textures appearing at once, short enough that it is over
 * before the eye has finished moving to the wall.
 */
const IMPACT_GROW = 0.07;

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------

/**
 * One ring of decal geometry and the mesh that draws it.
 *
 * Two of these exist, because the map is lit two ways and a decal has to join
 * whichever one it landed on: charted world geometry reads the lightmap atlas
 * through `uv1`, and a prop reads the per-vertex probe irradiance the pack
 * baked into `_amb` / `_sun`. Sorting a decal into the right ring is one test
 * on the source geometry (does it carry `_amb`?), not a manifest lookup.
 */
/**
 * WebGPU's guaranteed `maxVertexBuffers` is 8, and three binds one buffer per
 * geometry attribute. A ninth attribute fails pipeline creation and — because
 * the invalid encoder is the whole scene pass — the map disappears on the
 * first shot. Packing is not tidiness: the prop ring used to be nine
 * (`_t0` and `_a` each owned a buffer) and both rings are added on the first
 * bullet, so even a hole in the floor took the world with it.
 */
export const DECAL_MAX_VERTEX_BUFFERS = 8;

/** Geometry for one decal ring. Exported so the 8-buffer cap is testable. */
export function createDecalRingGeometry(kind) {
  const g = new THREE.BufferGeometry();
  const f = (n) => new THREE.BufferAttribute(new Float32Array(RING_VERTS * n), n);
  g.setAttribute('position', f(3));
  g.setAttribute('normal', f(3));
  // xy: place inside the hole (0-1). zw: land time (seconds) and the
  // cutoff-angle fade. Packed so the prop ring stays at 7 attributes.
  g.setAttribute('_uvl', f(4));
  g.setAttribute('_cell', f(4));
  /**
   * The atlas coordinate, baked.
   *
   * The shader does not read it — it builds its own from `_uvl` and `_cell`
   * so the hole can open — but `normalMap()` does. With no `tangent`
   * attribute it falls back to deriving the frame from `dFdx`/`dFdy` of
   * `uv`, and a geometry with no `uv` at all hands it `vec2(0.0)`: the
   * determinant comes out zero, the inverse square root infinite, and every
   * decal's shading normal is NaN. That renders as black holes rather than
   * as an obvious error.
   */
  g.setAttribute('uv', f(2));
  if (kind === 'world') {
    g.setAttribute('uv1', f(2));
  } else {
    g.setAttribute('_amb', f(3));
    g.setAttribute('_sun', f(1));
  }
  for (const a of Object.values(g.attributes)) a.setUsage(THREE.DynamicDrawUsage);
  const nAttr = Object.keys(g.attributes).length;
  if (nAttr > DECAL_MAX_VERTEX_BUFFERS) {
    throw new Error(`decal ${kind} ring has ${nAttr} vertex buffers, WebGPU max is ${DECAL_MAX_VERTEX_BUFFERS}`);
  }
  g.setDrawRange(0, 0);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return g;
}

class DecalRing {
  /**
   * @param {'world'|'prop'} kind
   * @param {THREE.Material} material
   */
  constructor(kind, material) {
    this.kind = kind;
    const g = createDecalRingGeometry(kind);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = `decals-${kind}`;
    this.head = 0;
    this.wrapped = false;
    this.live = [];
  }

  /**
   * Reserve `n` vertices, evicting whatever they land on.
   * @returns {number} the vertex offset to write at
   */
  reserve(n) {
    if (this.head + n > RING_VERTS) {
      this.head = 0;
      this.wrapped = true;
      this.geometry.setDrawRange(0, RING_VERTS);
    }
    const start = this.head;
    const end = start + n;
    // A full scan, not a walk from the front with a break.
    //
    // `live` is insertion-ordered, and after a wrap it is no longer ascending
    // by `start`: a decal near the end of the ring survives the whole of the
    // next lap, so it sits AHEAD of the low-address entries written after it.
    // A `break` on the first non-overlap then stops at that survivor and
    // leaves everything the new write actually lands on in the list — where it
    // stays until a later lap blanks a range that by then belongs to a live
    // decal, taking a wedge out of a hole that is still on the wall. It starts
    // at the second wrap, so about two thousand bullets in.
    this.live = this.live.filter((d) => {
      if (d.start >= end || d.start + d.count <= start) return true;
      // The part of the evicted decal the new one does not cover would go on
      // drawing, so it is collapsed to a degenerate triangle at the origin.
      if (d.start + d.count > end) this._blank(end, d.start + d.count - end);
      return false;
    });
    this.head = end;
    this.live.push({ start, count: n });
    if (!this.wrapped) this.geometry.setDrawRange(0, this.head);
    return start;
  }

  _blank(start, count) {
    for (const attr of Object.values(this.geometry.attributes)) {
      attr.array.fill(0, start * attr.itemSize, (start + count) * attr.itemSize);
      attr.addUpdateRange(start * attr.itemSize, count * attr.itemSize);
      attr.needsUpdate = true;
    }
  }

  touched(start, count) {
    for (const attr of Object.values(this.geometry.attributes)) {
      attr.addUpdateRange(start * attr.itemSize, count * attr.itemSize);
      attr.needsUpdate = true;
    }
  }

  clear() {
    this.head = 0;
    this.wrapped = false;
    this.live.length = 0;
    this._blank(0, RING_VERTS);
    this.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------

const _sph = new THREE.Sphere();
const _mat = new THREE.Matrix4();
const _IDENTITY = new THREE.Matrix4();
const _n = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _faceN = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/**
 * Bullet holes in the world.
 *
 * @example
 *   const decals = new Decals({ assets, getPack: () => pack });
 *   decals.attach(pack.world);
 *   decals.add({ point, normal, dir, surface });   // SOURCE frame, like shooting.js
 */
export class Decals {
  /**
   * @param {object} o
   * @param {import('./bulletPack.js').BulletAssets} o.assets
   * @param {() => object|null} o.getPack   for the lightmap and the sun mask
   * @param {boolean} [o.enabled]
   */
  constructor({ assets, getPack, enabled = true }) {
    this.assets = assets;
    this.getPack = getPack || (() => null);
    this.enabled = enabled;
    this.root = new THREE.Group();
    this.root.name = 'decals';
    /**
     * Never a raycast target.
     *
     * The rings hang off `pack.world`, which is the same object `_targetsAt`
     * walks — and three's raycaster does not check `visible`, so
     * hiding them would not help either. Left alone, the second bullet into
     * one spot cuts its hole out of the FIRST hole: clipped to the old hole's
     * footprint, lifted another 0.06 off the wall, and carrying the ring's
     * lightmap UVs instead of the surface's. Stacked fire walks the decals off
     * the wall entirely. Returning false here stops the traversal above the
     * meshes, which also keeps them out of mapLoader's material inspector and
     * saves every impact the cost of 8,000 triangles it can never want.
     */
    this.root.raycast = () => false;
    this.rings = null;
    /**
     * The page clock the impact animation reads, shared by both rings.
     * One uniform ticked once a frame beats a per-decal timer, and a decal
     * whose grow-in has finished costs nothing at all (the shader clamps).
     */
    this.now = uniform(0);
    /** How many impacts were dropped because nothing could be cut for them. */
    this.missed = 0;
    this.placed = 0;
  }

  attach(parent) {
    if (parent && this.root.parent !== parent) parent.add(this.root);
    return this;
  }

  /**
   * Build the two rings, once the pack's lighting exists.
   *
   * Deferred rather than done in the constructor because the materials need
   * the map's lightmap atlas and its baked sun mask, and those stream in after
   * the geometry — a ring built before them would light every decal as if it
   * were in full daylight and never correct itself (materials.js rule 1: a
   * material is built once, with its final textures).
   */
  _build() {
    if (this.rings || !this.assets?.ready) return this.rings;
    const pack = this.getPack();
    const lib = pack?.materials;
    if (!lib) return null;
    // Not until the map's own light has finished streaming.
    //
    // materials.js rule 1: a material is built ONCE, with its final textures —
    // swapping one in later leaves the old sampler bound. These two rings are
    // built on the first bullet and never again, so building them before the
    // lightmap atlas or the baked sun mask has landed would light every hole in
    // the map as if it were in open daylight, permanently. A shot before then
    // simply leaves no mark, which lasts at most the second it takes the atlas
    // to arrive.
    if (!lib.lightmap) return null;
    if (lib.manifest?.shadowMask && !lib.sun?.mask) return null;
    const make = (kind) => {
      const mat = new Cs3dMaterial(
        kind === 'world'
          ? { lightmap: lib.lightmap, sun: lib.sun || null }
          : { probeAmbient: !!lib.probeAmbient, sun: lib.probeAmbient && lib.sunVis ? lib.sun : null }
      );
      mat.transparent = true;
      mat.depthWrite = false;
      // The decal sits a hair off the wall (LIFT) AND asks the rasteriser for
      // a depth nudge. Either alone leaves z-fighting somewhere: the lift
      // shows as a floating hole at a grazing view angle, the offset alone
      // loses to a lightmap seam on a distant wall.
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -4;
      mat.polygonOffsetUnits = -4;
      mat.roughness = 1;
      mat.metalness = 0;

      // The impact, over IMPACT_GROW seconds: the hole opens from a point.
      // `age` is clamped, so a decal that has been on the wall for a minute
      // costs the same as one that just landed and there is nothing to tick.
      const packed = attribute('_uvl', 'vec4');
      const cell = attribute('_cell', 'vec4');
      const local = packed.xy;
      const age = this.now.sub(packed.z).div(float(IMPACT_GROW)).clamp(0, 1);
      // Smoothstep, written out: TSL's `smoothstep` takes its edges FIRST, so
      // the chained `age.smoothstep(0, 1)` reads as `smoothstep(age, 0, 1)`
      // and is silently nonsense. 3t^2 - 2t^3 with `age` already clamped.
      const grow = age.mul(age).mul(age.mul(-2).add(3));
      // Shrinking the SAMPLE about the cell's centre magnifies the texture, so
      // early frames show the middle of the hole blown up and it settles back
      // to 1:1. Same trick as a scale-in without a per-decal transform.
      const scaled = vec2(0.5, 0.5).add(local.sub(vec2(0.5, 0.5)).div(grow.max(0.06)));
      const inside = scaled.clamp(0, 1);
      const at = cell.xy.add(inside.mul(cell.zw));
      const atlas = texture(this.assets.color, at);
      mat.colorNode = atlas.rgb;
      // Alpha is the hole's shape, times the cutoff fade the build computed,
      // times the impact's own fade-in.
      mat.opacityNode = atlas.a.mul(packed.w).mul(grow);
      mat.normalNode = normalMap(texture(this.assets.normal, at));
      mat.alphaTest = 0.02;
      return new DecalRing(kind, mat);
    };
    this.rings = { world: make('world'), prop: make('prop') };
    this.root.add(this.rings.world.mesh, this.rings.prop.mesh);
    return this.rings;
  }

  /**
   * Mark a wall.
   *
   * @param {object} o
   * @param {{x,y,z}} o.point    impact, SOURCE frame
   * @param {{x,y,z}} o.normal   surface normal, SOURCE frame
   * @param {{x,y,z}} [o.dir]    the bullet's direction, SOURCE frame — decides
   *                             grazing and which way a streak trails
   * @param {string} [o.surface] the surface name the tracer reported
   * @returns {boolean} whether anything was drawn
   */
  add({ point, normal, dir = null, surface = 'default' }) {
    if (!this.enabled || !this.assets?.ready) return false;
    const rings = this._build();
    if (!rings) return false;

    const [px, py, pz] = sourceToScene(point.x, point.y, point.z);
    const [nx, ny, nz] = sourceToScene(normal.x, normal.y, normal.z);
    _n.set(nx, ny, nz);
    if (!(_n.lengthSq() > 1e-8)) return false;
    _n.normalize();

    // Grazing: how far the bullet came in from the normal.
    let incidence = 0;
    if (dir) {
      const [dx, dy, dz] = sourceToScene(dir.x, dir.y, dir.z);
      _tmp.set(dx, dy, dz).normalize();
      incidence = Math.acos(Math.min(1, Math.max(-1, -_tmp.dot(_n)))) / DEG;
    }
    const grazing = incidence > GRAZING_ANGLE;

    const group = this.assets.groupFor(surface, grazing);
    const cell = this.assets.pick(group);
    if (cell === null || cell === undefined) return false;
    const spec = this.assets.spec(cell);
    if (!spec) return false;

    // The decal's own frame. `up` runs along the bullet's travel across the
    // surface when it grazed — that is the direction a streak has to point —
    // and is a free roll otherwise, so fifty holes in one wall are not fifty
    // copies of the same rectangle.
    if (grazing && dir) {
      const [dx, dy, dz] = sourceToScene(dir.x, dir.y, dir.z);
      _up.set(dx, dy, dz);
      // The travel FLATTENED onto the surface. A streak runs along it, so the
      // component into the wall has to come off first or the roll is arbitrary.
      _up.addScaledVector(_n, -_up.dot(_n));
      if (_up.lengthSq() < 1e-8) rollBasis(_n, _up);
      else _up.normalize();
    } else {
      rollBasis(_n, _up, Math.random() * Math.PI * 2);
    }
    _right.crossVectors(_up, _n).normalize();
    _up.crossVectors(_n, _right).normalize();

    // Size, rolled inside the material's own variance. CS2 stores the variance
    // as a multiplicative spread rather than a fraction (asphalt scuffs carry
    // 1.5, which as a ± would allow a negative decal), so it reads as a range
    // of [1/(1+v), 1+v] about the authored size. `[guessed]` — the roll is not
    // in the files, only its width.
    const v = Math.max(0, spec.sizeVariance || 0);
    const scale = v > 0 ? 1 / (1 + v) + Math.random() * (1 + v - 1 / (1 + v)) : 1;
    const hw = (spec.width * scale) / 2;
    const hh = (spec.height * scale) / 2;
    const half = (spec.depth || 12) / 2;
    _centre.set(px, py, pz);

    const targets = this._targetsAt(_centre, Math.hypot(hw, hh, half));
    if (!targets.length) {
      this.missed++;
      return false;
    }

    const cut = { hw, hh, half, cutoff: spec.cutoffAngle ?? 60, softness: spec.cutoffSoftness ?? 0 };
    let any = false;
    for (const target of targets) {
      const built = this._cut(target, cut);
      if (!built) continue;
      this._write(built, cell);
      any = true;
    }
    if (!any) {
      this.missed++;
      return false;
    }
    this.placed++;
    return true;
  }

  /**
   * Drawn tiles the decal box overlaps.
   *
   * The bullet already hit the COLLISION BVH. The hole has to be cut out of
   * the DRAWN mesh so it keeps that surface's lightmap UVs. The drawn world
   * is one BatchedMesh per material with no BVH, so a full-scene raycast is
   * what froze spraying. Sphere tests against each tile stay cheap; an AABB
   * then drops long tiles (chainlink, ducts) whose sphere covers a wall the
   * hole is not on — `_cut` would otherwise walk tens of thousands of tris
   * per shot.
   *
   * One tile is not enough: a hole is several units across and pack tiles are
   * small, so taking only the tightest sphere (or the ray's first batchId)
   * clips the pattern at the seam. Overlay-decal batches are skipped — they
   * are the dirt/poster quads whose tiny spheres used to steal the pick.
   */
  _targetsAt(centre, radius) {
    const pack = this.getPack();
    const world = pack?.world;
    if (!world) return [];
    const slop = radius + VISUAL_SLOP;
    const out = [];
    const consider = (object, start, count, worldSpace, sph) => {
      if (
        spherePickScore(
          sph.center.x,
          sph.center.y,
          sph.center.z,
          sph.radius,
          centre.x,
          centre.y,
          centre.z,
          slop
        ) === Infinity
      ) {
        return;
      }
      out.push({ object, geometry: object.geometry, start, count, point: centre, worldSpace });
    };

    const mats = pack.manifest?.materials;
    for (const [key, batch] of pack.batches || []) {
      if (typeof key === 'string' && key.charAt(0) === 's') continue;
      if (mats?.[batch.userData?.matId]?.decal) continue;
      const info = batch._drawInfo;
      if (!info || !batch.geometry?.getAttribute?.('position')) continue;
      const spheres = batch._tileSpheres;
      const boxes = batch._tileBoxes;
      for (let i = 0, l = info.length; i < l; i++) {
        const di = info[i];
        if (!di || !di.active) continue;
        const gid = di.geometryIndex;
        const range = batchedRange(batch, gid);
        if (!range) continue;
        const so = i * 4;
        if (spheres && spheres.length >= so + 4) {
          _sph.center.set(spheres[so], spheres[so + 1], spheres[so + 2]);
          _sph.radius = spheres[so + 3];
        } else {
          batch.getMatrixAt(i, _mat);
          batch.getBoundingSphereAt(gid, _sph).applyMatrix4(_mat);
        }
        if (
          spherePickScore(
            _sph.center.x,
            _sph.center.y,
            _sph.center.z,
            _sph.radius,
            centre.x,
            centre.y,
            centre.z,
            slop
          ) === Infinity
        ) {
          continue;
        }
        const bo = i * 6;
        if (boxes && boxes.length >= bo + 6 && !boxOverlaps(boxes, bo, centre.x, centre.y, centre.z, slop)) {
          continue;
        }
        consider(batch, range.start, range.count, true, _sph);
      }
    }

    world.traverse((o) => {
      if (o.isBatchedMesh || !o.isMesh) return;
      if (skipDecalMesh(o)) return;
      if (mats?.[o.userData?.matId]?.decal) return;
      const geo = o.geometry;
      if (!geo?.getAttribute?.('position')) return;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      _sph.copy(geo.boundingSphere).applyMatrix4(o.matrixWorld);
      const count = geo.index ? geo.index.count : geo.getAttribute('position').count;
      consider(o, 0, count, o.matrixWorld.equals(_IDENTITY), _sph);
    });

    return out;
  }

  /**
   * Clip the target's triangles to the decal box.
   *
   * Sutherland-Hodgman against the six planes, plus the material's own cutoff
   * on the face normal before any of it — a face pointing more than
   * `cutoff` degrees away from the projection axis is skipped, and the last
   * `softness` degrees fade its alpha out. That test is what stops a hole
   * shot into an inside corner from also appearing on the wall at right
   * angles to it.
   */
  _cut(target, { hw, hh, half, cutoff, softness }) {
    const geo = target.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.index;
    const nrm = geo.getAttribute('normal');
    const uv1 = geo.getAttribute('uv1');
    const amb = geo.getAttribute('_amb');
    const sun = geo.getAttribute('_sun');
    // Which ring: a PROP carries baked probe irradiance per vertex and world
    // geometry does not, so `_amb` is the test. NOT `uv1` — mapLoader's
    // normalizeTile adds that attribute to every tile whether or not the tile
    // has a lightmap chart, filling it with zeros when it does not, so a prop
    // routed on `uv1` lands in the lightmapped ring and samples texel (0, 0)
    // of the atlas for the rest of its life.
    const kind = amb ? 'prop' : 'world';
    const m = target.worldSpace ? null : target.object.matrixWorld;

    const cosCut = Math.cos(cutoff * DEG);
    const cosSoft = Math.cos(Math.max(0, cutoff - softness) * DEG);
    // The cheap reject, before any clipping: the decal box's world-space
    // bounds. A map tile is thousands of triangles and a bullet hole touches
    // three of them, so this test is what makes cutting a decal affordable.
    const radius = Math.hypot(hw, hh, half);
    const bx = _centre.x;
    const by = _centre.y;
    const bz = _centre.z;
    const out = { kind, verts: [] };

    const posA = pos.array;
    const posStride = pos.itemSize;
    const idxA = idx ? idx.array : null;
    const end = target.start + target.count - (target.count % 3);
    for (let i = target.start; i < end; i += 3) {
      const a = idxA ? idxA[i] : i;
      const b = idxA ? idxA[i + 1] : i + 1;
      const c = idxA ? idxA[i + 2] : i + 2;
      let ao = a * posStride;
      let bo = b * posStride;
      let co = c * posStride;
      _tri[0].set(posA[ao], posA[ao + 1], posA[ao + 2]);
      _tri[1].set(posA[bo], posA[bo + 1], posA[bo + 2]);
      _tri[2].set(posA[co], posA[co + 1], posA[co + 2]);
      if (m) {
        _tri[0].applyMatrix4(m);
        _tri[1].applyMatrix4(m);
        _tri[2].applyMatrix4(m);
      }
      // Separating-axis reject on the world axes: a triangle whose bounds miss
      // the box's bounds cannot survive the clip.
      if (
        Math.min(_tri[0].x, _tri[1].x, _tri[2].x) > bx + radius ||
        Math.max(_tri[0].x, _tri[1].x, _tri[2].x) < bx - radius ||
        Math.min(_tri[0].y, _tri[1].y, _tri[2].y) > by + radius ||
        Math.max(_tri[0].y, _tri[1].y, _tri[2].y) < by - radius ||
        Math.min(_tri[0].z, _tri[1].z, _tri[2].z) > bz + radius ||
        Math.max(_tri[0].z, _tri[1].z, _tri[2].z) < bz - radius
      ) {
        continue;
      }
      _e1.subVectors(_tri[1], _tri[0]);
      _e2.subVectors(_tri[2], _tri[0]);
      _faceN.crossVectors(_e1, _e2);
      if (_faceN.lengthSq() < 1e-12) continue;
      _faceN.normalize();
      const facing = _faceN.dot(_n);
      if (facing <= cosCut) continue;
      const fade = cosSoft > cosCut ? Math.min(1, (facing - cosCut) / (cosSoft - cosCut)) : 1;

      // Into decal space: x right, y up, z along the normal, origin at the
      // impact. Barycentrics ride along so every other attribute can be
      // rebuilt at whatever the clip produces.
      let poly = [];
      for (let k = 0; k < 3; k++) {
        _tmp.subVectors(_tri[k], _centre);
        poly.push({
          x: _tmp.dot(_right),
          y: _tmp.dot(_up),
          z: _tmp.dot(_n),
          w: [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]
        });
      }
      poly = clipAxis(poly, 'x', hw);
      if (poly.length < 3) continue;
      poly = clipAxis(poly, 'y', hh);
      if (poly.length < 3) continue;
      poly = clipAxis(poly, 'z', half);
      if (poly.length < 3) continue;

      // Fan the convex polygon out, resolving each vertex back to world space
      // and to the source triangle's attributes through its barycentrics.
      const tri = [a, b, c];
      for (let k = 1; k + 1 < poly.length; k++) {
        for (const p of [poly[0], poly[k], poly[k + 1]]) {
          if (out.verts.length >= MAX_VERTS_PER_DECAL) return out.verts.length ? out : null;
          out.verts.push(resolve(p, tri, { pos, nrm, uv1, amb, sun, m }, fade, hw, hh));
        }
      }
    }
    return out.verts.length >= 3 ? out : null;
  }

  /** Append a built decal into its ring and map its UVs into the atlas cell. */
  _write(built, cell) {
    const ring = this.rings[built.kind];
    const n = built.verts.length - (built.verts.length % 3);
    if (!n) return;
    const at = ring.reserve(n);
    const g = ring.geometry;
    const P = g.getAttribute('position').array;
    const N = g.getAttribute('normal').array;
    const L = g.getAttribute('_uvl').array;
    const UV = g.getAttribute('uv').array;
    const C = g.getAttribute('_cell').array;
    const U1 = built.kind === 'world' ? g.getAttribute('uv1').array : null;
    const AM = built.kind === 'prop' ? g.getAttribute('_amb').array : null;
    const SU = built.kind === 'prop' ? g.getAttribute('_sun').array : null;
    const { u0, v0, du, dv } = this.assets.cellUv(cell);
    const t0 = this.now.value;

    for (let i = 0; i < n; i++) {
      const v = built.verts[i];
      const o = at + i;
      P[o * 3] = v.px;
      P[o * 3 + 1] = v.py;
      P[o * 3 + 2] = v.pz;
      N[o * 3] = v.nx;
      N[o * 3 + 1] = v.ny;
      N[o * 3 + 2] = v.nz;
      L[o * 4] = v.u;
      L[o * 4 + 1] = v.v;
      L[o * 4 + 2] = t0;
      L[o * 4 + 3] = v.a;
      UV[o * 2] = u0 + v.u * du;
      UV[o * 2 + 1] = v0 + v.v * dv;
      C[o * 4] = u0;
      C[o * 4 + 1] = v0;
      C[o * 4 + 2] = du;
      C[o * 4 + 3] = dv;
      if (U1) {
        U1[o * 2] = v.lu;
        U1[o * 2 + 1] = v.lv;
      }
      if (AM) {
        AM[o * 3] = v.ar;
        AM[o * 3 + 1] = v.ag;
        AM[o * 3 + 2] = v.ab;
        SU[o] = v.sv;
      }
    }
    ring.touched(at, n);
  }

  /** Advance the impact animation. Nothing else here is time-dependent. */
  update(dt) {
    this.now.value += dt;
    // Build the rings once lighting exists, not on the first bullet. The
    // materials compile a WebGPU pipeline; doing that inside fire() is a
    // multi-hundred-ms hitch on the shot that first marked a wall.
    if (this.enabled && !this.rings) this._build();
  }

  /** Wipe every hole in the map — a new round, a reloaded pack. */
  clear() {
    this.rings?.world.clear();
    this.rings?.prop.clear();
    this.placed = 0;
    this.missed = 0;
  }

  dispose() {
    this.rings?.world.dispose();
    this.rings?.prop.dispose();
    this.rings = null;
    this.root.removeFromParent();
  }
}

/** Collision and visual meshes disagree by a fraction of a unit; this much slop still picks the tile. */
const VISUAL_SLOP = 8;

/**
 * Infinity means the sphere misses the impact; any finite value is a hit.
 * Exported so the pick cannot silently become a full-map walk again without
 * the test noticing.
 */
export function spherePickScore(cx, cy, cz, radius, px, py, pz, slop = VISUAL_SLOP) {
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) - radius;
  const outside = dist > 0 ? dist : 0;
  if (outside > slop) return Infinity;
  return outside + radius * 1e-4;
}

/**
 * Axis-aligned overlap of a packed tile box (`minxyz` then `maxxyz` at `off`)
 * against a point with slop. Long tiles fail this after passing the sphere.
 */
export function boxOverlaps(boxes, off, px, py, pz, slop) {
  return !(
    boxes[off + 3] < px - slop ||
    boxes[off] > px + slop ||
    boxes[off + 4] < py - slop ||
    boxes[off + 1] > py + slop ||
    boxes[off + 5] < pz - slop ||
    boxes[off + 2] > pz + slop
  );
}

/** Groups hanging off pack.world that are never a bullet-hole surface. */
const SKIP_DECAL_ROOTS = new Set([
  'phys-placeholder',
  'decals',
  'tracers',
  'bullets',
  'nade-effects',
  'projectiles',
  'demo',
  'player'
]);

function skipDecalMesh(o) {
  let p = o;
  while (p) {
    if (p.visible === false) return true;
    const name = p.name || '';
    if (SKIP_DECAL_ROOTS.has(name) || name.startsWith('decals-') || name.startsWith('mesh-lod')) return true;
    p = p.parent;
  }
  return false;
}

function batchedRange(batch, gid) {
  if (gid == null || gid < 0) return null;
  if (typeof batch.getGeometryRangeAt === 'function') {
    const r = batch.getGeometryRangeAt(gid);
    if (r && r.count > 0) return r;
  }
  const ranges = batch._drawRanges;
  return ranges && ranges[gid] && ranges[gid].count > 0 ? ranges[gid] : null;
}

/**
 * A vector perpendicular to `n`, optionally rolled about it.
 * Seeded off the world axis furthest from the normal so the cross is stable.
 */
function rollBasis(n, out, roll = 0) {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  const pick = ax < ay && ax < az ? _tmp.set(1, 0, 0) : ay < az ? _tmp.set(0, 1, 0) : _tmp.set(0, 0, 1);
  out.crossVectors(n, pick).normalize();
  if (roll) out.applyAxisAngle(n, roll);
  return out;
}

/**
 * Clip a convex polygon to the decal's box, in the decal's own frame.
 *
 * Exported for shared/sim3d-style testing: this is the only real geometry in
 * the file and it is the thing that decides whether a hole wraps a step
 * correctly or leaves a triangle hanging in the air.
 *
 * @param {{x,y,z,w:number[]}[]} poly  vertices, `w` the barycentrics they carry
 * @param {number} hw  half width  (the decal's x)
 * @param {number} hh  half height (its y)
 * @param {number} hd  half depth  (along the projection axis)
 */
export function clipPolygonToBox(poly, hw, hh, hd) {
  let out = clipAxis(poly, 'x', hw);
  if (out.length < 3) return [];
  out = clipAxis(out, 'y', hh);
  if (out.length < 3) return [];
  out = clipAxis(out, 'z', hd);
  return out.length < 3 ? [] : out;
}

/** Sutherland-Hodgman against the pair of planes |axis| = limit. */
function clipAxis(poly, axis, limit) {
  return clipPlane(clipPlane(poly, axis, limit, 1), axis, limit, -1);
}

function clipPlane(poly, axis, limit, sign) {
  const out = [];
  const dist = (p) => (sign > 0 ? limit - p[axis] : p[axis] + limit);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = dist(a);
    const db = dist(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        w: [a.w[0] + (b.w[0] - a.w[0]) * t, a.w[1] + (b.w[1] - a.w[1]) * t, a.w[2] + (b.w[2] - a.w[2]) * t]
      });
    }
  }
  return out;
}

const _rv = new THREE.Vector3();

/**
 * A clipped vertex, back in the world and carrying the surface's own shading
 * inputs — interpolated at the cut, not sampled at the impact, so a decal
 * lying across a lightmap gradient follows it.
 */
function resolve(p, tri, attrs, fade, hw, hh) {
  const { pos, nrm, uv1, amb, sun, m } = attrs;
  const [w0, w1, w2] = p.w;
  const bary = (attr, comp) => {
    const g = comp === 0 ? attr.getX : comp === 1 ? attr.getY : attr.getZ;
    return g.call(attr, tri[0]) * w0 + g.call(attr, tri[1]) * w1 + g.call(attr, tri[2]) * w2;
  };
  // Position comes from the CLIP, not from the barycentrics: the clip is what
  // put the vertex on the box edge, and rebuilding it from weights would drift
  // it back inside on a triangle the box cut twice.
  _rv.copy(_centre).addScaledVector(_right, p.x).addScaledVector(_up, p.y).addScaledVector(_n, p.z);

  let nx = _n.x;
  let ny = _n.y;
  let nz = _n.z;
  if (nrm) {
    nx = bary(nrm, 0);
    ny = bary(nrm, 1);
    nz = bary(nrm, 2);
    if (m) {
      _tmp.set(nx, ny, nz).transformDirection(m);
      nx = _tmp.x;
      ny = _tmp.y;
      nz = _tmp.z;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
  }
  // Off the wall along the SURFACE's normal rather than the decal's, so a hole
  // that wrapped onto a bevel lifts off the bevel and not off the flat.
  _rv.x += nx * LIFT;
  _rv.y += ny * LIFT;
  _rv.z += nz * LIFT;

  return {
    px: _rv.x,
    py: _rv.y,
    pz: _rv.z,
    nx,
    ny,
    nz,
    u: p.x / (2 * hw) + 0.5,
    v: p.y / (2 * hh) + 0.5,
    a: fade,
    lu: uv1 ? bary(uv1, 0) : 0,
    lv: uv1 ? bary(uv1, 1) : 0,
    ar: amb ? bary(amb, 0) : 0,
    ag: amb ? bary(amb, 1) : 0,
    ab: amb ? bary(amb, 2) : 0,
    sv: sun ? bary(sun, 0) : 1
  };
}

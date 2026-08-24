// ---------------------------------------------------------------------------
// meshMap.js
// Loading a ported CS2 map (scripts/gen-trainer-map.mjs) into a scenario.
//
// The file is one glb with two meshes in it: `render`, which carries the map as
// flat greys in COLOR_0, and `collision`, the authored hull the player is
// stopped by. See the porter for what does and does not come across.
//
// Cached per map for the life of the page. The geometry is ~8 MB over the wire
// and several times that once decoded, and a scenario restart must not pay for
// it again — so what a caller gets back is a fresh THREE.Mesh over SHARED
// geometry. That has one consequence worth stating plainly, because the trainer
// disposes scenery aggressively on unload: nothing here may be disposed by a
// scenario. `MapHandle.detach()` takes the mesh out of the scene and leaves the
// buffers and the BVH alone for the next run.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { packLoader, PACK_CDN } from '../agents/packBase.js';
import { MeshCollider } from '../utils/MeshCollision.js';
import { createRayWorld } from '../cs3d/rayWorld.js';
import { UNIT_M } from '../../shared/sim3d/units.js';
import { bakeNodeTransform } from './quantizedGeometry.js';
import { dmSpawnsFor } from './dmSpawns.js';

// Bullets, bot line-of-sight and the decal placer all reach the map through
// THREE.Raycaster, and a million triangles is not something three's own
// per-triangle raycast can be asked to walk sixty times a second. Installed
// once, here: the accelerated path only engages for geometry that has a
// `boundsTree`, so every other mesh in the trainer behaves exactly as before.
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** id → Promise<{geometry, collider, material}> */
const cache = new Map();

/**
 * `id|minX|maxX` → the sliced render geometry.
 *
 * Slicing dust2 walks a million triangles and builds a BVH over what is left,
 * which is not something to repeat every time a run restarts. Shared exactly
 * like the full geometry is, and disposed by nobody for the same reason.
 */
const sliceCache = new Map();

/**
 * The material every ported map is drawn with.
 *
 * One material, because the greys ride in COLOR_0 and there is nothing else to
 * vary — the whole map is one draw call. `vertexColors` multiplies white by
 * them, and they are already in the renderer's working (linear) space, which is
 * what the porter bakes and why they are 16-bit there.
 *
 * Lit by the trainer's own lights, deliberately: the map's sun, lightmap and
 * probe grid were all left behind, and this is a training arena that happens to
 * be shaped like dust2 rather than a copy of how dust2 looks.
 */
/**
 * The ramp the porter baked, as sRGB fractions: the map's LARGEST surfaces at
 * the dark end, its smallest at the bright end (shared/cs3d/flatGreys.js).
 * COLOR_0 itself is linear, so the shader converts before comparing.
 */
const RAMP_LO = 0x42 / 255;
const RAMP_HI = 0xf0 / 255;

/**
 * How much of the brightness range one map is allowed to occupy, and therefore
 * how much relief it keeps once it is recoloured.
 *
 * The flat view's whole trick is that a surface's shade tells you how big it
 * is, which needs the map to span a band rather than sit at one value. Tinting
 * by a colour the user picked cannot just multiply: a near-black cover colour
 * would take the entire map to black and a white one would blow it out, and
 * either way the size cue is gone.
 *
 * So the band is a fixed WIDTH that slides. Its centre is the chosen colour's
 * own brightness, clamped so the band never runs off either end — pick white
 * and the band sits against the top, so white is the brightest thing in the map
 * and everything else steps down from it; pick black and it sits against the
 * bottom, black is the darkest thing, and the map steps up. The cost is at the
 * extremes: the last band-half of the range all clamps to the same place, so
 * the darkest few colours are indistinguishable from each other, as are the
 * brightest few. That is the trade for never losing the relief.
 */
const BAND = 0.3;
const BAND_HALF = BAND / 2;

const _tintColor = new THREE.Color();

/**
 * A cover colour → the two things the shader needs: the unit-luminance chroma
 * to paint with, and the sRGB band to spread the map's own ramp across.
 */
export function coverTintBand(color) {
  _tintColor.set(color || '#ffffff');
  // Perceptual, because the band is about how bright the colour LOOKS. three
  // has already colour-managed the hex into linear, so this goes back.
  const lin = 0.2126 * _tintColor.r + 0.7152 * _tintColor.g + 0.0722 * _tintColor.b;
  const srgb = lin <= 0.0031308 ? lin * 12.92 : 1.055 * lin ** (1 / 2.4) - 0.055;
  const centre = Math.min(1 - BAND_HALF, Math.max(BAND_HALF, srgb));
  // Chroma only: dividing by its own luminance leaves a colour the shader can
  // scale to any brightness without shifting hue. A black pick has no chroma
  // to keep, so it paints in greys — which is what "black" should look like
  // once it is the darkest end of a ramp rather than the whole of it.
  const unit = lin > 1e-4
    ? [_tintColor.r / lin, _tintColor.g / lin, _tintColor.b / lin]
    : [1, 1, 1];
  return { unit, lo: centre - BAND_HALF, hi: centre + BAND_HALF };
}

const TINT_CHUNK = /* glsl */ `
  {
    float mapLin = dot(vColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    float mapSrgb = mapLin <= 0.0031308 ? mapLin * 12.92 : 1.055 * pow(mapLin, 1.0 / 2.4) - 0.055;
    float t = clamp((mapSrgb - ${RAMP_LO.toFixed(6)}) / ${(RAMP_HI - RAMP_LO).toFixed(6)}, 0.0, 1.0);
    float outSrgb = mix(uCoverBand.x, uCoverBand.y, t);
    float outLin = outSrgb <= 0.04045 ? outSrgb / 12.92 : pow((outSrgb + 0.055) / 1.055, 2.4);
    vColor.rgb = uCoverTint * outLin;
  }
`;

/**
 * The material every ported map is drawn with.
 *
 * The greys ride in COLOR_0 and there is nothing else to vary, so the whole map
 * is one draw call. `vertexColors` multiplies white by them, and they are
 * already in the renderer's working (linear) space, which is what the porter
 * bakes and why they are 16-bit there.
 *
 * On top of that sits the recolour: the baked ramp is remapped, per vertex,
 * into a band around the player's chosen cover colour. Done in the shader
 * rather than by rewriting COLOR_0 because the geometry is SHARED between every
 * run of the map and a colour change must not touch it.
 *
 * Lit by the trainer's own lights, deliberately: the map's sun, lightmap and
 * probe grid were all left behind, and this is a training arena that happens to
 * be shaped like dust2 rather than a copy of how dust2 looks.
 */
function mapMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1,
    metalness: 0
  });
  // Held on the material so `setCoverTint` can write them after the program is
  // built; the shader is handed these exact objects, not copies.
  const uniforms = {
    uCoverTint: { value: new THREE.Vector3(1, 1, 1) },
    uCoverBand: { value: new THREE.Vector2(RAMP_LO, RAMP_HI) }
  };
  mat.userData.coverUniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCoverTint = uniforms.uCoverTint;
    shader.uniforms.uCoverBand = uniforms.uCoverBand;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uCoverTint;\nuniform vec2 uCoverBand;'
      )
      .replace('#include <color_vertex>', `#include <color_vertex>\n${TINT_CHUNK}`);
  };
  return mat;
}

/**
 * The map's geometry, from the deploy or from the asset bucket.
 *
 * The file is served from `public/` on a full deploy, which is the fast path
 * and the one a local `npm run dev` takes. It is also 8 MB of binary, and a
 * checkout that does not carry it — or a host serving an older build — would
 * otherwise have no map at all. So the CDN the 3D explorer's packs already
 * live on is tried second, at the same path under `maps/ported/`
 * (`npm run maps:upload` puts it there).
 *
 * `maps/` is excluded from the SPA rewrite in both vercel.json and
 * server/static.js, so a miss is a real 404 rather than index.html arriving
 * with a 200 and failing to parse as a glb.
 */
async function fetchGltf(data) {
  const loader = packLoader();
  // `?v=` is the map's content hash. The bucket serves this file immutable for
  // a year, so a re-port has to arrive under a URL nobody is already holding.
  const v = data.version ? `?v=${encodeURIComponent(data.version)}` : '';
  const urls = [`${data.mesh}${v}`, `${PACK_CDN}${data.mesh}${v}`];
  let last = null;
  for (const url of urls) {
    try {
      return await loader.loadAsync(url);
    } catch (e) {
      last = e;
      console.warn(`cs3d: ${data.id} not at ${url} —`, e?.message || e);
    }
  }
  throw last || new Error(`${data.id}: no map geometry anywhere`);
}

async function fetchMap(data) {
  const gltf = await fetchGltf(data);
  let render = null;
  let collision = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === 'collision' || o.parent?.name === 'collision') collision = o;
    else render = o;
  });
  if (!render) throw new Error(`${data.id}: the map glb has no render mesh`);
  // Both meshes are authored in world space, but quantization leaves a node
  // transform behind to undo it. Bake it once, here, so the collider's
  // triangles, the drawn ones and every spawn point are in one coordinate
  // system and no caller has to carry a matrix around.
  bakeNodeTransform(render);
  if (collision) bakeNodeTransform(collision);

  // Two trees, and they answer different questions. Movement is stopped by the
  // authored hull, which includes the playerclips that fence off the parts of
  // the level that are only scenery. Bullets and sightlines are stopped by what
  // is actually drawn — a decal on an invisible clip brush would be a mark
  // floating in mid-air, and a bot refusing to shoot through one would be
  // holding an angle nobody can see it hold.
  //
  // ~780 ms and ~36 MB for dust2, once per page. Both are paid here rather than
  // on the first frame that needs them.
  const collider = collision
    ? new MeshCollider(collision.geometry, { floorY: data.bounds.minY - 2 })
    : null;
  if (collider) attachCollisionBands(collider, data);
  render.geometry.boundsTree = new MeshBVH(render.geometry, { targetLeafSize: 8 });
  return {
    geometry: render.geometry,
    collider,
    // Hand-picked points beat the pack's own, and by a wide margin for a
    // free-for-all: see src/maps/dmSpawns.js for why and for how to add them.
    // They are snapped to the floor the same way, because a getpos taken while
    // standing on a crate is a metre off the ground it was read from.
    spawns: snapSpawns(dmSpawnsFor(data.id) || data.spawns, collider)
  };
}

/**
 * Expand the porter's band table onto the collider.
 *
 * The result is the SAME shape src/cs3d/mapLoader.js builds for the explorer's
 * packs — `surfaces`, `surfaceOf`, `passBullets`, `ranges`, `mask`, `triangles`
 * — because the two tracers that read it (src/cs3d/rayWorld.js and
 * src/cs3d/hullWorld.js) are now the same code in both places. Which is the
 * whole point: a wallbang in the trainer is decided by
 * shared/sim3d/penetration.js reading a real surface name off a real triangle,
 * not by an approximation of one.
 *
 * The porter ships ranges rather than a per-triangle array (a phys mesh has one
 * surface, so a few hundred ranges say the same thing in two kilobytes); this
 * is where they become the flat arrays the tracers index. Once per map.
 */
function attachCollisionBands(collider, data) {
  const c = data.collision;
  if (!c) return;
  const n = c.triangles || collider.length;
  collider.triangles = n;
  collider.surfaces = c.surfaces || [];
  collider.ranges = c.ranges || null;
  // u8 while the map has 255 or fewer distinct surfaces (the most any of them
  // has is 40), u16 beyond that.
  const surfaceOf = collider.surfaces.length > 255 ? new Uint16Array(n) : new Uint8Array(n);
  const passBullets = new Uint8Array(n);
  let flagged = 0;
  for (const [start, end, sid, pass] of c.bands || []) {
    surfaceOf.fill(sid, start, end);
    if (pass) {
      passBullets.fill(1, start, end);
      flagged += end - start;
    }
  }
  collider.surfaceOf = surfaceOf;
  collider.passBullets = flagged ? passBullets : null;
  /**
   * Per-triangle kill switch, for parity with the explorer's collider.
   *
   * Nothing in the trainer breaks a window yet, so it is all zeroes — but the
   * tracers read it unconditionally and a missing one would mean two code paths
   * where there is now one.
   */
  collider.mask = new Uint8Array(n);
  collider.maskVersion = 0;
}

/**
 * Drop every spawn onto the floor underneath it.
 *
 * CS2's `info_player_*` entities are not placed on the ground — dust2's sit
 * 0.6 to 1.6 m above it, and the engine settles them at round start. The
 * trainer has no such step, so a raw spawn would drop the player through a
 * short fall every single time they respawn. Thirty raycasts, once.
 *
 * A spawn with nothing under it keeps its authored height rather than being
 * moved to the bottom of the world.
 *
 * @returns {Array<{pos: number[], yaw: number}>}
 */
function snapSpawns(spawns, collider) {
  if (!collider) return spawns;

  return spawns.map((sp) => {
    const [x, y, z] = sp.pos;
    const ground = collider.groundHeightAt(x, z, y);
    const ok = ground > collider.floorY && ground <= y + 0.05;
    return { ...sp, pos: [x, ok ? ground : y, z] };
  });
}

/**
 * Cut a map's render geometry down to a slab, and throw the rest away.
 *
 * For a gamemode played from one spot — Doors holds mid on dust2 and can never
 * leave a box a few metres across — most of the map is a million triangles of
 * scenery nobody will ever see. Culling it in the fragment stage (clip planes,
 * a discard) would still transform every vertex of it every frame; this removes
 * the triangles from the buffer entirely, so the vertex stage never sees them
 * and the BVH built over the result is smaller as well.
 *
 * The test is bounding-box OVERLAP against the slab, not "every vertex inside".
 * A ground quad can span the whole map with all four corners outside a slab it
 * nevertheless crosses, and dropping it would put a hole in the floor the
 * player is standing on. Overlap keeps exactly what reaches into the slab.
 *
 * The source geometry is shared and cached, so this never mutates it: attribute
 * arrays are copied into fresh ones of the same type, keeping their
 * `normalized` flag (the greys ride in COLOR_0 as normalized uint16).
 *
 * @param {THREE.BufferGeometry} geometry  indexed, position in metres
 * @param {number} minX  slab start, SCENE metres
 * @param {number} maxX  slab end
 * @returns {{geometry: THREE.BufferGeometry, kept: number, total: number}}
 */
export function sliceGeometryX(geometry, minX, maxX) {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const at = (i) => (index ? index.getX(i) : i);

  // Pass one: which triangles reach into the slab, and which vertices they use.
  const keepTris = [];
  for (let t = 0; t < triCount; t++) {
    const a = at(t * 3);
    const b = at(t * 3 + 1);
    const c = at(t * 3 + 2);
    const xa = pos.getX(a);
    const xb = pos.getX(b);
    const xc = pos.getX(c);
    if (Math.min(xa, xb, xc) > maxX) continue;
    if (Math.max(xa, xb, xc) < minX) continue;
    keepTris.push(a, b, c);
  }

  // Pass two: compact the vertices the survivors actually reference, so the
  // buffer shrinks with the triangle list instead of keeping every vertex of
  // the map alive behind a shorter index.
  const remap = new Int32Array(pos.count).fill(-1);
  const used = [];
  const newIndex = new Uint32Array(keepTris.length);
  for (let i = 0; i < keepTris.length; i++) {
    const v = keepTris[i];
    let m = remap[v];
    if (m === -1) {
      m = used.length;
      remap[v] = m;
      used.push(v);
    }
    newIndex[i] = m;
  }

  const out = new THREE.BufferGeometry();
  for (const [name, src] of Object.entries(geometry.attributes)) {
    const ArrayType = src.array.constructor;
    const dst = new ArrayType(used.length * src.itemSize);
    for (let i = 0; i < used.length; i++) {
      const from = used[i] * src.itemSize;
      const to = i * src.itemSize;
      for (let k = 0; k < src.itemSize; k++) dst[to + k] = src.array[from + k];
    }
    out.setAttribute(name, new THREE.BufferAttribute(dst, src.itemSize, src.normalized));
  }
  out.setIndex(new THREE.BufferAttribute(newIndex, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  // Its own tree: bullets and the played-back tracers raycast this mesh, and
  // the parent's tree indexes triangles that are no longer here.
  out.boundsTree = new MeshBVH(out, { targetLeafSize: 8 });
  return { geometry: out, kept: keepTris.length / 3, total: triCount };
}

/**
 * A ported map, ready to be put in a scene.
 *
 * @param {object} data  the generated map data module (src/maps/<slug>MapData.js)
 * @returns {Promise<MapHandle>}
 */
export async function loadMeshMap(data) {
  if (!cache.has(data.id)) {
    cache.set(
      data.id,
      fetchMap(data).catch((e) => {
        // A failed load must not poison the cache: the next attempt should be
        // allowed to try the network again rather than replay the error.
        cache.delete(data.id);
        throw e;
      })
    );
  }
  const { geometry, collider, spawns } = await cache.get(data.id);
  return new MapHandle(data, geometry, collider, spawns);
}

/** One scenario's view of a cached map. */
export class MapHandle {
  constructor(data, geometry, collider, spawns) {
    this.data = data;
    this.collider = collider;
    this._spawns = spawns || data.spawns;
    // The geometry and its BVHs are shared with every other run of this map;
    // the MATERIAL is this handle's own, because the cover tint is a per-run
    // setting and writing it onto a shared one would recolour a scenario that
    // is not even on screen.
    this.material = mapMaterial();
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = `map:${data.id}`;
    // A million triangles in one mesh: culling it as a whole would only ever
    // cull all of it or none of it, and testing the bound costs more than the
    // answer is worth.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  get bounds() {
    return this.data.bounds;
  }

  /** Spawn list in the shape the scenarios' spawn picker wants, on the floor. */
  get spawns() {
    return this._spawns;
  }

  /** Where the world ends underneath, for a player who has fallen off it. */
  get floorY() {
    return this.data.bounds.minY - 2;
  }

  /**
   * The map as a BULLET sees it: the `trace` interface
   * shared/sim3d/penetration.js takes, over this map's hull.
   *
   * Built once and cached on the handle. `unitScale` is the whole of the
   * difference from the explorer's: the hull is in metres here and in Source
   * units there, and the tracer is asked its questions in Source units either
   * way.
   */
  get rayWorld() {
    if (this._rayWorld === undefined) {
      this._rayWorld = this.collider
        ? createRayWorld(this.collider, null, { unitScale: UNIT_M, Ray: THREE.Ray })
        : null;
    }
    return this._rayWorld;
  }

  /**
   * Draw only the slab of the map between `minX` and `maxX`, SOURCE units.
   *
   * For a gamemode that is played from one fixed spot. Everything outside the
   * slab is taken out of the vertex buffer, not hidden — see `sliceGeometryX`.
   * Collision is untouched: the hull is what stops the player and what a bullet
   * is solved against, it is traversed as a tree rather than walked, and a body
   * that could fall through the world outside the slab would be a worse bug
   * than the frames this saves.
   *
   * @returns {{kept: number, total: number}} triangles drawn, and before.
   */
  setRenderSliceX(minX, maxX) {
    const key = `${this.data.id}|${minX}|${maxX}`;
    let slice = sliceCache.get(key);
    if (!slice) {
      slice = sliceGeometryX(this.mesh.geometry, minX * UNIT_M, maxX * UNIT_M);
      sliceCache.set(key, slice);
    }
    this.mesh.geometry = slice.geometry;
    return { kept: slice.kept, total: slice.total };
  }

  /**
   * Recolour the map around the player's cover colour.
   *
   * Pass the colour from Settings; pass nothing to go back to the porter's own
   * greys. Safe to call every frame — it writes two uniforms and touches no
   * geometry — so a colour picker being dragged updates live.
   */
  setCoverTint(color) {
    const u = this.material.userData.coverUniforms;
    if (!u) return;
    if (!color) {
      u.uCoverTint.value.set(1, 1, 1);
      u.uCoverBand.value.set(RAMP_LO, RAMP_HI);
      return;
    }
    const { unit, lo, hi } = coverTintBand(color);
    u.uCoverTint.value.set(unit[0], unit[1], unit[2]);
    u.uCoverBand.value.set(lo, hi);
  }

  /** Take the map out of the scene WITHOUT disposing the shared geometry. */
  detach() {
    this.mesh.removeFromParent();
    this.material.dispose();
  }
}

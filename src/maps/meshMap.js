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
function mapMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1,
    metalness: 0
  });
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
    material: mapMaterial(),
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
  const { geometry, collider, material, spawns } = await cache.get(data.id);
  return new MapHandle(data, geometry, material, collider, spawns);
}

/** One scenario's view of a cached map. */
export class MapHandle {
  constructor(data, geometry, material, collider, spawns) {
    this.data = data;
    this.collider = collider;
    this._spawns = spawns || data.spawns;
    this.mesh = new THREE.Mesh(geometry, material);
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

  /** Take the map out of the scene WITHOUT disposing anything shared. */
  detach() {
    this.mesh.removeFromParent();
  }
}

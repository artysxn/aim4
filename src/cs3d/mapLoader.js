// ---------------------------------------------------------------------------
// src/cs3d/mapLoader.js
// Streams a map pack (scripts/cs3d-pack.mjs, v2) into a three.js scene:
//
//   1. manifest.json          materials, spawns, sun, group list (tiny)
//   2. phys.glb               collision mesh → BVH for walking, and a flat
//                             grey stand-in so the map is walkable at once
//   3. geo/gNN.glb, in order  meshopt geometry, biggest surfaces first, four
//                             fetches in flight; every tile goes into the
//                             BatchedMesh of its material
//   4. sky3d/gNN.glb          the 3D skybox, same shape, drawn ×16 about the
//                             sky camera
//   5. tex.bin + lightmap.webp   streamed by MaterialLibrary alongside
//
// One BatchedMesh per material is the whole performance story: one pipeline
// bind per material, one culled draw per tile, and the CPU no longer walks
// two thousand meshes a frame. Tiles are added as they arrive; the batch is
// sized up front from the manifest's per-material totals.
//
// Nothing here knows about Source axes: the pack is already in scene units.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MeshBVH } from 'three-mesh-bvh';
import { MaterialLibrary } from './materials.js';
import { decodeRgbeAdd, RGBE_BYTES } from '../../shared/cs3d/rgbe.js';

export const PACK_VERSION = 2;
const GEO_CONCURRENCY = 4;
/**
 * Tiles this close to the camera are drawn even when outside the view
 * frustum. The WebGPU backend renders the shadow pass with the visibility
 * the main camera computed (r169 never calls onBeforeShadow), so a wall
 * behind the player would otherwise stop casting the shadow that falls in
 * front of them. Cheap: these tiles are clipped after the vertex stage.
 */
const SHADOW_KEEP_RADIUS = 1800;

/** Where the packs live: VITE_CS3D_ASSET_BASE, else the API host's /api/cs3d. */
export function assetBase() {
  const explicit = import.meta.env?.VITE_CS3D_ASSET_BASE;
  if (explicit) return String(explicit).replace(/\/$/, '');
  return `${String(import.meta.env?.VITE_API_URL || '').replace(/\/$/, '')}/api/cs3d`;
}

/** Collision kinds a player body collides with (grenadeclip is for nades only). */
const WALK_SOLID = new Set(['solid', 'playerclip', 'sky', 'ladder', 'entity']);

/**
 * The map's baked light on a lattice: an ambient cube per cell, which is how
 * CS2 lights everything that moves. cs3d-pack resamples the game's own
 * `env_light_probe_volume` atlas into this (see bakeProbeGrid) because a
 * player cannot carry a per-vertex bake the way a crate can.
 *
 * Values are HDR, stored RGBE, in SCENE axis order (+x, −x, +y up, −y, +z, −z)
 * so nothing here converts frames. `sample` reads trilinearly — a body walking
 * a corridor should brighten smoothly at the door, not step at each cell.
 */
class ProbeGrid {
  constructor(meta, buffer) {
    this.min = meta.min;
    this.cell = meta.cell;
    this.dims = meta.dims;
    this.data = new Uint8Array(buffer);
    this.stride = 6 * RGBE_BYTES;
  }

  /**
   * The ambient cube at a scene-space point, into `out` (18 floats: six RGB
   * triples in the axis order above).
   */
  sample(x, y, z, out) {
    const [dx, dy, dz] = this.dims;
    const gx = Math.min(dx - 1, Math.max(0, (x - this.min[0]) / this.cell));
    const gy = Math.min(dy - 1, Math.max(0, (y - this.min[1]) / this.cell));
    const gz = Math.min(dz - 1, Math.max(0, (z - this.min[2]) / this.cell));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fy = gy - y0;
    const fz = gz - z0;
    for (let i = 0; i < 18; i++) out[i] = 0;
    const d = this.data;
    for (let k = 0; k < 8; k++) {
      const w = (k & 1 ? fx : 1 - fx) * (k & 2 ? fy : 1 - fy) * (k & 4 ? fz : 1 - fz);
      if (w <= 0) continue;
      const cx = Math.min(dx - 1, x0 + (k & 1 ? 1 : 0));
      const cy = Math.min(dy - 1, y0 + (k & 2 ? 1 : 0));
      const cz = Math.min(dz - 1, z0 + (k & 4 ? 1 : 0));
      let o = ((cz * dy + cy) * dx + cx) * this.stride;
      for (let c = 0; c < 6; c++, o += RGBE_BYTES) decodeRgbeAdd(d, o, w, out, c * 3);
    }
    return out;
  }
}

/**
 * Whether a material's per-tile tint is applied through a mask (per texel, via
 * COLOR_0.gba) rather than as a BatchedMesh instance colour over the whole
 * tile. True for a dedicated tint mask, for a mask on either blend layer, or
 * for a blend layer whose tint-mask brightness is below 1 without a texture:
 * every one of those needs the per-texel path. Must agree with the check in
 * MaterialLibrary._build, or the tint is applied twice or not at all.
 */
function tintIsMasked(m) {
  if (!m) return false;
  // csgo_environment applies its tint itself, per texel, with the game's own
  // luminance-preserving formula — always through COLOR_0.gba, whether or not a
  // mask texture exists, because "amount 0" and "g_bModelTint off" have to be
  // able to apply NO tint, which a BatchedMesh colour cannot express.
  if (m.envTint) return true;
  return m.tintMask !== undefined;
}

/** Positions of a (possibly quantized) mesh in world space as float32, plus a copied index. */
function worldFloatGeometry(mesh) {
  const src = mesh.geometry;
  const pos = src.getAttribute('position');
  const n = pos.count;
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  if (src.index) g.setIndex(src.index.clone());
  return g;
}

/** Concatenate position-only indexed geometries into one. */
function mergePositionGeometries(list) {
  let vCount = 0;
  let iCount = 0;
  for (const g of list) {
    vCount += g.getAttribute('position').count;
    iCount += g.index ? g.index.count : g.getAttribute('position').count;
  }
  const pos = new Float32Array(vCount * 3);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.getAttribute('position').array;
    pos.set(p, vo * 3);
    const c = g.getAttribute('position').count;
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
      io += src.length;
    } else {
      for (let i = 0; i < c; i++) idx[io + i] = vo + i;
      io += c;
    }
    vo += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/**
 * A pack tile as BatchedMesh wants it: one fixed attribute layout per
 * material regardless of how meshopt quantized this particular tile
 * (positions int16 with a node transform, UVs float or u16 depending on
 * range, ...). Positions are baked to world space so the instance matrix is
 * identity; normals stay 8-bit, lightmap UVs 16-bit, colours 8-bit.
 */
function normalizeTile(mesh, wantColor, tint, wantAmb) {
  const src = mesh.geometry;
  const n = src.getAttribute('position').count;
  const g = new THREE.BufferGeometry();

  const pos = src.getAttribute('position');
  const wp = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  const m = mesh.matrixWorld;
  for (let i = 0; i < n; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
    wp[i * 3] = v.x;
    wp[i * 3 + 1] = v.y;
    wp[i * 3 + 2] = v.z;
  }
  g.setAttribute('position', new THREE.BufferAttribute(wp, 3));

  // Normals: 4 × int8 (snorm8x4; WebGPU has no 3-wide 8-bit vertex format).
  const nrm = src.getAttribute('normal');
  const nb = new Int8Array(n * 4);
  if (nrm) {
    for (let i = 0; i < n; i++) {
      nb[i * 4] = Math.round(THREE.MathUtils.clamp(nrm.getX(i), -1, 1) * 127);
      nb[i * 4 + 1] = Math.round(THREE.MathUtils.clamp(nrm.getY(i), -1, 1) * 127);
      nb[i * 4 + 2] = Math.round(THREE.MathUtils.clamp(nrm.getZ(i), -1, 1) * 127);
    }
  } else {
    for (let i = 0; i < n; i++) nb[i * 4 + 1] = 127;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nb, 4, true));

  const uv0 = src.getAttribute('uv');
  const uf = new Float32Array(n * 2);
  if (uv0) {
    for (let i = 0; i < n; i++) {
      uf[i * 2] = uv0.getX(i);
      uf[i * 2 + 1] = uv0.getY(i);
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uf, 2));

  const uv1 = src.getAttribute('uv1');
  const u1 = new Uint16Array(n * 2);
  if (uv1) {
    for (let i = 0; i < n; i++) {
      u1[i * 2] = Math.round(THREE.MathUtils.clamp(uv1.getX(i), 0, 1) * 65535);
      u1[i * 2 + 1] = Math.round(THREE.MathUtils.clamp(uv1.getY(i), 0, 1) * 65535);
    }
  }
  g.setAttribute('uv1', new THREE.BufferAttribute(u1, 2, true));

  // COLOR_0 carries two unrelated things, neither of them a vertex colour:
  //   .r    the blend shaders' vertex paint
  //   .gba  this tile's instance tint, when the material masks it
  // The tint rides here rather than on the BatchedMesh's own colour because
  // three multiplies that into the fragment unconditionally, and a masked tint
  // has to be applied per texel (see MaterialLibrary._wireTintMask).
  if (wantColor) {
    const col = src.getAttribute('color');
    const cb = new Uint8Array(n * 4);
    const q = (v) => Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255);
    const tr = tint ? q(tint.r) : 255;
    const tg = tint ? q(tint.g) : 255;
    const tb = tint ? q(tint.b) : 255;
    for (let i = 0; i < n; i++) {
      cb[i * 4] = col ? q(col.getX(i)) : 0;
      cb[i * 4 + 1] = tr;
      cb[i * 4 + 2] = tg;
      cb[i * 4 + 3] = tb;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cb, 4, true));
  }

  // Baked probe irradiance, per vertex, for geometry with no lightmap chart.
  // Float rather than packed: it is HDR and this is the only thing lighting a
  // prop, so a byte's worth of banding would show.
  if (wantAmb) {
    const amb = src.getAttribute('_amb');
    const ab = new Float32Array(n * 3);
    if (amb) for (let i = 0; i < n; i++) { ab[i * 3] = amb.getX(i); ab[i * 3 + 1] = amb.getY(i); ab[i * 3 + 2] = amb.getZ(i); }
    g.setAttribute('_amb', new THREE.BufferAttribute(ab, 3));

    // Baked sun visibility, 1 = daylight. Charted geometry reads this from the
    // shadow-mask atlas; a prop has no chart, so it rides the vertex instead.
    // Missing (a pack from before the bake) means full sun, which is the old
    // behaviour rather than a black map.
    const svis = src.getAttribute('_sun');
    const sb = new Float32Array(n);
    if (svis) for (let i = 0; i < n; i++) sb[i] = svis.getX(i);
    else sb.fill(1);
    g.setAttribute('_sun', new THREE.BufferAttribute(sb, 1));
  }

  const idx = src.index;
  if (idx) {
    g.setIndex(new THREE.BufferAttribute(idx.array.slice(), 1));
  } else {
    const ia = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) ia[i] = i;
    g.setIndex(new THREE.BufferAttribute(ia, 1));
  }
  return g;
}

/**
 * World-space surface area of a normalized tile.
 *
 * The flat view (src/cs3d/fpsView.js) shades a material by how much of the map
 * it covers, and triangle count is not that number: Nuke's pipe material
 * carries 255k triangles strung around the level and covers less ground than
 * the handful that make the hangar floor. Area has to be measured, and here is
 * the only place it can be — `geom` holds this tile's positions already baked
 * to world space, and the caller disposes it immediately afterwards.
 *
 * ~3.7M triangles for Nuke, spread across 80 group loads, so no frame wears
 * more than a fraction of a millisecond of it.
 */
function surfaceArea(geom) {
  const p = geom.getAttribute('position').array;
  const idx = geom.index.array;
  let sum = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    sum += Math.sqrt(cx * cx + cy * cy + cz * cz);
  }
  return sum * 0.5;
}

/**
 * BatchedMesh whose per-tile culling keeps a radius of tiles around the
 * camera alive regardless of the frustum (see SHADOW_KEEP_RADIUS).
 */
class TileBatch extends THREE.BatchedMesh {
  constructor(maxInstances, maxVerts, maxIdx, material) {
    super(maxInstances, maxVerts, maxIdx, material);
    this.isTileBatch = true;
    this.keepRadius = SHADOW_KEEP_RADIUS;
    this._camPos = new THREE.Vector3();
    this._sph = new THREE.Sphere();
    this._mat = new THREE.Matrix4();
    this._frustum = new THREE.Frustum();
    this._proj = new THREE.Matrix4();
    // Front-to-back sorting is a per-frame sort of every tile for a modest
    // overdraw win; the culling is what matters here.
    this.sortObjects = false;
  }

  onBeforeRender(renderer, scene, camera, geometry, material) {
    if (!this.perObjectFrustumCulled || !this.castShadow) {
      return super.onBeforeRender(renderer, scene, camera, geometry, material);
    }
    const index = geometry.getIndex();
    const bytesPerElement = index === null ? 1 : index.array.BYTES_PER_ELEMENT;
    const drawInfo = this._drawInfo;
    const starts = this._multiDrawStarts;
    const counts = this._multiDrawCounts;
    const ranges = this._drawRanges;
    const indirect = this._indirectTexture.image.data;
    this._proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.matrixWorld);
    this._frustum.setFromProjectionMatrix(this._proj, renderer.coordinateSystem);
    this._camPos.setFromMatrixPosition(camera.matrixWorld);
    const r2 = this.keepRadius * this.keepRadius;
    let count = 0;
    for (let i = 0, l = drawInfo.length; i < l; i++) {
      const di = drawInfo[i];
      if (!di.visible || !di.active) continue;
      const gid = di.geometryIndex;
      this.getMatrixAt(i, this._mat);
      this.getBoundingSphereAt(gid, this._sph).applyMatrix4(this._mat);
      let keep = this._frustum.intersectsSphere(this._sph);
      if (!keep) {
        const d = this._sph.center.distanceToSquared(this._camPos);
        const reach = this.keepRadius + this._sph.radius;
        keep = d < reach * reach && d < r2 * 4;
      }
      if (keep) {
        const range = ranges[gid];
        starts[count] = range.start * bytesPerElement;
        counts[count] = range.count;
        indirect[count] = i;
        count++;
      }
    }
    this._indirectTexture.needsUpdate = true;
    this._multiDrawCount = count;
    this._visibilityChanged = false;
  }
}

export class MapPack {
  /**
   * @param {object} o
   * @param {string} o.slug
   * @param {THREE.Scene} o.scene
   * @param {THREE.WebGPURenderer} o.renderer
   * @param {(p: object) => void} [o.onProgress]
   * @param {(batch: THREE.BatchedMesh) => void} [o.onBatch]  called for every batch created
   * @param {(collider: object, placeholder: THREE.Mesh) => void} [o.onPhys]
   * @param {number} [o.lightmapIntensity]
   */
  constructor({ slug, scene, renderer, onProgress, onBatch, onPhys, onWorldChanged, lightmapIntensity }) {
    this.slug = slug;
    this.scene = scene;
    this.renderer = renderer;
    this.onProgress = onProgress || (() => {});
    this.onBatch = onBatch || (() => {});
    this.onPhys = onPhys || (() => {});
    // Tiles arrived or a material got its textures: anything cached off the
    // world (the shadow map) is stale.
    this.onWorldChanged = onWorldChanged || (() => {});
    this.lightmapIntensity = lightmapIntensity;
    /** {toSun, color, intensity} for the world's analytic sun; set by main before load(). */
    this.sun = null;
    this.base = `${assetBase()}/${slug}`;
    this.manifest = null;
    this.materials = null;
    this.world = new THREE.Group();
    this.world.name = 'world';
    this.sky3d = null; // Group, when the map has a 3D skybox
    this.batches = new Map(); // matId → TileBatch
    /** matId → world-space surface area, summed over its tiles (see surfaceArea). */
    this.matArea = new Map();
    /**
     * Every instance tint ever applied, as [batch, instanceId, colour].
     *
     * BatchedMesh multiplies its per-instance colour into every fragment
     * (three's NodeMaterial: `colorNode = batchColor.mul(colorNode)`), so the
     * flat view has to flatten these to white or its greys come out carrying
     * Dust 2's taxi yellow. Kept as a list rather than a snapshot of the colour
     * texture so a tile that streams in while the view is on still gets its
     * tint when the view is switched off.
     */
    this.tints = [];
    this.tintsOff = false;
    /**
     * Make every world batch receive the dynamic sun's shadows, including ones
     * created later. Lightmapped geometry normally does not — its shadows are
     * in the bake — but the flat view throws the bake away and needs them from
     * the shadow map instead.
     */
    this.forceReceiveShadow = false;
    this.placeholder = null;
    this.collider = null; // { geometry, bvh }
    /** The map's baked ambient on a lattice, for things that move. See ProbeGrid. */
    this.probeGrid = null;
    this.groupsLoaded = 0;
    this.groupsTotal = 0;
    this.bytesLoaded = 0;
    this.bytesTotal = 0;
    this.tileCount = 0;
    this.aborted = false;
    this.gltf = new GLTFLoader();
    this.gltf.setMeshoptDecoder(MeshoptDecoder);
    scene.add(this.world);
  }

  _progress(phase, extra = {}) {
    this.onProgress({
      phase,
      groupsLoaded: this.groupsLoaded,
      groupsTotal: this.groupsTotal,
      bytesLoaded: this.bytesLoaded,
      bytesTotal: this.bytesTotal,
      texLoaded: this.materials?.loadedTex || 0,
      texTotal: this.materials?.totalTex || 0,
      texBytesLoaded: this.materials?.bytesLoaded || 0,
      texBytesTotal: this.materials?.bytesTotal || 0,
      ...extra
    });
  }

  /** Fetch + parse the manifest only (callers that need sun/spawns before geometry). */
  async fetchManifest() {
    const res = await fetch(`${this.base}/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`No pack for "${this.slug}" (${res.status} from ${this.base}/manifest.json)`);
    return res.json();
  }

  /** @param {object} [preloaded] a manifest from fetchManifest(), to skip the second round trip */
  async load(preloaded) {
    const manifest = preloaded || (await this.fetchManifest());
    if (manifest.version !== PACK_VERSION) {
      throw new Error(`Pack "${this.slug}" is v${manifest.version}; this build reads v${PACK_VERSION}. Re-run cs3d-pack.`);
    }
    this.manifest = manifest;
    // Pack files are served immutable; the manifest's timestamp versions every URL
    // so a re-pack under the same names is never served from a stale cache.
    this.v = `?v=${encodeURIComponent(manifest.generated || String(manifest.version))}`;
    const skyGroups = manifest.sky3d?.groups || [];
    this.groupsTotal = manifest.groups.length + skyGroups.length;
    this.bytesTotal = [...manifest.groups, ...skyGroups].reduce((a, g) => a + (g.bytes || 0), 0);
    this.materials = new MaterialLibrary(manifest, this.base, this.renderer, this.v, {
      lightmapIntensity: this.lightmapIntensity,
      probeAmbient: !!manifest.probeAmbient
    });
    if (this.sun) this.materials.setSun(this.sun);
    if (this.skyAmbient) this.materials.setSkyAmbient(this.skyAmbient);
    this.materials.onProgress = () => this._progress('textures');
    this.materials.onMaterialReady = () => this.onWorldChanged();
    this._progress('manifest');

    if (manifest.sky3d) this._setupSky3d(manifest.sky3d);

    await this._loadPhys();
    this._progress('phys');
    // Small, and everything that moves waits on it: fetched before the tiles.
    if (manifest.probeGrid) {
      try {
        const res = await fetch(`${this.base}/${manifest.probeGrid.file}${this.v}`);
        if (res.ok) this.probeGrid = new ProbeGrid(manifest.probeGrid, await res.arrayBuffer());
      } catch (e) {
        console.warn('cs3d: probe grid unavailable, dynamic bodies fall back to the sky probe', e);
      }
    }
    // Textures start right away: the bundle is one connection and the
    // geometry fetches are a few more; both stream side by side.
    this.materials.streamAll();
    const jobs = [
      ...manifest.groups.map((g) => ({ g, root: this.world })),
      ...skyGroups.map((g) => ({ g, root: this.sky3d, sky: true }))
    ];
    await this._loadGroups(jobs);
    this._progress('geometry');
    return this;
  }

  _setupSky3d(s) {
    // world = (v - camOrigin) * scale + refOrigin, all in scene units.
    const g = new THREE.Group();
    g.name = 'sky3d';
    const k = s.scale || 16;
    g.scale.setScalar(k);
    g.position.set(
      (s.refOrigin?.[0] || 0) - (s.camOrigin?.[0] || 0) * k,
      (s.refOrigin?.[1] || 0) - (s.camOrigin?.[1] || 0) * k,
      (s.refOrigin?.[2] || 0) - (s.camOrigin?.[2] || 0) * k
    );
    g.updateMatrixWorld(true);
    this.sky3d = g;
    this.scene.add(g);
  }

  async _fetchGlb(url) {
    const res = await fetch(url + this.v);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const buf = await res.arrayBuffer();
    return new Promise((resolve, reject) => this.gltf.parse(buf, '', resolve, reject));
  }

  async _loadPhys() {
    const gltf = await this._fetchGlb(`${this.base}/${this.manifest.phys || 'phys.glb'}`);
    gltf.scene.updateMatrixWorld(true);
    const solid = [];
    const kinds = {};
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const kind = o.userData?.kind || 'solid';
      kinds[kind] = (kinds[kind] || 0) + 1;
      if (WALK_SOLID.has(kind)) solid.push(worldFloatGeometry(o));
    });
    if (!solid.length) return;
    const merged = mergePositionGeometries(solid);
    for (const g of solid) g.dispose();
    const bvh = new MeshBVH(merged, { targetLeafSize: 8 });
    merged.boundsTree = bvh;
    this.collider = { geometry: merged, bvh, kinds };
    // Stand-in world: flat grey collision geometry until real surfaces arrive.
    const ph = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: 0x6b6b6b, flatShading: true }));
    ph.name = 'phys-placeholder';
    ph.frustumCulled = true;
    this.placeholder = ph;
    this.world.add(ph);
    this.onPhys(this.collider, ph);
  }

  async _loadGroups(jobs) {
    let next = 0;
    let firstDone = false;
    const worker = async () => {
      while (next < jobs.length && !this.aborted) {
        const job = jobs[next++];
        try {
          const gltf = await this._fetchGlb(`${this.base}/${job.g.file}`);
          this._addGroup(gltf, job);
        } catch (e) {
          console.warn(`cs3d: group ${job.g.file} failed`, e);
        }
        this.groupsLoaded++;
        this.bytesLoaded += job.g.bytes || 0;
        // The first group is the map's big surfaces; the grey stand-in has done its job.
        if (!firstDone && this.placeholder && !job.sky) {
          firstDone = true;
          this.placeholder.visible = false;
        }
        this._progress('geometry');
      }
    };
    await Promise.all(Array.from({ length: GEO_CONCURRENCY }, worker));
  }

  /** The batch for a material id, created on first use from the manifest's totals. */
  _batchFor(id, root) {
    const key = root === this.sky3d ? `s${id}` : id;
    let b = this.batches.get(key);
    if (b) return b;
    const m = this.manifest.materials[id];
    if (!m) return null;
    const verts = Math.max(3, m.verts || 3);
    const idx = Math.max(3, m.idx || verts);
    const tiles = Math.max(1, m.tiles || 1);
    b = new TileBatch(tiles, verts, idx, this.materials.get(id));
    b.name = `batch:m${id}`;
    b.userData.matId = id;
    // Per-tile colours from the start, so the shader is built with the batch
    // colour in it; creating the texture on the first tinted tile after the
    // first frame would need a recompile the node material does not notice.
    b._initColorsTexture();
    b.perObjectFrustumCulled = true;
    b.frustumCulled = false; // per-tile culling covers it; the whole-batch sphere is the map
    const decal = !!m.decal;
    // The world's own shadows are baked into its lightmap, so lightmapped
    // geometry never *receives* the dynamic sun; it still *casts*, so a prop
    // standing in an alley is shaded by the walls the way its floor is.
    b.castShadow = !decal && m.alphaMode !== 'BLEND' && root !== this.sky3d;
    b.receiveShadow = (this.forceReceiveShadow || !m.lightmapped) && root !== this.sky3d;
    if (decal) b.renderOrder = 1;
    if (root === this.sky3d) {
      // The skybox is scenery: no shadows either way, drawn first.
      b.renderOrder = -2;
      b.keepRadius = 0;
    }
    this.materials.bind(id, b);
    this.batches.set(key, b);
    root.add(b);
    this.onBatch(b);
    return b;
  }

  _addGroup(gltf, job) {
    if (this.aborted) return;
    const root = job.root || this.world;
    gltf.scene.updateMatrixWorld(true);
    const meshes = [];
    gltf.scene.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });
    for (const o of meshes) {
      const id = MaterialLibrary.idOf(o);
      if (id < 0) continue;
      const m = this.manifest.materials[id];
      const batch = this._batchFor(id, root);
      if (!batch) continue;
      // A masked tint cannot go through BatchedMesh.setColorAt: three multiplies
      // that colour into every fragment of the tile. It goes into the tile's own
      // COLOR_0.gba instead, and the material applies it through the mask.
      const masked = tintIsMasked(m);
      const tileTint = o.material?.color || null;
      // `_amb`/`_sun` only for geometry the pack actually baked them onto. The
      // 3D skybox is excluded: it sits outside every probe volume, so the pack
      // skips it and asking here would fill zeros and black it out.
      const wantAmb = !m.lightmapped && !m.sky && !!this.manifest.probeAmbient;
      const geom = normalizeTile(o, !!m.blend || masked, masked ? tileTint : null, wantAmb);
      const need = geom.getAttribute('position').count;
      const needIdx = geom.index.count;
      // The manifest's totals are exact; addGeometry throwing means a stale
      // pack, and dropping the tile beats taking the page down.
      try {
        const gid = batch.addGeometry(geom, need, needIdx);
        const iid = batch.addInstance(gid);
        batch.setMatrixAt(iid, _IDENTITY);
        // The tile's own tint: VRF put each prop instance's rendercolor on
        // its glTF material's baseColorFactor, which GLTFLoader hands us as
        // material.color (linear). The pack merged those variants into one
        // material per vmat; the colour survives per tile. Masked materials
        // already carry it in COLOR_0.gba, and must not take it twice.
        if (!masked && tileTint && (tileTint.r !== 1 || tileTint.g !== 1 || tileTint.b !== 1)) {
          this.tints.push([batch, iid, tileTint.clone()]);
          if (!this.tintsOff) batch.setColorAt(iid, tileTint);
        }
        // The flat view's shading input. The 3D skybox is left out: the view
        // hides it, and its ×16 group scale is not in these positions anyway.
        if (!job.sky) this.matArea.set(id, (this.matArea.get(id) || 0) + surfaceArea(geom));
        this.tileCount++;
      } catch (e) {
        console.warn(`cs3d: tile for m${id} rejected`, e.message);
      }
      geom.dispose();
      o.geometry.dispose();
    }
    this.onWorldChanged();
  }

  /**
   * Turn every tile's instance tint on or off (see `this.tints`).
   *
   * Off means white, which is the identity for the multiply three bakes into
   * every batched material — so the flat view's greys stay grey.
   * @param {boolean} on
   */
  setTintsEnabled(on) {
    this.tintsOff = !on;
    for (const [batch, iid, color] of this.tints) batch.setColorAt(iid, on ? color : _WHITE);
  }

  /** Spawn list for a side, or the other side if that one is empty. */
  spawns(side) {
    const s = this.manifest?.spawns || {};
    return (s[side] && s[side].length ? s[side] : s[side === 'T' ? 'CT' : 'T']) || [];
  }

  /**
   * What the ray hits, and everything known about it.
   *
   * The renderer draws the world as one BatchedMesh per pack material, so a hit
   * gives three separate layers of truth worth reporting side by side: the
   * manifest row (what the vmat said), the live three material (what was
   * actually built from it, which differs while textures are still streaming),
   * and the tile itself (its instance tint, which is per tile and not on the
   * material at all).
   *
   * @param {THREE.Raycaster} raycaster
   * @returns {object|null}
   */
  pick(raycaster) {
    const roots = [];
    if (this.world) roots.push(this.world);
    if (this.sky3d) roots.push(this.sky3d);
    if (!roots.length) return null;
    const hits = raycaster.intersectObjects(roots, true);
    const hit = hits.find((h) => h.object && h.object.visible !== false);
    if (!hit) return null;
    const obj = hit.object;
    const id = MaterialLibrary.idOf(obj);
    const m = (this.manifest?.materials || [])[id] || null;
    const live = this.materials?.get(id) || null;
    const dir = this.manifest?.tex?.dir || [];

    // The tile's instance tint. Masked materials carry it in COLOR_0.gba (the
    // material applies it through the tint mask); everything else has it as the
    // BatchedMesh instance colour.
    let tileTint = null;
    let paint = null;
    let tintFrom = null;
    const attr = obj.geometry?.getAttribute?.('color');
    if (attr && hit.face) {
      paint = attr.getX(hit.face.a);
      if (m && tintIsMasked(m)) {
        tileTint = [attr.getY(hit.face.a), attr.getZ(hit.face.a), attr.getW(hit.face.a)];
        tintFrom = 'COLOR_0.gba (masked)';
      }
    }
    if (!tileTint && obj.isBatchedMesh && hit.batchId !== undefined && obj._colorsTexture) {
      try {
        const c = new THREE.Color();
        obj.getColorAt(hit.batchId, c);
        tileTint = [c.r, c.g, c.b];
        tintFrom = 'BatchedMesh instance colour';
      } catch {
        /* no instance colour on this batch */
      }
    }

    const tex = (i) => {
      if (i === undefined || i === null) return null;
      const e = dir[i];
      return { index: i, ...(e ? { w: e.w, h: e.h, kind: e.kind, bytes: e.len, avg: e.avg } : {}) };
    };
    const isSky = !!(this.sky3d && (obj === this.sky3d || obj.parent === this.sky3d));
    const name = String(m?.name || '');
    return {
      hit: {
        distance: hit.distance,
        point: [hit.point.x, hit.point.y, hit.point.z],
        batchId: hit.batchId ?? null,
        uv: hit.uv ? [hit.uv.x, hit.uv.y] : null,
        object: obj.name || obj.type
      },
      // What kind of thing this is, as far as the pack can tell. VRF paths are
      // the only reliable signal: models/ is a prop, everything else is world
      // brushwork. `#props` is the pack's own split of a vmat shared between
      // the two (see splitByLightmapChart).
      kind: {
        source: isSky ? '3D skybox' : /\/models\//.test(name) ? 'prop model' : 'world brush',
        propsTwin: /#props$/.test(name),
        placeholder: obj.name === 'phys-placeholder',
        interim: !!live?.userData?.interim
      },
      id,
      manifest: m,
      live: live
        ? {
            type: live.type,
            color: live.color ? [live.color.r, live.color.g, live.color.b] : null,
            roughness: live.roughness,
            metalness: live.metalness,
            opacity: live.opacity,
            transparent: live.transparent,
            alphaTest: live.alphaTest,
            side: live.side === THREE.DoubleSide ? 'double' : live.side === THREE.BackSide ? 'back' : 'front',
            depthWrite: live.depthWrite,
            maps: {
              map: !!live.map,
              normalMap: !!live.normalMap,
              roughnessMap: !!live.roughnessMap,
              metalnessMap: !!live.metalnessMap,
              aoMap: !!live.aoMap
            },
            nodes: {
              colorNode: !!live.colorNode,
              normalNode: !!live.normalNode,
              emissiveNode: !!live.emissiveNode,
              lightsDisabled: !!live.lightsNode
            }
          }
        : null,
      textures: m
        ? {
            base: tex(m.base),
            normal: tex(m.normal),
            orm: tex(m.orm),
            tintMask: tex(m.tintMask),
            emissiveMask: tex(m.emissiveMask),
            blendBase: tex(m.blend?.base),
            blendNormal: tex(m.blend?.normal),
            blendMod: tex(m.blend?.mod),
            blendHeights: tex(m.blend?.heights)
          }
        : null,
      tile: { tint: tileTint, tintFrom, blendPaint: paint }
    };
  }

  dispose() {
    this.aborted = true;
    this.scene.remove(this.world);
    if (this.sky3d) this.scene.remove(this.sky3d);
    for (const b of this.batches.values()) b.dispose();
    this.materials?.dispose();
    this.collider?.geometry.dispose();
  }
}

const _IDENTITY = new THREE.Matrix4();
const _WHITE = new THREE.Color(1, 1, 1);

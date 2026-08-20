// ---------------------------------------------------------------------------
// src/cs3d/interactives.js
// The doors, vents and glass, in the world: the body around the state machine
// in shared/sim3d/interactives.js.
//
// The geometry comes from `interactives.glb`, which
// scripts/cs3d-split-interactives.mjs cut out of the packed world groups
// precisely so it could live here instead. One node per interactive, its
// vertices expressed relative to the entity origin, so the node sits at the
// origin and a door rotates about it — which for a `prop_door_rotating` is its
// hinge.
//
// Everything else in the map is drawn through a BatchedMesh per material, and
// these are not. That is deliberate: a batch instance can be hidden but its
// per-instance matrix is the wrong tool for a hinge, and the whole point of
// cutting these out was to get a transform per object. Nuke ends up with 21
// extra draws for 6064 triangles, which is nothing against the map's 3.7M.
//
// Three things have to agree for a door to work, and all three are here:
//
//   the drawing      this file, `group.rotation.y = poseAngle(o)` — the POSE,
//                    not the swing: a Source map bakes its doors open, so a
//                    shut door is the leaf turned all the way back
//   the collision    the leaf's static hull is masked OUT of the map's BVH at
//                    load and re-supplied as a swinging box (`movers`), so an
//                    open door is genuinely walk-through and a closed one is
//                    genuinely solid
//   the state        shared/sim3d/interactives.js, ticked from the frame loop
//
// A breakable is simpler: its hull is already one node in phys.glb, so
// breaking it is `mask.fill(1, start, end)` plus hiding the mesh.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { packFetch, packFetchOk } from './packFetch.js';
import { positionGeometry, step, uniform, vec2 } from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MaterialLibrary } from './materials.js';
import { normalizeTile, tintIsMasked } from './mapLoader.js';
import {
  createInteractive,
  linkDoors,
  stepInteractive,
  poseAngle,
  toggleDoor,
  applyBlast,
  applyDamage,
  grenadeThrough,
  openDoor,
  carveDoor,
  holeRadius,
  inHole,
  boxTriangles,
  boxBounds,
  USE_RANGE,
  DOOR_LEAF_RADIUS,
  DOOR
} from '../../shared/sim3d/interactives.js';

const DEG2RAD = Math.PI / 180;

/** How close an entity origin has to be to a collision hull to be the same thing. */
const HULL_MATCH = 96;


export class Interactives {
  /**
   * @param {object} o
   * @param {() => object|null} o.getPack     the MapPack, for materials and the manifest
   * @param {() => void} [o.onWorldChanged]   something moved or vanished; shadows are stale
   */
  constructor({ getPack, onWorldChanged } = {}) {
    this.getPack = getPack || (() => null);
    this.onWorldChanged = onWorldChanged || (() => {});
    this.root = new THREE.Group();
    this.root.name = 'interactives';
    /** The sim objects, in pack order. */
    this.list = [];
    /** id → { o, group } */
    this.bodies = new Map();
    this.collider = null;
    this.loaded = false;
    this._gltf = new GLTFLoader();
    this._gltf.setMeshoptDecoder(MeshoptDecoder);
    this._box = { min: [0, 0, 0], max: [0, 0, 0] };
    this._tris = [];
    /** Meshes still waiting for the pack's material library; see _loadGeometry. */
    this._unbound = [];
    /**
     * The moving collision the map's BVH cannot hold. Handed to
     * createHullWorld; see src/cs3d/hullWorld.js.
     */
    this.movers = {
      emit: (minX, minY, minZ, maxX, maxY, maxZ, visit) => this._emit(minX, minY, minZ, maxX, maxY, maxZ, visit),
      rayHit: (from, to) => this._rayHit(from, to)
    };
  }

  attach(parent) {
    if (parent && this.root.parent !== parent) parent.add(this.root);
  }

  get count() {
    return this.list.length;
  }

  /**
   * Load a map's interactives. Optional in every sense: a pack without the
   * file simply has none, and nothing else in the explorer changes.
   *
   * @param {string} base  the pack's asset base
   * @param {string} v     the cache-busting suffix MapPack uses
   */
  async load(base, v = '') {
    let doc = null;
    try {
      const res = await packFetch(`${base}/interactives.json${v}`);
      if (!res.ok) return false;
      doc = await res.json();
    } catch {
      return false;
    }
    if (!doc?.interactives?.length) return false;
    this.list = linkDoors(
      doc.interactives.filter((r) => r.role === 'door' || r.role === 'breakable').map(createInteractive)
    );
    for (const o of this.list) this.bodies.set(o.id, { o, group: null });
    // The state machine is useful on its own (a blast still opens a door with
    // nothing drawn), so a missing .glb is not a failure.
    if (doc.geometry?.file) {
      try {
        await this._loadGeometry(`${base}/${doc.geometry.file}${v}`);
      } catch (e) {
        console.warn('cs3d: interactives geometry failed', e);
      }
    }
    this.loaded = true;
    // The collider may have arrived first.
    if (this.collider) this._bindCollision();
    return true;
  }

  async _loadGeometry(url) {
    const res = await packFetchOk(url, 'interactives geometry');
    const buf = await res.arrayBuffer();
    const gltf = await new Promise((resolve, reject) => this._gltf.parse(buf, '', resolve, reject));
    gltf.scene.updateMatrixWorld(true);
    const pack = this.getPack();
    const manifest = pack?.manifest || null;
    const materials = pack?.materials || null;
    for (const node of [...gltf.scene.children]) {
      const id = node.userData?.interactive;
      const body = id ? this.bodies.get(id) : null;
      if (!body) continue;
      const group = new THREE.Group();
      group.name = id;
      group.position.copy(node.position);
      // The node's own translation is the pivot, so the meshes under it have
      // to be read at the origin rather than in world space — normalizeTile
      // bakes matrixWorld into the positions and would otherwise apply the
      // offset twice.
      node.position.set(0, 0, 0);
      node.updateMatrixWorld(true);
      const meshes = [];
      node.traverse((o) => {
        if (o.isMesh) meshes.push(o);
      });
      for (const src of meshes) {
        const mid = MaterialLibrary.idOf(src);
        const m = mid >= 0 && manifest ? manifest.materials[mid] : null;
        const masked = tintIsMasked(m);
        const tint = src.material?.color || null;
        const wantAmb = !!m && !m.lightmapped && !m.sky && !!manifest?.probeAmbient;
        // Same attribute layout the world tiles get, for the same materials.
        const geom = m ? normalizeTile(src, !!m.blend || masked, masked ? tint : null, wantAmb) : src.geometry.clone();
        const mesh = new THREE.Mesh(geom, null);
        mesh.name = `${id}:m${mid}`;
        mesh.castShadow = !!m && !m.decal && m.alphaMode !== 'BLEND';
        // Lightmapped geometry carries its shadows in the bake, like the rest
        // of the map. A door that has swung takes its baked light with it,
        // which is the same compromise the game makes for a moving brush.
        mesh.receiveShadow = !m || !m.lightmapped;
        if (m?.decal) mesh.renderOrder = 1;
        if (materials && mid >= 0) materials.bind(mid, mesh);
        else {
          // The pack builds its MaterialLibrary in the synchronous prologue of
          // load(), so this only happens if the two ever land the other way
          // round. Stand in with grey and pick the real one up on a later
          // frame rather than leaving the door untextured for the session.
          mesh.material = new THREE.MeshLambertMaterial({ color: 0x8a8a8a });
          if (mid >= 0) this._unbound.push({ mesh, mid });
        }
        // An unmasked instance tint is a batch colour everywhere else in the
        // map; on a plain mesh there is nowhere to put it but the material,
        // which is shared. Masked tints already rode in on COLOR_0.gba.
        group.add(mesh);
        src.geometry.dispose();
      }
      // The spawn pose, which for a door is not zero (see poseAngle). Doing it
      // here matters: `update` only writes the rotation when the swing moves,
      // so a door that starts turned would otherwise never get it.
      if (body.o.role === 'door') group.rotation.y = poseAngle(body.o) * DEG2RAD;
      body.group = group;
      this.root.add(group);
    }
  }

  /**
   * The map's collision. Matches every interactive to the hull phys.glb
   * already had for it, and takes the door leaves out of the static world.
   */
  setCollider(collider) {
    this.collider = collider;
    if (this.loaded) this._bindCollision();
  }

  _bindCollision() {
    const c = this.collider;
    if (!c?.entities) return;
    // Breakables: phys.glb has one `kind: entity` node each, so the match is
    // by position and class and the payoff is an exact triangle range.
    const free = c.entities.filter((e) => !e.owner);
    for (const o of this.list) {
      if (o.role !== 'breakable' || o.tris) continue;
      let best = null;
      let bestD = HULL_MATCH;
      for (const e of free) {
        if (e.owner) continue;
        if (e.classname && o.class && e.classname !== o.class) continue;
        const cx = (e.box.min[0] + e.box.max[0]) / 2;
        const cy = (e.box.min[1] + e.box.max[1]) / 2;
        const cz = (e.box.min[2] + e.box.max[2]) / 2;
        const d = Math.hypot(cx - o.origin[0], cy - o.origin[1], cz - o.origin[2]);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      if (best) {
        best.owner = o.id;
        o.tris = [best.start, best.end];
        o.surface = best.surface;
      }
    }
    // Doors: no `kind: entity` hull — the game spawns a `prop_door_rotating`,
    // so VRF baked the leaf into `physics_group_metal` with the wall around
    // it. Mask out whatever sits inside the leaf's own box (measured on Nuke:
    // 6 to 19 triangles a door, which is a leaf hull and not a wall) and hand
    // the tracer a swinging box in its place.
    const doors = this.list.filter((o) => o.role === 'door' && o.bounds && !o.tris);
    if (doors.length) {
      for (const o of doors) o.tris = [];
      const masked = this._maskInside(doors);
      if (masked) this._bumpMask();
    }
    // Anything already broken when the collider arrived (it cannot be, today,
    // but the two can land in either order) takes effect now.
    for (const o of this.list) if (o.broken) this._applyBroken(o);
  }

  /**
   * Take every collision triangle inside a door leaf's closed box out of the
   * world, so the leaf can move on a mover instead. One pass over the whole
   * merged mesh for all the doors at once — 190k triangles on Nuke, and this
   * runs once when the collision arrives.
   *
   * @param {object[]} doors
   * @returns {number} how many triangles were masked
   */
  _maskInside(doors) {
    const c = this.collider;
    const pos = c.geometry.getAttribute('position');
    const idx = c.geometry.index;
    // A hair of slack, so a hull face flush with the leaf's own is included
    // rather than left behind as an invisible sliver of wall. Clamped to the
    // leaf radius so a bloated pack (Mirage static doors claimed onto a
    // swinging hinge) cannot punch a corridor-sized hole in collision.
    const boxes = doors.map((o) => {
      const ox = o.origin[0];
      const oy = o.origin[1];
      const oz = o.origin[2];
      const r = DOOR_LEAF_RADIUS;
      return {
        o,
        lo: [
          Math.max(o.bounds.min[0] + ox, ox - r) - 1,
          Math.max(o.bounds.min[1] + oy, oy - r) - 1,
          Math.max(o.bounds.min[2] + oz, oz - r) - 1
        ],
        hi: [
          Math.min(o.bounds.max[0] + ox, ox + r) + 1,
          Math.min(o.bounds.max[1] + oy, oy + r) + 1,
          Math.min(o.bounds.max[2] + oz, oz + r) + 1
        ]
      };
    });
    let n = 0;
    for (let t = 0; t < c.triangles; t++) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let k = 0; k < 3; k++) {
        const vi = idx.getX(t * 3 + k);
        sx += pos.getX(vi);
        sy += pos.getY(vi);
        sz += pos.getZ(vi);
      }
      // Scene → Source, on the centroid.
      const x = sx / 3;
      const y = -sz / 3;
      const z = sy / 3;
      for (const b of boxes) {
        if (x < b.lo[0] || x > b.hi[0] || y < b.lo[1] || y > b.hi[1] || z < b.lo[2] || z > b.hi[2]) continue;
        c.mask[t] = 1;
        b.o.tris.push(t);
        n++;
        break;
      }
    }
    return n;
  }

  _bumpMask() {
    if (this.collider) this.collider.maskVersion++;
  }

  /** Every mover's triangles that could touch this query box. */
  _emit(minX, minY, minZ, maxX, maxY, maxZ, visit) {
    for (const o of this.list) {
      if (o.role !== 'door' || !o.bounds || o.broken) continue;
      const b = boxBounds(o, this._box);
      if (!b) continue;
      if (b.max[0] < minX || b.min[0] > maxX || b.max[1] < minY || b.min[1] > maxY || b.max[2] < minZ || b.min[2] > maxZ)
        continue;
      const t = boxTriangles(o, this._tris);
      for (let i = 0; i < t.length; i += 9) {
        visit(t[i], t[i + 1], t[i + 2], t[i + 3], t[i + 4], t[i + 5], t[i + 6], t[i + 7], t[i + 8]);
      }
    }
  }

  /**
   * A bullet against the moving hulls, in the shape src/cs3d/rayWorld.js wants.
   * A door leaf is not in the BVH, so without this a shot goes through a shut
   * door as if it were not there.
   *
   * @param {{x,y,z}} from  Source frame
   * @param {{x,y,z}} to
   */
  _rayHit(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const far = Math.hypot(dx, dy, dz);
    if (!(far > 0)) return null;
    const dir = { x: dx / far, y: dy / far, z: dz / far };
    let best = null;
    let bestT = far;
    let bestLocal = null;
    for (const o of this.list) {
      if (o.role !== 'door' || !o.bounds || o.broken) continue;
      const t = this._rayBox(o, from, dir, bestT);
      if (t === null || t <= 0 || t >= bestT) continue;
      const at = { x: from.x + dir.x * t, y: from.y + dir.y * t, z: from.z + dir.z * t };
      const local = this._leafLocal(o, at);
      // Straight through the hole that has already been shot in it.
      if (inHole(o, local.u, local.v)) continue;
      bestT = t;
      best = o;
      bestLocal = local;
    }
    if (!best) return null;
    return {
      // Where on the leaf it landed, which is where the hole opens.
      local: bestLocal,
      interactive: best,
      point: { x: from.x + dir.x * bestT, y: from.y + dir.y * bestT, z: from.z + dir.z * bestT },
      // The leaf is a slab; the face normal is not worth solving for a
      // decal, and nothing downstream reflects off it.
      normal: { x: -dir.x, y: -dir.y, z: -dir.z },
      distance: bestT,
      triangle: -1,
      // A Nuke door is `metal_door_001_br`, and it stops bullets like one.
      surface: best.surface || 'metal'
    };
  }

  /**
   * Advance the doors and put the drawn geometry where the sim says it is.
   * @param {number} dt seconds
   */
  update(dt) {
    if (!this.list.length) return;
    if (this._unbound.length) {
      const materials = this.getPack()?.materials;
      if (materials) {
        for (const { mesh, mid } of this._unbound) materials.bind(mid, mesh);
        this._unbound.length = 0;
      }
    }
    // The material library owns every mesh it bound and will hand it a fresh
    // material when the textures land or the flat view toggles — which would
    // quietly fill in a door's hole. Put it back when that happens.
    for (const body of this.bodies.values()) {
      if (!body.hole) continue;
      // A previous carve that threw mid-clone left `hole` with no meshes, so
      // later shots never patched a material. Retry until one sticks.
      if (!body.hole.meshes.length && body.o) this._applyHole(body.o);
      for (const mesh of body.hole.meshes) {
        if (mesh.material && !mesh.material.name?.endsWith(':hole')) this._reapplyHole(body, mesh);
      }
    }
    let moved = false;
    for (const o of this.list) {
      if (o.role !== 'door') continue;
      const before = o.frac;
      stepInteractive(o, dt);
      if (o.frac === before) continue;
      moved = true;
      const body = this.bodies.get(o.id);
      // Source rotates about +z; the scene is y-up with z = −y, and the two
      // work out to the same sign about the scene's +y (shared/sim3d/units.js).
      if (body?.group) body.group.rotation.y = poseAngle(o) * DEG2RAD;
    }
    if (moved) this.onWorldChanged();
  }

  /**
   * `+E`: open or shut whatever the crosshair is on, if it is close enough.
   *
   * @param {{x,y,z}} eye  Source frame
   * @param {{x,y,z}} dir  unit, Source frame
   * @returns {object|null} what it used
   */
  use(eye, dir) {
    let best = null;
    let bestT = USE_RANGE;
    for (const o of this.list) {
      if (o.role !== 'door' || !o.bounds) continue;
      const t = this._rayBox(o, eye, dir, bestT);
      if (t !== null && t < bestT) {
        bestT = t;
        best = o;
      }
    }
    if (!best) return null;
    toggleDoor(best, eye);
    this.onWorldChanged();
    return best;
  }

  /**
   * Slab test against an interactive's box at its current pose. Returns the
   * distance along `dir`, or null.
   */
  _rayBox(o, eye, dir, maxT) {
    // The box is only rotated about z, so undoing that yaw puts the ray in a
    // frame where the box is axis-aligned and the test is three slabs.
    const a = o.role === 'door' ? -poseAngle(o) * DEG2RAD : 0;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    const ex = eye.x - o.origin[0];
    const ey = eye.y - o.origin[1];
    const px = ex * cs - ey * sn;
    const py = ex * sn + ey * cs;
    const pz = eye.z - o.origin[2];
    const dx = dir.x * cs - dir.y * sn;
    const dy = dir.x * sn + dir.y * cs;
    const dz = dir.z;
    const { min, max } = o.bounds;
    let t0 = 0;
    let t1 = maxT;
    const p = [px, py, pz];
    const d = [dx, dy, dz];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-8) {
        if (p[k] < min[k] || p[k] > max[k]) return null;
        continue;
      }
      let lo = (min[k] - p[k]) / d[k];
      let hi = (max[k] - p[k]) / d[k];
      if (lo > hi) {
        const s = lo;
        lo = hi;
        hi = s;
      }
      if (lo > t0) t0 = lo;
      if (hi < t1) t1 = hi;
      if (t0 > t1) return null;
    }
    return t0;
  }

  /**
   * One HE detonation. A breakable takes damage and a door takes a shove —
   * the same blast, two different behaviours, because a door has no prop_data
   * to damage. Fire is not routed here at all; see the sim's `applyFire`.
   *
   * @param {{x,y,z}} at   Source frame
   */
  blast(at, radius, damage) {
    if (!this.list.length) return null;
    const out = applyBlast(this.list, at, radius, damage);
    for (const o of out.broken) this._applyBroken(o);
    if (out.broken.length) this._bumpMask();
    if (out.broken.length || out.opened.length) this.onWorldChanged();
    return out;
  }

  /**
   * Damage from a bullet that landed on collision triangle `tri`.
   * @returns {object|null} what broke
   */
  hit(tri, amount, type = 'bullets', door = null, local = null) {
    // A door shot at is CARVED: the round opens a hole where it landed and the
    // hole grows with what has been put through it. The leaf never goes away.
    if (door) {
      if (!carveDoor(door, amount, local?.u ?? 0, local?.v ?? 0)) return null;
      this._applyHole(door);
      this.onWorldChanged();
      return door;
    }
    const o = this.ownerOf(tri);
    if (!o || !applyDamage(o, amount, type)) return null;
    this._applyBroken(o);
    this._bumpMask();
    this.onWorldChanged();
    return o;
  }

  /**
   * A world point on this leaf, in the leaf's own 2D: across it and up it.
   *
   * The mesh's vertices are already in this frame (scene-local to the entity
   * origin, x across and y up), so undoing the pose rotation is all it takes —
   * and it means the shader can compare against `positionGeometry.xy` with no
   * further conversion.
   */
  _leafLocal(o, point) {
    const a = (-poseAngle(o) * Math.PI) / 180;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    const dx = point.x - o.origin[0];
    const dy = point.y - o.origin[1];
    return { u: dx * cs - dy * sn, v: point.z - o.origin[2] };
  }

  /**
   * Cut the hole into what is drawn.
   *
   * The leaf gets its OWN material the first time it is shot, because the one
   * the library handed it is shared with every other surface on the map using
   * that vmat — carving the door by editing that would put a hole through half
   * of Nuke. The cut is an alpha test rather than transparency so it costs no
   * sorting and leaves a hard edge.
   */
  _applyHole(o) {
    const body = this.bodies.get(o.id);
    if (!body?.group) return;
    const r = holeRadius(o);
    if (!body.hole) {
      body.hole = { centre: uniform(new THREE.Vector2(0, 0)), radius: uniform(0), meshes: [] };
    }
    if (!body.hole.meshes.length) {
      const { centre, radius } = body.hole;
      for (const mesh of body.group.children) {
        if (!mesh.isMesh || !mesh.material) continue;
        mesh.material = this._holeMaterial(mesh.material, centre, radius);
        body.hole.meshes.push(mesh);
      }
    }
    body.hole.centre.value.set(o.hole.u, o.hole.v);
    body.hole.radius.value = r;
  }

  /** Re-cut a hole into a material the library just replaced. */
  _reapplyHole(body, mesh) {
    mesh.material = this._holeMaterial(mesh.material, body.hole.centre, body.hole.radius);
  }

  /**
   * A private copy of `src` with the hole cut in. The library material is
   * shared across every surface on that vmat, so the hole has to live on a
   * clone. Cloned `Cs3dMaterial`s keep their `cs3d` lighting config
   * (materials.js `copy`); without that, `clone()` threw and the leaf stayed
   * intact.
   */
  _holeMaterial(src, centre, radius) {
    const mat = src.clone();
    mat.name = `${src.name || 'm'}:hole`;
    // 1 outside the hole, 0 inside it.
    mat.opacityNode = step(radius, positionGeometry.xy.sub(centre).length());
    mat.alphaTest = 0.5;
    mat.transparent = false;
    mat.side = THREE.DoubleSide; // the far face of the leaf is visible now
    return mat;
  }

  /**
   * A grenade has just bounced at `pos`. If what it bounced off was breakable,
   * break it and hand back the velocity it should carry on with instead.
   *
   * Position rather than triangle index, because the hull tracer reports where
   * it stopped and not what it stopped on — and the breakables all have an
   * exact collision box out of phys.glb, so the lookup is a containment test
   * over seventeen boxes rather than anything cleverer.
   *
   * @param {{x,y,z}} pos    Source frame, where the bounce happened
   * @param {{x,y,z}} velIn  its velocity going in
   * @returns {{ o: object, vel: {x,y,z} }|null}
   */
  grenadeHit(pos, velIn) {
    for (const o of this.list) {
      if (o.role !== 'breakable' || o.broken || !o.phys) continue;
      const { min, max } = o.phys;
      // The grenade stops DIST_EPSILON short of the surface and has a 2-unit
      // radius, so the box needs a little room round it.
      const s = 6;
      if (pos.x < min[0] - s || pos.x > max[0] + s) continue;
      if (pos.y < min[1] - s || pos.y > max[1] + s) continue;
      if (pos.z < min[2] - s || pos.z > max[2] + s) continue;
      const vel = grenadeThrough(o, velIn);
      if (!vel) continue;
      this._applyBroken(o);
      this._bumpMask();
      this.onWorldChanged();
      return { o, vel };
    }
    return null;
  }

  /** Which interactive owns a collision triangle, if any. */
  ownerOf(tri) {
    for (const o of this.list) {
      if (!o.tris) continue;
      if (o.role === 'breakable') {
        if (tri >= o.tris[0] && tri < o.tris[1]) return o;
      } else if (o.tris.includes(tri)) return o;
    }
    return null;
  }

  _applyBroken(o) {
    const body = this.bodies.get(o.id);
    if (body?.group) body.group.visible = false;
    const c = this.collider;
    if (c && o.role === 'breakable' && o.tris) c.mask.fill(1, o.tris[0], o.tris[1]);
  }

  /**
   * Put a door fully open or fully shut this frame, no swing.
   * The 3D timeline viewer uses this so a seek lands on the pose the playhead
   * says, rather than animating from wherever the last tick left the leaf.
   */
  snapDoor(o, open, from = null) {
    if (!o || o.role !== 'door' || o.broken) return;
    if (open) {
      if (o.state !== DOOR.OPEN || o.frac !== 1) {
        openDoor(o, true, from);
        o.frac = 1;
        o.state = DOOR.OPEN;
        if (o.linked) {
          o.linked.frac = 1;
          o.linked.state = DOOR.OPEN;
        }
      }
    } else if (o.state !== DOOR.CLOSED || o.frac !== 0) {
      o.frac = 0;
      o.state = DOOR.CLOSED;
      if (o.linked) {
        o.linked.frac = 0;
        o.linked.state = DOOR.CLOSED;
      }
    }
    const pose = (obj) => {
      const body = this.bodies.get(obj.id);
      if (body?.group) body.group.rotation.y = poseAngle(obj) * DEG2RAD;
    };
    pose(o);
    if (o.linked) pose(o.linked);
  }

  /** Put every door shut and every breakable back — a respawn or a map reset. */
  reset() {
    const c = this.collider;
    for (const o of this.list) {
      if (o.role === 'door') {
        o.state = DOOR.CLOSED;
        o.frac = 0;
        o.hole = null;
        o.broken = false;
        o.brokenAt = null;
        o.health = o.maxHealth;
        const body = this.bodies.get(o.id);
        if (body?.group) {
          body.group.visible = true;
          body.group.rotation.y = poseAngle(o) * DEG2RAD;
        }
        if (body?.hole) body.hole.radius.value = 0;
      } else if (o.broken) {
        o.broken = false;
        o.brokenAt = null;
        o.health = o.maxHealth;
        const body = this.bodies.get(o.id);
        if (body?.group) body.group.visible = true;
        if (c && o.tris) c.mask.fill(0, o.tris[0], o.tris[1]);
      }
    }
    this._bumpMask();
    this.onWorldChanged();
  }

  dispose() {
    for (const { group } of this.bodies.values()) {
      if (!group) continue;
      group.traverse((o) => o.isMesh && o.geometry.dispose());
      group.removeFromParent();
    }
    this.bodies.clear();
    this.list.length = 0;
    this.root.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// scripts/gen-trainer-map.mjs
// Port a CS2 map out of the 3D explorer's pack and into the aim trainer, as
// geometry only.
//
//   node scripts/gen-trainer-map.mjs dust2
//   node scripts/gen-trainer-map.mjs dust2 --ratio 0.125   (8x instead of 4x)
//   node scripts/gen-trainer-map.mjs dust2 --maxerr 1      (looser, coarser)
//
// What comes across, and what does not:
//
//   across    the world geometry and the entity/prop geometry that sits in the
//             same groups, the authored collision hulls out of `phys.glb`, and
//             the spawn points.
//   NOT       every texture, the lightmap, the shadow mask, the probe grid, the
//             sky, the 3D skybox (its own node AND, on a map like Ancient whose
//             skybox is at world scale, the backdrop buildings sitting in the
//             world groups — see `isSkybox`), the sun and the map's post chain.
//             The trainer lights and shades its own arenas and would only have
//             to undo all of it.
//
// Shading. Every material collapses to one grey, by how much of the world it
// covers — the explorer's flat view (V), whose ramp lives in
// shared/cs3d/flatGreys.js so this file and that view cannot drift. The grey is
// then baked into COLOR_0 per vertex, which is the whole reason the output is
// ONE mesh with ONE material: shading per material would have meant ~350 draw
// calls of flat grey, and the greys are the only thing the split was carrying.
//
// Un-subdivision. CS2's map geometry is finely tessellated — dust2 is 4.5M
// triangles, most of them subdividing surfaces that are flat. The pass below
// welds the pack's split vertices back together and then collapses interior
// edges until a quarter of the triangles are left, which on this kind of
// geometry is reverse subdivision: a wall authored as a grid of quads goes back
// to the few quads that describe it, while a curved arch keeps enough to stay
// curved. `--ratio` sets the target and the run reports what it actually got,
// because the two differ — a target is not a promise when the error bound is
// what really decides — and what decides is an ABSOLUTE bound of a quarter of a
// Source unit, so no collapse can pull a thin wall shut (MAX_ERROR_UNITS).
//
// Output (public/maps/ported/<slug>/):
//   <slug>.glb          two meshes: `render` (POSITION/NORMAL/COLOR_0) and
//                       `collision` (POSITION), quantized + meshopt-compressed
//   ...and src/maps/<slug>MapData.js, the small stuff — spawns, bounds, extent
//   — as a plain JS module, the same shape deathmatchMapData.js has.
//
// Units. The pack is Source units, y-up, `three(x, y, z) = source(x, z, -y)`.
// The trainer is metres. Everything written out is metres; nothing else moves,
// so a manifest spawn lands where the manifest says it does.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import { MeshBVH } from 'three-mesh-bvh';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { isDetail, greyRamp, surfaceArea } from '../shared/cs3d/flatGreys.js';
import { UNIT_M } from '../shared/sim3d/units.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// ---- arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('-')) || 'dust2';
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
/** Target share of the triangles to KEEP. 0.25 is the 4x the port asks for. */
const RATIO = Number(flag('ratio', '0.25'));
/**
 * The hard cap on how far ANY vertex of the RENDER mesh may move, Source units.
 *
 * ABSOLUTE, not the relative bound meshoptimizer defaults to. The old setting
 * was 1% of the mesh's own extent, which is 64 units on dust2 — a bound that
 * permits moving a wall by a metre and a half is not a bound. Four units is
 * 10 cm, and on dust2 it reproduces the mesh the relative bound happened to
 * produce (measured: the same 1,038,237 triangles, byte for byte) while
 * actually promising something.
 *
 * Four and not tighter, because THIS mesh is not what decides a wallbang. The
 * collision hull is, and it has its own much tighter bound
 * (COLLIDE_ERROR_UNITS) plus a per-triangle surface table — thickness and
 * material, which is how CS2 charges a bullet. Buying render-mesh wall
 * thickness with triangles was paying twice for something the hull already
 * guarantees: at 2 u the port only reaches 2.8x on dust2 instead of 4.0x, for a
 * difference no bullet can observe.
 *
 * `--audit` measures both. Of Mirage's sampled thin-wall crossings the render
 * mesh keeps ~94% at 2 u and ~84% at 4 u; the shipped HULL keeps its wall
 * thicknesses to within a unit either way, which is the number that matters.
 */
const MAX_ERROR_UNITS = Number(flag('maxerr', '4'));
/** Run the thin-wall audit (two BVH builds and 6000 rays). Off by default. */
const AUDIT = argv.includes('--audit');
/**
 * The collision hull's own error bound, in Source units, and its target share.
 *
 * Half the render bound: a floor that moves is a floor you stand a centimetre
 * off, and unlike a wall's silhouette nobody can see it to forgive it. One unit
 * takes Inferno's hull from 2.7M triangles to 890k with the ground under 9,892
 * probes never moving more than 0.42 u and never disappearing. Two units gets
 * 538k and starts losing a probe, which is a hole; that is the shape of the
 * cliff, and one unit is the safe side of it.
 */
const COLLIDE_ERROR_UNITS = Number(flag('collerr', '1'));
const COLLIDE_RATIO = Number(flag('collratio', '0.2'));
/** Under this the hull is already cheap and is left exactly as authored. */
const COLLIDE_MIN_TRIS = 150000;
const PACK_DIR = path.resolve(flag('pack', path.join(root, 'server/data/cs3d/pack')), slug);
/**
 * Ported maps get their own directory, and it holds nothing else.
 *
 * `public/maps/` already carries the site's radar images and icons, which have
 * no business on the asset CDN. Keeping the ported geometry one level down
 * means `npm run maps:upload` can sync the whole directory without a per-map
 * filter to forget the next time a map is ported.
 */
const OUT_DIR = path.join(root, 'public', 'maps', 'ported', slug);

/**
 * The error bound is the real limit, not the ratio: meshoptimizer stops
 * collapsing when the next edge would cost more than this, so a map whose
 * geometry is already coarse simply comes back smaller than asked for. Flat
 * regions collapse at no cost and spend none of it; corners and silhouettes
 * cost, and so survive. See MAX_ERROR_UNITS for why it is absolute.
 */
const SIMPLIFY_FLAGS = ['ErrorAbsolute'];

/**
 * Weld tolerances. Positions come out of the pack quantized to int16 over a
 * group's box, so equal vertices are equal to well under a unit; a hundredth
 * merges the seam duplicates without merging anything real.
 *
 * Normals are part of the key so a hard edge stays hard — two coincident
 * vertices with different normals are two vertices. 0.02 is about 1.5 degrees.
 */
const WELD_POS = 0.01;
const WELD_NRM = 0.02;

/**
 * Material rows that belong to the 3D skybox rather than to the map.
 *
 * Two ways one shows up, and a map uses whichever suits it:
 *
 *   `sky: true`   the packer's own flag, set on everything it read out of the
 *                 `sky3d` node. Those materials are listed in the manifest but
 *                 no world group references them, so this catches nothing on
 *                 its own — it is here so a repack that DOES fold them in
 *                 cannot quietly put a cloud card in the trainer.
 *   the name      Ancient's 3D skybox has scale 1, which means the packer left
 *                 its buildings in the world groups: eight of them, 440k
 *                 triangles of `ancient_skybox/*` standing beyond the
 *                 playerclip out to x −4573. Real geometry, in the world list,
 *                 and still backdrop — the trainer is a place to shoot at bots
 *                 on a map, not a viewpoint on the horizon.
 *
 * The name test is deliberately narrow. `nuke_skylight`, `de_aztec/skylight`
 * and `window_opaque_1b_lit_sky` are all lit surfaces INSIDE their maps and
 * none of them says "skybox".
 */
const isSkybox = (m) => !!m.sky || /skybox/i.test(m.name || '');

/**
 * The three audiences the collision hull serves, and they are three different
 * sets. Mirrors WALK_SOLID / NADE_SOLID / LIGHT_SOLID in src/cs3d/mapLoader.js,
 * because the trainer now runs the same tracers over this hull that the
 * explorer runs over the pack's.
 *
 * `playerclip` is why this reads phys.glb at all rather than colliding against
 * the rendered mesh: it is the mapper's invisible wall around the parts of the
 * level that are scenery, and without it bots walk out into the skybox. A
 * GRENADE passes straight through it and is stopped by `grenadeclip` instead,
 * which is the exact opposite on both counts — so the hull is merged in BANDS
 * and each audience is a range of triangle indices into the whole:
 *
 *   [0,     light)  solid + entity            light, bullets, player, grenade
 *   [light, both)   walk n nade               (empty on these maps)
 *   [both,  walk)   sky + playerclip + ladder player
 *   [walk,  total)  grenadeclip               grenade
 *
 * A bullet is the audience this was all added for: it is stopped by what is
 * drawn and not by either clip, and what it hit decides whether it goes
 * THROUGH (shared/sim3d/penetration.js reads the surface name per triangle).
 */
const WALK_SOLID = new Set(['solid', 'playerclip', 'sky', 'ladder', 'entity']);
const NADE_SOLID = new Set(['solid', 'grenadeclip', 'sky', 'entity']);
const LIGHT_SOLID = new Set(['solid', 'entity']);

// ---- reading the pack -------------------------------------------------------

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

function readGlb(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => loader.parse(ab, '', res, rej));
}

/** Every mesh in a glb, with its world matrix already resolved. */
function meshesOf(gltf) {
  gltf.scene.updateMatrixWorld(true);
  const out = [];
  gltf.scene.traverse((o) => {
    if (o.isMesh) out.push(o);
  });
  return out;
}

/** The manifest material id a pack mesh belongs to (`m294` → 294). */
function materialIdOf(mesh) {
  const m = /^m(\d+)$/.exec(mesh.material?.name || mesh.name || '');
  return m ? Number(m[1]) : -1;
}

/**
 * A mesh's positions and normals in world space, plus a plain index.
 *
 * The pack stores tiles quantized with a compensating node transform, so the
 * world matrix is doing real work here and not just placing a tile.
 */
function bakeWorld(mesh) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const n = pos.count;
  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
  const m = mesh.matrixWorld;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
    P[i * 3] = v.x;
    P[i * 3 + 1] = v.y;
    P[i * 3 + 2] = v.z;
    if (nrm) {
      v.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).applyMatrix3(nm).normalize();
      N[i * 3] = v.x;
      N[i * 3 + 1] = v.y;
      N[i * 3 + 2] = v.z;
    } else {
      N[i * 3 + 1] = 1;
    }
  }
  const idx = g.index
    ? Uint32Array.from(g.index.array)
    : Uint32Array.from({ length: n }, (_, i) => i);
  return { P, N, idx };
}

// ---- growable soup ----------------------------------------------------------

/**
 * Append-only vertex/index buffers.
 *
 * Written by hand rather than with arrays-of-arrays because the whole map is
 * 4.2M triangles and the concat at the end would double the peak.
 */
class Soup {
  constructor() {
    this.P = new Float32Array(1 << 20);
    this.N = new Float32Array(1 << 20);
    this.G = new Float32Array(1 << 18); // grey, 0..1
    this.I = new Uint32Array(1 << 20);
    this.vn = 0;
    this.tn = 0;
  }

  _grow(name, need, Type, stride) {
    let arr = this[name];
    if (need * stride <= arr.length) return arr;
    let len = arr.length;
    while (len < need * stride) len *= 2;
    const next = new Type(len);
    next.set(arr);
    this[name] = next;
    return next;
  }

  add({ P, N, idx }, grey01) {
    const n = P.length / 3;
    this._grow('P', this.vn + n, Float32Array, 3);
    this._grow('N', this.vn + n, Float32Array, 3);
    this._grow('G', this.vn + n, Float32Array, 1);
    this._grow('I', this.tn * 3 + idx.length, Uint32Array, 1);
    this.P.set(P, this.vn * 3);
    this.N.set(N, this.vn * 3);
    this.G.fill(grey01, this.vn, this.vn + n);
    for (let i = 0; i < idx.length; i++) this.I[this.tn * 3 + i] = idx[i] + this.vn;
    this.vn += n;
    this.tn += idx.length / 3;
  }

  trim() {
    return {
      P: this.P.subarray(0, this.vn * 3),
      N: this.N.subarray(0, this.vn * 3),
      G: this.G.subarray(0, this.vn),
      I: this.I.subarray(0, this.tn * 3)
    };
  }
}

/**
 * Merge coincident vertices.
 *
 * This is the step the simplifier cannot work without. The pack splits a vertex
 * at every UV, lightmap and normal seam, so a wall that looks like one welded
 * grid is really a pile of loose triangles as far as an edge collapse is
 * concerned — with nothing shared, there is no interior edge to collapse and
 * simplification does essentially nothing. Dropping the UVs is what makes the
 * weld possible: position, normal and grey are all that is left to match on.
 */
function weld({ P, N, G, I }) {
  const map = new Map();
  const remap = new Uint32Array(P.length / 3);
  const oP = new Float32Array(P.length);
  const oN = new Float32Array(N.length);
  const oG = new Float32Array(G.length);
  let out = 0;
  const qp = 1 / WELD_POS;
  const qn = 1 / WELD_NRM;
  for (let i = 0; i < remap.length; i++) {
    const key =
      `${Math.round(P[i * 3] * qp)},${Math.round(P[i * 3 + 1] * qp)},${Math.round(P[i * 3 + 2] * qp)},` +
      `${Math.round(N[i * 3] * qn)},${Math.round(N[i * 3 + 1] * qn)},${Math.round(N[i * 3 + 2] * qn)},` +
      `${Math.round(G[i] * 255)}`;
    let at = map.get(key);
    if (at === undefined) {
      at = out++;
      map.set(key, at);
      oP[at * 3] = P[i * 3];
      oP[at * 3 + 1] = P[i * 3 + 1];
      oP[at * 3 + 2] = P[i * 3 + 2];
      oN[at * 3] = N[i * 3];
      oN[at * 3 + 1] = N[i * 3 + 1];
      oN[at * 3 + 2] = N[i * 3 + 2];
      oG[at] = G[i];
    }
    remap[i] = at;
  }
  // Degenerate triangles are dropped: welding is exactly what creates them, and
  // a zero-area triangle is a NaN normal waiting to happen.
  const oI = new Uint32Array(I.length);
  let tn = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = remap[I[i]];
    const b = remap[I[i + 1]];
    const c = remap[I[i + 2]];
    if (a === b || b === c || a === c) continue;
    oI[tn++] = a;
    oI[tn++] = b;
    oI[tn++] = c;
  }
  return {
    P: oP.subarray(0, out * 3),
    N: oN.subarray(0, out * 3),
    G: oG.subarray(0, out),
    I: oI.subarray(0, tn)
  };
}

/** Drop vertices no triangle refers to, after a simplify. */
function compact({ P, N, G, I }) {
  const seen = new Int32Array(P.length / 3).fill(-1);
  const oI = new Uint32Array(I.length);
  let out = 0;
  for (let i = 0; i < I.length; i++) {
    const v = I[i];
    if (seen[v] < 0) seen[v] = out++;
    oI[i] = seen[v];
  }
  const oP = new Float32Array(out * 3);
  const oN = new Float32Array(out * 3);
  const oG = new Float32Array(out);
  for (let v = 0; v < seen.length; v++) {
    const at = seen[v];
    if (at < 0) continue;
    oP[at * 3] = P[v * 3];
    oP[at * 3 + 1] = P[v * 3 + 1];
    oP[at * 3 + 2] = P[v * 3 + 2];
    oN[at * 3] = N[v * 3];
    oN[at * 3 + 1] = N[v * 3 + 1];
    oN[at * 3 + 2] = N[v * 3 + 2];
    oG[at] = G[v];
  }
  return { P: oP, N: oN, G: oG, I: oI };
}

/** `compact` for a positions-only soup (the collision hull). */
function compactPositions(P, I) {
  const seen = new Int32Array(P.length / 3).fill(-1);
  const oI = new Uint32Array(I.length);
  let out = 0;
  for (let i = 0; i < I.length; i++) {
    const v = I[i];
    if (seen[v] < 0) seen[v] = out++;
    oI[i] = seen[v];
  }
  const oP = new Float32Array(out * 3);
  for (let v = 0; v < seen.length; v++) {
    const at = seen[v];
    if (at < 0) continue;
    oP[at * 3] = P[v * 3];
    oP[at * 3 + 1] = P[v * 3 + 1];
    oP[at * 3 + 2] = P[v * 3 + 2];
  }
  return { P: oP, I: oI };
}

// ---- the thin-wall audit ----------------------------------------------------
/**
 * Does a wall you can shoot through survive the un-subdivision?
 *
 * The error bound above is a promise about vertices; this is a measurement of
 * walls, because those are the thing anybody actually cares about. A wall is
 * two surfaces a few units apart facing away from each other, and the failure
 * mode of an edge collapse is that the rim between them goes and the two faces
 * become one sheet — a wall that is no longer thin, or no longer there.
 *
 * So: fire the same rays through the mesh before and after, pick out every
 * crossing that looks like a thin wall (an entry and an exit within
 * THIN_LIMIT units, facing opposite ways), and check the after-mesh still has
 * one within a unit of it. A crossing that has vanished, fused, or doubled in
 * thickness is reported.
 *
 * Rays are axis-aligned and seeded, so two runs of the same map compare the
 * same lines. Axis-aligned because CS2 walls are, so a diagonal ray measures a
 * hypotenuse and calls a 4-unit wall a 6-unit one.
 */
const THIN_LIMIT = 12; // u — thicker than this is a building, not a wall
const AUDIT_RAYS = 6000;

/** xorshift32, so an audit is repeatable. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function bvhOf({ P, I }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P.slice(), 3));
  g.setIndex(new THREE.BufferAttribute(I.slice(), 1));
  return new MeshBVH(g, { targetLeafSize: 8 });
}

/**
 * Every surface a ray crosses, in order, with the facing at each hit.
 * DoubleSide because a collision-free render soup is not consistently wound.
 */
function pierce(bvh, origin, dir, far) {
  const ray = new THREE.Ray(origin.clone(), dir.clone());
  const out = [];
  let t = 0;
  const target = new THREE.Vector3();
  for (let i = 0; i < 64 && t < far; i++) {
    ray.origin.copy(origin).addScaledVector(dir, t + 0.05);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit || hit.distance == null) break;
    t += hit.distance + 0.05;
    if (t > far) break;
    hit.face?.normal && target.copy(hit.face.normal);
    out.push({ t, nx: target.x, ny: target.y, nz: target.z, dot: target.dot(dir) });
  }
  return out;
}

/** Consecutive hits that face away from each other and are close together. */
function thinCrossings(hits) {
  const out = [];
  for (let i = 0; i + 1 < hits.length; i++) {
    const a = hits[i];
    const b = hits[i + 1];
    const t = b.t - a.t;
    if (t > THIN_LIMIT || t < 1e-3) continue;
    // In one side, out the other: the dots with the ray direction flip sign.
    if (a.dot * b.dot >= 0) continue;
    out.push({ at: a.t, thickness: t });
  }
  return out;
}

function auditThinWalls(before, after, bounds) {
  const bb = bvhOf(before);
  const ab = bvhOf(after);
  const min = new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]);
  const max = new THREE.Vector3(bounds.max[0], bounds.max[1], bounds.max[2]);
  const span = max.clone().sub(min);
  const far = Math.max(span.x, span.y, span.z) * 1.1;
  const rand = rng(0x5eed);
  const AXES = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 1)
  ];
  let found = 0;
  let kept = 0;
  let lost = 0;
  let fattened = 0;
  let worst = 0;
  for (let i = 0; i < AUDIT_RAYS; i++) {
    const dir = AXES[i % AXES.length];
    // Start on the min face of the axis being swept, at a random point over it.
    const o = new THREE.Vector3(
      dir.x ? min.x - 1 : min.x + rand() * span.x,
      min.y + rand() * span.y,
      dir.z ? min.z - 1 : min.z + rand() * span.z
    );
    const b4 = thinCrossings(pierce(bb, o, dir, far));
    if (!b4.length) continue;
    const now = thinCrossings(pierce(ab, o, dir, far));
    for (const c of b4) {
      found++;
      // The same wall, within a unit of where it was.
      const m = now.find((n) => Math.abs(n.at - c.at) <= 1.5);
      if (!m) {
        lost++;
        continue;
      }
      kept++;
      const grew = m.thickness - c.thickness;
      if (grew > worst) worst = grew;
      if (m.thickness > c.thickness * 1.5 + 0.5) fattened++;
    }
  }
  return { found, kept, lost, fattened, worst };
}

/**
 * Is the floor still where it was?
 *
 * The collision hull's one job is to hold a player up, so that is what gets
 * checked: drop rays through the map on a fixed seed, on the hull as authored
 * and on the simplified one, and compare. A ray that used to hit and now finds
 * nothing is a hole — the failure that matters, because it drops a player out
 * of the world — and it is counted separately from a floor that merely moved.
 */
function verifyGround(before, after, bounds) {
  const bb = bvhOf(before);
  const ab = bvhOf(after);
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  const rand = rng(0x9e37);
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  let probes = 0;
  let lost = 0;
  let worst = 0;
  let moved = 0;
  for (let i = 0; i < 20000; i++) {
    ray.origin.set(x0 + rand() * (x1 - x0), y1 + 1, z0 + rand() * (z1 - z0));
    ray.direction.set(0, -1, 0);
    const h1 = bb.raycastFirst(ray, THREE.DoubleSide);
    if (!h1) continue;
    probes++;
    const h2 = ab.raycastFirst(ray, THREE.DoubleSide);
    if (!h2) {
      lost++;
      continue;
    }
    const d = Math.abs(h1.distance - h2.distance);
    if (d > worst) worst = d;
    // A probe cannot move further than a vertex did unless it landed on an
    // EDGE — the top of a wall, the lip of a ledge — where a horizontal shift
    // of a unit swaps which surface is under the ray. Counting those apart
    // from the worst value is what separates "one probe fell off a kerb" from
    // "the floor moved", and it is the second number that would be a problem.
    if (d > COLLIDE_ERROR_UNITS) moved++;
  }
  return { probes, lost, worst, moved };
}

/**
 * Does the ported hull answer a WALLBANG the way the pack's does?
 *
 * The thin-wall audit above is about the render mesh and is a question about
 * pixels. This is the gameplay one, and it is the only measurement in the port
 * that reflects what CS2 actually does when a bullet meets a wall: walk a ray
 * in, find the far face, and see how thick the wall was. Run over the
 * un-simplified hull and the shipped one, on the same rays, and compare.
 *
 * Thickness is the number a bullet is charged by (`wallCost` divides it by the
 * surface's own penetration modifier), so a hull whose walls came out thicker
 * would quietly make everything harder to shoot through and a thinner one would
 * make everything easier. Both are wrong in a way nobody would ever see in a
 * screenshot.
 */
function auditWallbangs(before, after, bounds) {
  const bb = bvhOf(before);
  const ab = bvhOf(after);
  const min = new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]);
  const max = new THREE.Vector3(bounds.max[0], bounds.max[1], bounds.max[2]);
  const span = max.clone().sub(min);
  const far = Math.max(span.x, span.y, span.z) * 1.1;
  const rand = rng(0xb00b);
  const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
  const ray = new THREE.Ray();

  /** Thickness of the first wall a ray crosses, or null if it crosses none. */
  const firstWall = (bvh, o, dir) => {
    ray.origin.copy(o);
    ray.direction.copy(dir);
    const enter = bvh.raycastFirst(ray, THREE.DoubleSide, 0, far);
    if (!enter) return null;
    // Source's own method: step forward out of the solid, then trace back to
    // find the face the bullet came out of. Same 90-unit ceiling.
    const at = o.clone().addScaledVector(dir, enter.distance);
    for (let d = 4; d <= 90; d += 4) {
      const probe = at.clone().addScaledVector(dir, d);
      ray.origin.copy(probe);
      ray.direction.copy(dir).negate();
      const back = bvh.raycastFirst(ray, THREE.DoubleSide, 0, d);
      if (!back) continue;
      const thickness = d - back.distance;
      if (thickness <= 0.01) continue;
      return { at: enter.distance, thickness };
    }
    return null;
  };

  let found = 0;
  let kept = 0;
  let lost = 0;
  let changed = 0;
  let worst = 0;
  for (let i = 0; i < AUDIT_RAYS; i++) {
    const dir = AXES[i % AXES.length];
    const o = new THREE.Vector3(
      dir.x ? min.x - 1 : min.x + rand() * span.x,
      min.y + rand() * span.y,
      dir.z ? min.z - 1 : min.z + rand() * span.z
    );
    const a = firstWall(bb, o, dir);
    if (!a || a.thickness > 90) continue;
    found++;
    const b = firstWall(ab, o, dir);
    if (!b || Math.abs(b.at - a.at) > 2) {
      lost++;
      continue;
    }
    kept++;
    const d = Math.abs(b.thickness - a.thickness);
    if (d > worst) worst = d;
    // A unit either way is under the error bound and does not move a bullet
    // across a penetration threshold; more than that is worth knowing about.
    if (d > 1) changed++;
  }
  return { found, kept, lost, changed, worst };
}

// ---- writing ----------------------------------------------------------------

const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * One glb, two meshes.
 *
 * `render` carries the greys in COLOR_0; `collision` is positions and nothing
 * else. They ship together because they are always wanted together and a second
 * request buys nothing.
 */
function buildGlb(render, collide) {
  const doc = new Document();
  const buf = doc.createBuffer();
  const scene = doc.createScene();

  const acc = (data, type, comp = 5126, norm = false) =>
    doc.createAccessor().setArray(data).setType(type).setBuffer(buf).setNormalized(norm);

  const rp = doc.createPrimitive().setAttribute('POSITION', acc(render.P, 'VEC3'));
  rp.setAttribute('NORMAL', acc(render.N, 'VEC3'));
  // The greys, LINEAR and 16-bit, in COLOR_0.
  //
  // Linear because three colour-manages a material's `color` (sRGB in, linear
  // out) and does NOT colour-manage vertex colours — they are taken as already
  // being in the working space. Handing it the ramp's sRGB bytes renders the
  // whole map far too dark: mid grey would land at 0.26 instead of 0.5.
  //
  // 16-bit because the conversion crushes the dark end. The ramp's darkest
  // greys are 0x42 and 0x43, which differ by 0.0017 in linear — under half a
  // step of an 8-bit encoding — so the largest surfaces in the map, which are
  // most of any screenful, would band into each other. At 16 bits the 123
  // distinct greys stay 123 distinct greys, and since that is all the values
  // there are, the compressor gets it back to almost nothing.
  const rgb = new Uint16Array(render.G.length * 3);
  for (let i = 0; i < render.G.length; i++) {
    const c = Math.min(1, Math.max(0, render.G[i]));
    const lin = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const v = Math.round(lin * 65535);
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v;
    rgb[i * 3 + 2] = v;
  }
  rp.setAttribute('COLOR_0', acc(rgb, 'VEC3', 5123, true));
  rp.setIndices(acc(render.I, 'SCALAR'));
  const rmesh = doc.createMesh('render').addPrimitive(rp);
  scene.addChild(doc.createNode('render').setMesh(rmesh));

  const cp = doc.createPrimitive().setAttribute('POSITION', acc(collide.P, 'VEC3'));
  cp.setIndices(acc(collide.I, 'SCALAR'));
  const cmesh = doc.createMesh('collision').addPrimitive(cp);
  scene.addChild(doc.createNode('collision').setMesh(cmesh));

  return doc;
}

// ---- main -------------------------------------------------------------------

async function main() {
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;

  const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'manifest.json'), 'utf8'));
  const mats = new Map(manifest.materials.map((m) => [m.id, m]));
  console.log(
    `${slug}: ${manifest.stats.tris.toLocaleString()} triangles, ` +
      `${manifest.groups.length} groups, ${manifest.materials.length} materials`
  );

  // --- pass 1: read the world, measure every material's area -----------------
  // The greys need the area of the WHOLE map before a single triangle can be
  // coloured, and the geometry has to be read to measure it. So it is read
  // once and kept: 4.2M triangles of positions and normals is ~100 MB, which is
  // cheaper than reading 70 MB of glb twice.
  const area = new Map();
  const tiles = []; // { id, baked }
  let readTris = 0;
  let droppedDetail = 0;
  let droppedSky = 0;
  for (let i = 0; i < manifest.groups.length; i++) {
    const g = manifest.groups[i];
    const gltf = await readGlb(path.join(PACK_DIR, g.file));
    for (const mesh of meshesOf(gltf)) {
      const id = materialIdOf(mesh);
      const m = mats.get(id);
      if (!m) continue;
      const tris = (mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3;
      if (isSkybox(m)) {
        droppedSky += tris;
        continue;
      }
      // The same rule the flat view uses: a cut-out without its alpha is a
      // slab, so the fences, the railings and the decals do not come across.
      if (isDetail(m)) {
        droppedDetail += tris;
        continue;
      }
      const baked = bakeWorld(mesh);
      area.set(id, (area.get(id) || 0) + surfaceArea(baked.P, baked.idx));
      tiles.push({ id, baked });
      readTris += baked.idx.length / 3;
    }
    if ((i + 1) % 10 === 0 || i === manifest.groups.length - 1) {
      process.stdout.write(`\r  read ${i + 1}/${manifest.groups.length} groups, ${readTris.toLocaleString()} tris`);
    }
  }
  process.stdout.write('\n');
  console.log(`  dropped ${Math.round(droppedDetail).toLocaleString()} tris of decals / cut-outs / glass`);
  console.log(`  dropped ${Math.round(droppedSky).toLocaleString()} tris of skybox`);

  // --- the greys -------------------------------------------------------------
  const greys = greyRamp(manifest.materials, (id) => area.get(id) || 0);
  const used = [...new Set(tiles.map((t) => t.id))];
  const shades = new Set(used.map((id) => (greys.get(id) ?? 0) & 0xff));
  console.log(`  greys: ${shades.size} distinct over ${used.length} materials`);

  // --- one soup --------------------------------------------------------------
  const soup = new Soup();
  for (const t of tiles) {
    const hex = greys.get(t.id);
    if (hex == null) continue;
    soup.add(t.baked, (hex & 0xff) / 255);
  }
  tiles.length = 0;
  let mesh = soup.trim();
  const beforeV = mesh.P.length / 3;
  const beforeT = mesh.I.length / 3;

  mesh = weld(mesh);
  console.log(
    `  weld: ${beforeV.toLocaleString()} → ${(mesh.P.length / 3).toLocaleString()} verts ` +
      `(${beforeT.toLocaleString()} → ${(mesh.I.length / 3).toLocaleString()} tris)`
  );

  // --- un-subdivide ----------------------------------------------------------
  // Attribute-aware, and that is what keeps the greys honest. The normal is in
  // there so a collapse that would round off a hard corner is charged for it,
  // and the grey is in there — weighted hard — so an edge between two materials
  // is expensive to move. Locking those edges outright was the alternative and
  // it is worse: dust2's materials meet along most of its surfaces, and a
  // locked border there leaves the tessellation exactly where it was.
  const attrs = new Float32Array(mesh.P.length / 3 * 4);
  for (let i = 0; i < mesh.G.length; i++) {
    attrs[i * 4] = mesh.N[i * 3];
    attrs[i * 4 + 1] = mesh.N[i * 3 + 1];
    attrs[i * 4 + 2] = mesh.N[i * 3 + 2];
    attrs[i * 4 + 3] = mesh.G[i];
  }
  // The audit needs the mesh as it was; keep a copy only when it is asked for.
  const preSimplify = AUDIT ? { P: mesh.P.slice(), I: mesh.I.slice() } : null;
  const target = Math.floor((mesh.I.length / 3) * RATIO) * 3;
  const [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(
    mesh.I,
    mesh.P,
    3,
    attrs,
    4,
    [0.5, 0.5, 0.5, 8],
    null,
    target,
    MAX_ERROR_UNITS,
    SIMPLIFY_FLAGS
  );
  mesh = compact({ P: mesh.P, N: mesh.N, G: mesh.G, I: simplified });
  const afterT = mesh.I.length / 3;
  // `error` comes back in the same units the bound was given in, which with
  // ErrorAbsolute is Source units. Printed in centimetres too, because that is
  // the number to compare against a wall you care about keeping.
  console.log(
    `  un-subdivide: ${beforeT.toLocaleString()} → ${afterT.toLocaleString()} tris ` +
      `(${(beforeT / afterT).toFixed(2)}x, asked ${(1 / RATIO).toFixed(0)}x), ` +
      `worst vertex moved ${error.toFixed(3)} u (${(error * UNIT_M * 100).toFixed(2)} cm) ` +
      `of ${MAX_ERROR_UNITS} u allowed`
  );

  if (preSimplify) {
    const t0 = Date.now();
    const a = auditThinWalls(preSimplify, mesh, manifest.bounds);
    preSimplify.P = preSimplify.I = null;
    console.log(
      `  thin walls (<= ${THIN_LIMIT} u): ${a.found} crossings sampled, ` +
        `${a.kept} still there, ${a.lost} gone, ${a.fattened} thickened past 1.5x, ` +
        `worst +${a.worst.toFixed(2)} u — ${(Date.now() - t0) / 1000 | 0}s`
    );
  }

  // --- collision -------------------------------------------------------------
  // Merged in BANDS, one entry per phys mesh, so three things survive the port
  // that used to be thrown away: which audience a triangle belongs to, what
  // SURFACE it is, and whether the mapper flagged it as no obstacle to a bullet.
  // Those three are the whole of CS2's wallbang rule — thickness is measured
  // through the hull at runtime, the material comes out of the surface table,
  // and `physics_passbullets_*` is the mapper saying "this one is free".
  const physGltf = await readGlb(path.join(PACK_DIR, manifest.phys || 'phys.glb'));
  const kinds = {};
  const surfaces = [];
  const surfaceId = new Map();
  const bands = { light: [], both: [], walkOnly: [], nadeOnly: [] };
  for (const m of meshesOf(physGltf)) {
    const kind = m.userData?.kind || 'solid';
    kinds[kind] = (kinds[kind] || 0) + 1;
    const walk = WALK_SOLID.has(kind);
    const nade = NADE_SOLID.has(kind);
    if (!walk && !nade) continue;
    const surface = m.userData?.surface || 'default';
    if (!surfaceId.has(surface)) {
      surfaceId.set(surface, surfaces.length);
      surfaces.push(surface);
    }
    // `physics_passbullets_*`: brushes the mapper marked as no obstacle to a
    // bullet at all. Nuke has three of them (chainlink, metalgrate and one
    // unnamed set), and they are why shooting through those fences costs
    // nothing rather than costing what the surface table would charge.
    const entry = {
      baked: bakeWorld(m),
      kind,
      sid: surfaceId.get(surface),
      passBullets: /passbullets/i.test(m.name || '') ? 1 : 0
    };
    if (LIGHT_SOLID.has(kind)) bands.light.push(entry);
    else if (walk && nade) bands.both.push(entry);
    else if (walk) bands.walkOnly.push(entry);
    else bands.nadeOnly.push(entry);
  }
  const order = [...bands.light, ...bands.both, ...bands.walkOnly, ...bands.nadeOnly];

  /**
   * Each phys mesh is welded and un-subdivided ON ITS OWN, then concatenated.
   *
   * Not one pass over the whole soup, and the reason is the surface table. A
   * triangle's material is looked up by its index falling inside a range, so a
   * collapse that merged two brushes of different materials would leave a
   * triangle that is half concrete and half metal and an index that lies about
   * which. Per mesh, the ranges come out exact — and welding per mesh is more
   * correct anyway, since two brushes meeting at a face are two surfaces and
   * not one.
   *
   * No LockBorder here either. That flag protects the open edges of a mesh, and
   * a brush volume is closed — it has none. What it WOULD have done, once the
   * merge was per-map, is lock the seam between every pair of touching brushes,
   * which is most of the hull.
   */
  let physTris = 0;
  for (const e of order) physTris += e.baked.idx.length / 3;
  const doSimplify = COLLIDE_ERROR_UNITS > 0 && physTris > COLLIDE_MIN_TRIS;
  const cSoup = new Soup();
  const simpleSoup = new Soup(); // the un-simplified hull, for the audits
  const ranges = [];
  let worstCollideErr = 0;
  for (const e of order) {
    const oneWeld = weld({ P: e.baked.P, N: e.baked.N, G: new Float32Array(e.baked.P.length / 3), I: e.baked.idx });
    let piece = oneWeld;
    if (doSimplify) {
      const target = Math.floor((oneWeld.I.length / 3) * COLLIDE_RATIO) * 3;
      const [simp, err] = MeshoptSimplifier.simplify(
        Uint32Array.from(oneWeld.I),
        Float32Array.from(oneWeld.P),
        3,
        target,
        COLLIDE_ERROR_UNITS,
        ['ErrorAbsolute']
      );
      if (err > worstCollideErr) worstCollideErr = err;
      const c = compactPositions(oneWeld.P, simp);
      piece = { P: c.P, N: new Float32Array(c.P.length), G: new Float32Array(c.P.length / 3), I: c.I };
    }
    const start = cSoup.tn;
    cSoup.add({ P: piece.P, N: piece.N, idx: piece.I }, 0);
    ranges.push({ start, end: cSoup.tn, kind: e.kind, sid: e.sid, passBullets: e.passBullets });
    if (AUDIT) simpleSoup.add({ P: oneWeld.P, N: oneWeld.N, idx: oneWeld.I }, 0);
  }
  let collide = cSoup.trim();
  collide = { P: collide.P, I: collide.I };

  // The band boundaries, as triangle counts into the merged whole. Same four
  // bands src/cs3d/mapLoader.js builds, so src/cs3d/rayWorld.js and
  // src/cs3d/hullWorld.js read this hull exactly as they read the pack's.
  const bandEnd = (list) => {
    let n = 0;
    for (const e of ranges) if (list.includes(e.kind)) n += e.end - e.start;
    return n;
  };
  const tLight = bandEnd([...LIGHT_SOLID]);
  const tBoth = tLight + 0; // `both` is empty on every shipped map; kept for shape
  const tWalk = tBoth + ranges
    .filter((r) => WALK_SOLID.has(r.kind) && !LIGHT_SOLID.has(r.kind))
    .reduce((n, r) => n + (r.end - r.start), 0);
  const tAll = collide.I.length / 3;

  console.log(
    `  collision: ${tAll.toLocaleString()} tris of ` +
      `${manifest.stats.physTris.toLocaleString()} (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')})`
  );
  console.log(
    `  collision bands: light 0-${tLight.toLocaleString()}, walk ${tBoth.toLocaleString()}-${tWalk.toLocaleString()}, ` +
      `nade ${tWalk.toLocaleString()}-${tAll.toLocaleString()} | ` +
      `${surfaces.length} surfaces, ${ranges.filter((r) => r.passBullets).length} passbullets ranges`
  );
  if (doSimplify) {
    console.log(
      `  collision un-subdivide: ${physTris.toLocaleString()} → ${tAll.toLocaleString()} tris ` +
        `(${(physTris / tAll).toFixed(2)}x), worst vertex moved ${worstCollideErr.toFixed(3)} u`
    );
    if (AUDIT) {
      const raw = simpleSoup.trim();
      const before = { P: raw.P, I: raw.I };
      const g = verifyGround(before, collide, manifest.bounds);
      console.log(
        `  ground: ${g.probes.toLocaleString()} probes, ${g.lost} lost, ` +
          `${g.moved} moved over ${COLLIDE_ERROR_UNITS} u (edges), worst ${g.worst.toFixed(2)} u`
      );
      const w = auditWallbangs(before, collide, manifest.bounds);
      console.log(
        `  wallbangs: ${w.found} walls sampled, ${w.kept} still there, ${w.lost} gone, ` +
          `${w.changed} thickness moved over 1 u, worst ${w.worst.toFixed(2)} u`
      );
    }
  }

  // --- metres ----------------------------------------------------------------
  for (const m of [mesh, collide]) for (let i = 0; i < m.P.length; i++) m.P[i] *= UNIT_M;

  // --- write -----------------------------------------------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const doc = buildGlb(mesh, collide);
  // 14 bits over a 164 m map is a centimetre, which is finer than the pack's
  // own int16-per-group encoding and far finer than anything gameplay asks.
  // The bits go to `meshopt`, not to a `quantize` in front of it: meshopt runs
  // its own quantize pass with its own defaults, so a separate call is silently
  // overridden — which is how COLOR_0 came back 8-bit after being asked for 16.
  await doc.transform(
    meshopt({
      encoder: MeshoptEncoder,
      level: 'high',
      quantizePosition: 14,
      quantizeNormal: 8,
      quantizeColor: 16
    })
  );
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
    'meshopt.decoder': MeshoptDecoder
  });
  const glbPath = path.join(OUT_DIR, `${slug}.glb`);
  const glb = Buffer.from(await io.writeBinary(doc));
  fs.writeFileSync(glbPath, glb);
  const bytes = glb.length;
  /**
   * The cache key, and it is the CONTENT and not the clock.
   *
   * `npm run maps:upload` puts this file on the same bucket the 3D explorer's
   * packs use, where everything is `immutable, max-age=31536000` — so a re-port
   * that reused the URL would be invisible to anyone holding the old copy for
   * up to a year. A timestamp would fix that and would also change on every
   * re-run that produced identical bytes, throwing away a good cache. The hash
   * changes exactly when the map does.
   */
  const version = crypto.createHash('md5').update(glb).digest('hex').slice(0, 8);

  // --- the small stuff, as a JS module ---------------------------------------
  const spawns = [...(manifest.spawns?.T || []), ...(manifest.spawns?.CT || [])].map((s) => ({
    pos: [r3(s.pos[0] * UNIT_M), r3(s.pos[1] * UNIT_M), r3(s.pos[2] * UNIT_M)],
    yaw: r3(s.yaw || 0)
  }));
  const bmin = manifest.bounds.min.map((v) => r3(v * UNIT_M));
  const bmax = manifest.bounds.max.map((v) => r3(v * UNIT_M));
  const data = {
    id: slug,
    label: manifest.map?.name || slug,
    mesh: `/maps/ported/${slug}/${slug}.glb`,
    version,
    bounds: { minX: bmin[0], maxX: bmax[0], minY: bmin[1], maxY: bmax[1], minZ: bmin[2], maxZ: bmax[2] },
    spawns,
    tris: mesh.I.length / 3,
    collisionTris: collide.I.length / 3,
    /**
     * Everything a bullet needs to know about the hull, as index ranges.
     *
     * Not a per-triangle array, and that is the point: the hull is merged one
     * phys mesh at a time and a mesh has ONE surface and ONE passbullets flag,
     * so a few hundred half-open ranges say the same thing as a
     * quarter-million-entry table and cost two kilobytes of JS instead of a
     * second binary download. `src/maps/meshMap.js` expands them into the
     * `surfaceOf` / `passBullets` arrays src/cs3d/rayWorld.js already reads.
     *
     *   surfaces  the name table; the keys into shared/sim3d/surfaces.js
     *   bands     [start, end, surfaceIndex, passBullets] per phys mesh
     *   ranges    the audience bands (see WALK_SOLID in the porter)
     */
    collision: {
      triangles: collide.I.length / 3,
      surfaces,
      bands: ranges.map((r) => [r.start, r.end, r.sid, r.passBullets]),
      ranges: {
        light: [[0, tLight]],
        walk: [[0, tWalk]],
        nade: tWalk === tAll ? [[0, tBoth]] : [[0, tBoth], [tWalk, tAll]]
      }
    }
  };
  const out = `// AUTO-GENERATED by scripts/gen-trainer-map.mjs — do not edit by hand.
//   node scripts/gen-trainer-map.mjs ${slug} --ratio ${RATIO} --maxerr ${MAX_ERROR_UNITS}
//
// The mesh at \`mesh\` carries the map and its collision hull, shaded flat by
// material area (shared/cs3d/flatGreys.js). Metres, y-up.
//
// \`collision\` is what makes a wallbang possible: the surface under every
// triangle of the hull, and the audience bands, so shared/sim3d/penetration.js
// can charge a bullet by thickness AND material exactly as CS2 does.

export const ${slug.toUpperCase()}_MAP_DATA = ${JSON.stringify(data, null, 2)};
`;
  const dataPath = path.join(root, 'src', 'maps', `${slug}MapData.js`);
  fs.writeFileSync(dataPath, out);

  console.log(
    `\nwrote ${path.relative(root, glbPath)} — ${(bytes / 1e6).toFixed(2)} MB, v${version} ` +
      `(${afterT.toLocaleString()} render tris, ${(collide.I.length / 3).toLocaleString()} collision tris)`
  );
  console.log(
    `wrote ${path.relative(root, dataPath)} — ${spawns.length} spawns, ` +
      `${surfaces.length} surfaces, ${ranges.length} bands`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

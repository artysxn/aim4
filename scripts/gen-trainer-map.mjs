// ---------------------------------------------------------------------------
// scripts/gen-trainer-map.mjs
// Port a CS2 map out of the 3D explorer's pack and into the aim trainer, as
// geometry only.
//
//   node scripts/gen-trainer-map.mjs dust2
//   node scripts/gen-trainer-map.mjs dust2 --ratio 0.125   (8x instead of 4x)
//
// What comes across, and what does not:
//
//   across    the world geometry and the entity/prop geometry that sits in the
//             same groups, the authored collision hulls out of `phys.glb`, and
//             the spawn points.
//   NOT       every texture, the lightmap, the shadow mask, the probe grid, the
//             sky, the 3D skybox's own geometry, the sun and the map's post
//             chain. The trainer lights and shades its own arenas and would
//             only have to undo all of it.
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
// what really decides.
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
 * How far a vertex may move, as a fraction of the mesh's own extent.
 *
 * This is the real limit, not the ratio: meshoptimizer stops collapsing when
 * the next edge would cost more than this, so a map whose geometry is already
 * coarse simply comes back smaller than asked for. 1% of a 164 m map is 1.6 m,
 * which sounds enormous until you remember it is an upper bound on the WORST
 * collapse and the metric is quadric error — flat regions collapse for free and
 * spend none of it. Corners and silhouettes cost, and so survive.
 */
const TARGET_ERROR = 0.01;

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
 * Collision kinds the trainer's players are stopped by.
 *
 * `playerclip` is why this reads phys.glb at all rather than colliding against
 * the rendered mesh: it is the mapper's invisible wall around the parts of the
 * level that are scenery, and without it bots walk out into the skybox.
 * Mirrors WALK_SOLID in src/cs3d/mapLoader.js.
 */
const WALK_SOLID = new Set(['solid', 'playerclip', 'sky', 'ladder', 'entity']);

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
  for (let i = 0; i < manifest.groups.length; i++) {
    const g = manifest.groups[i];
    const gltf = await readGlb(path.join(PACK_DIR, g.file));
    for (const mesh of meshesOf(gltf)) {
      const id = materialIdOf(mesh);
      const m = mats.get(id);
      if (!m) continue;
      // The same rule the flat view uses: a cut-out without its alpha is a
      // slab, so the fences, the railings and the decals do not come across.
      if (isDetail(m)) {
        droppedDetail += (mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3;
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
    TARGET_ERROR,
    []
  );
  mesh = compact({ P: mesh.P, N: mesh.N, G: mesh.G, I: simplified });
  const afterT = mesh.I.length / 3;
  console.log(
    `  un-subdivide: ${beforeT.toLocaleString()} → ${afterT.toLocaleString()} tris ` +
      `(${(beforeT / afterT).toFixed(2)}x, asked ${(1 / RATIO).toFixed(0)}x), ` +
      `worst vertex moved ${(error * 100).toFixed(2)}% of the map`
  );

  // --- collision -------------------------------------------------------------
  const physGltf = await readGlb(path.join(PACK_DIR, manifest.phys || 'phys.glb'));
  const cSoup = new Soup();
  const kinds = {};
  for (const m of meshesOf(physGltf)) {
    const kind = m.userData?.kind || 'solid';
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (!WALK_SOLID.has(kind)) continue;
    cSoup.add(bakeWorld(m), 0);
  }
  let collide = weld(cSoup.trim());
  console.log(
    `  collision: ${(collide.I.length / 3).toLocaleString()} tris kept of ` +
      `${manifest.stats.physTris.toLocaleString()} (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')})`
  );

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
    collisionTris: collide.I.length / 3
  };
  const out = `// AUTO-GENERATED by scripts/gen-trainer-map.mjs — do not edit by hand.
//   node scripts/gen-trainer-map.mjs ${slug} --ratio ${RATIO}
//
// Geometry only: the mesh at \`mesh\` carries the map and its collision hull,
// shaded flat by material area (shared/cs3d/flatGreys.js). Metres, y-up.

export const ${slug.toUpperCase()}_MAP_DATA = ${JSON.stringify(data, null, 2)};
`;
  const dataPath = path.join(root, 'src', 'maps', `${slug}MapData.js`);
  fs.writeFileSync(dataPath, out);

  console.log(
    `\nwrote ${path.relative(root, glbPath)} — ${(bytes / 1e6).toFixed(2)} MB, v${version} ` +
      `(${afterT.toLocaleString()} render tris, ${(collide.I.length / 3).toLocaleString()} collision tris)`
  );
  console.log(`wrote ${path.relative(root, dataPath)} — ${spawns.length} spawns`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

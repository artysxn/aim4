// Run: node src/utils/MeshCollision.test.js
//
// The ported-map collision model, against the real dust2 the porter produced —
// public/maps/dust2/dust2.glb and the spawn list generated beside it.
//
// A browser is not needed for any of this and deliberately is not used: the
// collider is plain geometry and arithmetic, so the questions worth asking
// ("does the floor exist under every spawn", "can a body walk out of one",
// "does a wall stop a sightline") are all answerable here, once, on the actual
// shipped file rather than on a fixture that agrees with the code by
// construction.
//
// Skipped with a note when the map has not been built. Rebuild it with:
//   node scripts/gen-trainer-map.mjs dust2

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MeshCollider } from './MeshCollision.js';
import { bakeNodeTransform } from '../maps/quantizedGeometry.js';
import { GREY_SMALLEST, GREY_LARGEST } from '../../shared/cs3d/flatGreys.js';
import { BODY_R, STAND_EYE } from '../multiplayer/constants.js';

let failures = 0;
function assert(ok, msg) {
  if (ok) return;
  failures++;
  console.error('  FAIL:', msg);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
// `maps/ported/`, which is where gen-trainer-map.mjs has written since ported
// maps were given a directory of their own; this said `maps/dust2` and so the
// whole file skipped itself silently.
const GLB = path.join(root, 'public', 'maps', 'ported', 'dust2', 'dust2.glb');
const DATA = path.join(root, 'src', 'maps', 'dust2MapData.js');

if (!fs.existsSync(GLB) || !fs.existsSync(DATA)) {
  console.log('  (no ported dust2 on disk — run scripts/gen-trainer-map.mjs dust2)');
  console.log('MeshCollision.test: skipped');
  process.exit(0);
}

const { DUST2_MAP_DATA: data } = await import(`file://${DATA.replace(/\\/g, '/')}`);

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
await MeshoptDecoder.ready;
const buf = fs.readFileSync(GLB);
const gltf = await new Promise((res, rej) =>
  loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej)
);

let render = null;
let collision = null;
gltf.scene.updateMatrixWorld(true);
gltf.scene.traverse((o) => {
  if (!o.isMesh) return;
  if (o.name === 'collision' || o.parent?.name === 'collision') collision = o;
  else render = o;
});
assert(!!render, 'the glb carries a render mesh');
assert(!!collision, 'the glb carries a collision mesh');
// The loader's own step, not a copy of it: a quantized glb's positions are
// normalized Int16 and `applyMatrix4` would quietly crush them to a 2 m box.
bakeNodeTransform(render);
bakeNodeTransform(collision);

// ---- what the porter promised ----------------------------------------------
{
  const c = render.geometry.getAttribute('color');
  assert(!!c, 'the render mesh carries the greys in COLOR_0');
  // Linear, because three does not colour-manage vertex colours. Converted back
  // to sRGB the ramp must land exactly on its own two ends.
  const toSrgb = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);
  let lo = Infinity;
  let hi = -Infinity;
  const distinct = new Set();
  for (let i = 0; i < c.count; i++) {
    const v = c.getX(i);
    distinct.add(v);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    // Grey, not a colour: the whole point of one material for the map.
    if (i % 997 === 0) {
      assert(c.getY(i) === v && c.getZ(i) === v, `vertex ${i} colour is grey`);
    }
  }
  assert(Math.round(toSrgb(hi) * 255) === GREY_SMALLEST, `brightest is the ramp's small end (got ${Math.round(toSrgb(hi) * 255)})`);
  assert(Math.round(toSrgb(lo) * 255) === GREY_LARGEST, `darkest is the ramp's large end (got ${Math.round(toSrgb(lo) * 255)})`);
  // 8-bit linear would merge the darkest ramp steps into each other; the porter
  // writes 16 to stop that, and this is the check that says it worked.
  assert(distinct.size > 100, `the ramp keeps its steps (${distinct.size} distinct greys)`);
  assert(
    render.geometry.getAttribute('uv') == null,
    'no UVs came across — nothing is textured, and dropping them is what let the weld happen'
  );

  const tris = render.geometry.index.count / 3;
  assert(tris === data.tris, `the data module agrees about the triangle count (${tris} vs ${data.tris})`);
  // The porter asks for 4x and PROMISES an error bound, not a ratio: since the
  // bound became absolute (2 Source units, so a collapse cannot pull a thin
  // wall shut) dust2 comes back at 2.8x rather than 4.0x. So the range is wide
  // on purpose — what would be a real regression is the un-subdivision not
  // running at all, or running away with the map.
  assert(
    tris > 0.6e6 && tris < 2.2e6,
    `un-subdivided, but still a map (${tris.toLocaleString()} of 4.17M read)`
  );
}

// ---- the collider ----------------------------------------------------------
const collider = new MeshCollider(collision.geometry, { floorY: data.bounds.minY - 2 });
assert(collider.length > 0, 'the collider has triangles, so `colliders?.length` reads true');
assert(collider.isMeshCollider === true, 'and identifies itself to the dispatchers');

console.log(
  `  dust2: ${(render.geometry.index.count / 3).toLocaleString()} render tris, ` +
    `${collider.length.toLocaleString()} collision tris, ${data.spawns.length} spawns`
);

// ---- every spawn is a place a player can actually stand --------------------
//
// The raw list is the map's own `info_player_*` origins, which CS2 does not put
// on the floor — it settles them at round start. So what is checked is that
// there IS a floor under each one and that it is never ABOVE the spawn (which
// would mean the spawn is buried), and separately that snapping them down —
// what meshMap.js does at load, standing in for the settle step — lands every
// one of them on solid ground.
const snapped = data.spawns.map((sp) => {
  const g = collider.groundHeightAt(sp.pos[0], sp.pos[2], sp.pos[1]);
  const ok = g > collider.floorY && g <= sp.pos[1] + 0.05;
  return { ...sp, pos: [sp.pos[0], ok ? g : sp.pos[1], sp.pos[2]] };
});
{
  let worstDrop = 0;
  for (const [i, sp] of data.spawns.entries()) {
    const [x, y, z] = sp.pos;
    const ground = collider.groundHeightAt(x, z, y);
    assert(ground > collider.floorY, `spawn ${i} has ground under it, not the void`);
    assert(ground <= y + 0.05, `spawn ${i} is not buried under the floor (ground ${(ground - y).toFixed(2)} m above it)`);
    worstDrop = Math.max(worstDrop, y - ground);
    assert(!collider.blockedAt(x, snapped[i].pos[1], z), `spawn ${i} is not inside a wall`);
    // ...and once snapped, standing exactly on it.
    const after = collider.groundHeightAt(x, z, snapped[i].pos[1]);
    assert(Math.abs(after - snapped[i].pos[1]) < 0.02, `spawn ${i} rests on the floor once snapped`);
  }
  console.log(`  spawns: all on solid ground, snapped down by up to ${worstDrop.toFixed(2)} m`);
}

// ---- walking out of a spawn ------------------------------------------------
// Eight directions, a short walk each, stepping the way the movement code does:
// find the ground, move, push out. Nothing may end up inside geometry and
// nothing may fall through the world.
{
  let inside = 0;
  let fell = 0;
  let moved = 0;
  const STEP = 0.05;
  for (const sp of snapped) {
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const pos = { x: sp.pos[0], z: sp.pos[2] };
      const vel = { x: Math.cos(ang), z: Math.sin(ang) };
      let footY = collider.groundHeightAt(pos.x, pos.z, sp.pos[1]);
      const from = { ...pos };
      for (let s = 0; s < 40; s++) {
        pos.x += vel.x * STEP;
        pos.z += vel.z * STEP;
        footY = collider.groundHeightAt(pos.x, pos.z, footY);
        collider.resolve(pos, vel, footY, 0);
      }
      if (footY <= collider.floorY + 1e-6) fell++;
      if (collider.blockedAt(pos.x, footY, pos.z)) inside++;
      if (Math.hypot(pos.x - from.x, pos.z - from.z) > 0.5) moved++;
    }
  }
  const runs = data.spawns.length * 8;
  assert(inside === 0, `no walk ends inside geometry (${inside}/${runs} did)`);
  assert(fell === 0, `no walk falls out of the world (${fell}/${runs} did)`);
  // Not all eight directions are open from every spawn — some face a wall a
  // step away, and being stopped by it is the collider working. Most should
  // get somewhere, though; if almost none do, the push-out is pinning people.
  assert(moved > runs * 0.6, `most walks get somewhere (${moved}/${runs})`);
  console.log(`  walks: ${moved}/${runs} moved freely, ${runs - moved} stopped by geometry`);
}

// ---- a wall is a wall ------------------------------------------------------
{
  const eye = (sp) => [sp.pos[0], sp.pos[1] + STAND_EYE, sp.pos[2]];
  const a = eye(data.spawns[0]);
  assert(collider.losClear(a, a), 'a point can see itself');
  // T spawn to CT spawn on dust2 is not a sightline, on any version of it.
  const t = eye(data.spawns[0]);
  const ct = eye(data.spawns[data.spawns.length - 1]);
  assert(!collider.losClear(t, ct), 'the two spawns cannot see each other through the map');
  // Straight down from head height must hit the floor being stood on. Aimed at
  // the ground the spawn actually has rather than at the spawn's own height:
  // the two are not the same, which is what `snapped` above is for.
  const under = snapped[0].pos[1] - 0.5;
  assert(
    !collider.losClear([t[0], snapped[0].pos[1] + STAND_EYE, t[2]], [t[0], under, t[2]]),
    'the floor blocks a look straight down at it'
  );
  // Two nearby spawns of the same side normally can; at minimum, some pair can,
  // or `losClear` is answering "blocked" to everything.
  let clear = 0;
  for (let i = 0; i < data.spawns.length; i++) {
    for (let j = i + 1; j < data.spawns.length; j++) {
      if (collider.losClear(eye(data.spawns[i]), eye(data.spawns[j]))) clear++;
    }
  }
  assert(clear > 0, `some pair of spawns can see each other (${clear} pairs)`);
  console.log(`  sightlines: ${clear} clear spawn pairs of ${(data.spawns.length * (data.spawns.length - 1)) / 2}`);
}

// ---- the body has the size the rest of the trainer thinks it has -----------
{
  // Walk into a wall head-on and stop; the stopping distance is the body radius
  // and must be BODY_R, not something this file invented.
  const sp = data.spawns[0];
  const pos = { x: sp.pos[0], z: sp.pos[2] };
  const vel = { x: 1, z: 0 };
  const footY = collider.groundHeightAt(pos.x, pos.z, sp.pos[1]);
  for (let s = 0; s < 400; s++) {
    pos.x += 0.05;
    collider.resolve(pos, vel, footY, 0);
  }
  const ray = new THREE.Ray(
    new THREE.Vector3(pos.x, footY + 0.9, pos.z),
    new THREE.Vector3(1, 0, 0)
  );
  const hit = collider.bvh.raycastFirst(ray, THREE.DoubleSide, 0, 5);
  if (hit) {
    assert(
      hit.distance > BODY_R - 0.12,
      `stopped no closer to the wall than the body radius (${hit.distance.toFixed(3)} m vs ${BODY_R})`
    );
  }
}

if (failures) {
  console.error(`MeshCollision.test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('MeshCollision.test: ok');

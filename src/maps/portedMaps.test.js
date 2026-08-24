// Run: node src/maps/portedMaps.test.js
//
// Every ported map, checked on the files that actually ship.
//
// A ported map has three parts that have to agree with each other, and each one
// is silent when it goes wrong:
//
//   the render mesh    if the floor is missing you stand in a black void and it
//                      looks like a lighting bug.
//   the collision hull if it is missing you fall through the world, and if it
//                      is somewhere else you hover.
//   the surface bands  if the ranges do not cover the hull, a bullet asks a
//                      triangle what it is made of and gets an out-of-bounds
//                      read that resolves, quietly, to `default` — every wall
//                      in the map behaving like concrete.
//
// So this walks the whole DM_MAPS list rather than a favourite map, and it
// deliberately runs the REAL PlayerController against the REAL hull: nothing
// here is a fixture that agrees with the code by construction.
//
// Maps that have not been ported are reported and skipped, not failed, so a
// fresh checkout without 60 MB of geometry still gets a useful result. Rebuild
// one with: node scripts/gen-trainer-map.mjs <slug> --audit

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { DM_MAPS } from './dmMaps.js';
import { MeshCollider } from '../utils/MeshCollision.js';
import { bakeNodeTransform } from './quantizedGeometry.js';
import { PlayerController } from '../core/PlayerController.js';
import { surface as surfaceOf } from '../../shared/sim3d/surfaces.js';
import { CS3D_MAPS } from '../../shared/cs3d/maps.js';

let failures = 0;
function check(ok, msg) {
  if (ok) {
    console.log('    ok:', msg);
    return;
  }
  failures++;
  console.error('    FAIL:', msg);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

// ---- the list itself -------------------------------------------------------
// The explorer's map list is the canonical one. Anything it has that Deathmatch
// does not is a map somebody forgot to port — which is exactly how Cache came
// to be missing from the first pass.
{
  const dm = new Set(DM_MAPS.filter((m) => m.kind === 'mesh').map((m) => m.id));
  const missing = CS3D_MAPS.map((m) => m.slug).filter((s) => !dm.has(s));
  check(missing.length === 0, `every explorer map is in Deathmatch${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  check(dm.size === CS3D_MAPS.length, `${dm.size} ported maps for ${CS3D_MAPS.length} explorer maps`);
}

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
await MeshoptDecoder.ready;

function fakePlayer() {
  const camera = {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { x: 0, y: 0, z: 0 }
  };
  const input = {
    yaw: 0, pitch: 0, crouchHeld: false, walkHeld: false, jumpHeld: false,
    jumpQueued: false, spawnGraceRemaining: 0,
    moveAxis() { return { f: 0, r: 0 }; },
    beginSpawnGrace() {}, tickSpawnGrace() {}
  };
  return new PlayerController({ camera, weapon: null, audio: null }, input);
}

for (const entry of DM_MAPS) {
  if (entry.kind !== 'mesh') continue;
  const slug = entry.id;
  const glb = path.join(root, 'public', 'maps', 'ported', slug, `${slug}.glb`);
  console.log(`  ${entry.label} (${slug}):`);
  if (!fs.existsSync(glb)) {
    console.log(`    (not on disk — node scripts/gen-trainer-map.mjs ${slug})`);
    continue;
  }
  const data = entry.data;

  // ---- the bands are a partition of the hull -------------------------------
  const c = data.collision;
  check(!!c, 'carries a collision table');
  if (c) {
    let last = 0;
    let ordered = true;
    for (const [start, end] of c.bands) {
      if (start !== last || end <= start) ordered = false;
      last = end;
    }
    check(ordered && last === c.triangles, `${c.bands.length} bands partition ${c.triangles} triangles`);
    check(c.surfaces.length > 0, `${c.surfaces.length} surfaces`);
    const unnamed = c.surfaces.filter(
      (n) => n !== 'default' && surfaceOf(n) === surfaceOf('__nope__') && !/^vrf_unknown_key_/.test(n)
    );
    check(unnamed.length === 0, `every surface name resolves${unnamed.length ? ` (${unnamed.join(', ')})` : ''}`);
    check(c.ranges.light[0][1] > 0 && c.ranges.light[0][1] <= c.triangles, 'the bullet band is non-empty');
  }

  const buf = fs.readFileSync(glb);
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
  check(!!render && !!collision, 'the glb has both a render mesh and a hull');
  if (!render || !collision) continue;
  bakeNodeTransform(render);
  bakeNodeTransform(collision);
  check(
    collision.geometry.index.count / 3 === c.triangles,
    `the hull is the size the table says (${collision.geometry.index.count / 3} vs ${c.triangles})`
  );

  // ---- a floor you can see ------------------------------------------------
  // Straight down from every spawn's eye against the RENDER mesh. A hull with
  // no visible floor under it is the void-with-geometry-floating-in-it bug.
  {
    const bvh = new MeshBVH(render.geometry, { targetLeafSize: 8 });
    const ray = new THREE.Ray();
    let hits = 0;
    let up = 0;
    for (const sp of data.spawns) {
      ray.origin.set(sp.pos[0], sp.pos[1] + 1.63, sp.pos[2]);
      ray.direction.set(0, -1, 0);
      const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, 8);
      if (!h) continue;
      hits++;
      if (h.face && h.face.normal.y > 0.5) up++;
    }
    check(hits === data.spawns.length, `something is drawn under all ${data.spawns.length} spawns (${hits})`);
    check(up === hits, `and every bit of it faces up (${up}/${hits})`);
    render.geometry.boundsTree = null;
  }

  // ---- and a floor you stand on -------------------------------------------
  // The real PlayerController, on the real hull, standing still for a second.
  // This is the check that would have caught a broken unit scale, an inverted
  // axis, or a hull that came out somewhere else entirely.
  {
    const floorY = data.bounds.minY - 2;
    const collider = new MeshCollider(collision.geometry, { floorY });
    const p = fakePlayer();
    let held = 0;
    let worstDrop = 0;
    for (const sp of data.spawns) {
      const ground = collider.groundHeightAt(sp.pos[0], sp.pos[2], sp.pos[1]);
      const y = ground > floorY && ground <= sp.pos[1] + 0.05 ? ground : sp.pos[1];
      p.spawn({ pos: [sp.pos[0], y, sp.pos[2]], colliders: collider, floorY, bounds: data.bounds });
      for (let i = 0; i < 128; i++) p.update(1 / 128);
      const drop = y - p.footY;
      if (drop > worstDrop) worstDrop = drop;
      if (p.onGround && drop < 0.5) held++;
    }
    check(
      held === data.spawns.length,
      `the player stands on all ${data.spawns.length} spawns (${held}, worst drop ${worstDrop.toFixed(2)} m)`
    );
  }

  // Let the next map have the memory back: seven hulls at once is gigabytes.
  render.geometry.dispose();
  collision.geometry.dispose();
}

console.log(failures ? `portedMaps.test: ${failures} failure(s)` : 'portedMaps.test: ok');
if (failures) process.exitCode = 1;
assert.ok(true);

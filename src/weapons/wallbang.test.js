// Run: node src/weapons/wallbang.test.js
//
// CS2's wallbang rule, on the actual shipped dust2 hull.
//
// The rule has two halves and the porter used to carry neither: a bullet is
// charged by how THICK the wall is and by WHAT it is made of. So the questions
// worth asking are whether the material came across at all, whether the bands
// that carry it are self-consistent, and whether the solver then behaves the way
// the table says it should — plywood yes, concrete no, chainlink free, and an AK
// further through everything than a pistol.
//
// No browser, and no fixture either: this reads the glb the porter wrote and the
// data module beside it, so what is tested is what ships.
//
// Skipped with a note when the map has not been built. Rebuild it with:
//   node scripts/gen-trainer-map.mjs dust2

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MeshCollider } from '../utils/MeshCollision.js';
import { bakeNodeTransform } from '../maps/quantizedGeometry.js';
import { createRayWorld } from '../cs3d/rayWorld.js';
import { fireBullet, boxWorld, wallCost, PENETRATION_UNITS } from '../../shared/sim3d/penetration.js';
import { surface as surfaceOf } from '../../shared/sim3d/surfaces.js';
import { UNIT_M } from '../../shared/sim3d/units.js';
import { FALLBACK_WEAPONS, resolveShot, GRAZE_DAMAGE } from './wallbang.js';

let failures = 0;
function check(ok, msg) {
  if (ok) {
    console.log('  ok:', msg);
    return;
  }
  failures++;
  console.error('  FAIL:', msg);
}

// ---- the rule itself, on boxes ---------------------------------------------
// Before touching a map: does the solver charge by thickness AND material? A
// box world makes both variables independent, which a real map never does.
{
  const shoot = (surface, thickness, weapon) => {
    const world = boxWorld([
      { mins: [100, -200, -200], maxs: [100 + thickness, 200, 200], surface }
    ]);
    // A slab of `surface` at x=100, and a bullet fired at it from the origin.
    return fireBullet({ src: { x: 0, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 }, weapon, world });
  };
  const ak = FALLBACK_WEAPONS.ak47;
  const usp = FALLBACK_WEAPONS.usp_silencer;

  check(shoot('wood', 4, ak).penetrations === 1, 'an AK goes through 4 units of wood');
  check(shoot('concrete', 8, ak).penetrations === 1, 'and through 8 units of concrete');
  check(shoot('concrete', 64, ak).penetrations === 0, 'and not through 64 units of it');
  check(shoot('solidmetal', 24, ak).penetrations === 0, 'and not through 24 units of solid metal');
  check(shoot('chainlink', 8, ak).penetrations === 1, 'chainlink is barely there');

  // The ratio the table encodes, and the one players feel: penetration power 2
  // against power 1.
  let akThrough = 0;
  let uspThrough = 0;
  for (let t = 2; t <= 80; t += 2) {
    if (shoot('concrete', t, ak).penetrations > 0) akThrough++;
    if (shoot('concrete', t, usp).penetrations > 0) uspThrough++;
  }
  check(akThrough > uspThrough, `an AK crosses more concrete than a USP (${akThrough} vs ${uspThrough} thicknesses)`);

  // Damage is taken off by the surface, not just by the distance.
  const thin = shoot('wood', 4, ak);
  const bare = fireBullet({
    src: { x: 0, y: 0, z: 0 },
    dir: { x: 1, y: 0, z: 0 },
    weapon: ak,
    world: boxWorld([])
  });
  check(thin.damage < bare.damage, `wood takes damage off the far side (${thin.damage.toFixed(1)} vs ${bare.damage.toFixed(1)})`);

  // wallCost's own contract: a see-through surface is not averaged with what is
  // behind it, everything else is.
  const c = wallCost(surfaceOf('concrete'), surfaceOf('concrete'), 10);
  check(Math.abs(c.cost - 10 / 0.5) < 1e-9, 'concrete costs thickness / 0.5');
  check(wallCost(surfaceOf('chainlink'), surfaceOf('concrete'), 10).damageLeft >= 0.9, 'a grate keeps the bullet nearly whole');
  check(PENETRATION_UNITS > 0, 'penetration power converts to units of wall');
}

// ---- ignoreWalls (Doors AWP): a bot on the ray is a hit, wall thickness
//      does not get a vote. Misses still stop on the hull. -------------------
{
  const origin = new THREE.Vector3(0, 0.9, 0);
  const direction = new THREE.Vector3(1, 0, 0);
  const awp = FALLBACK_WEAPONS.awp;
  // 200 units of concrete: thicker than Source will ever look for an exit
  // (MAX_WALL_THICKNESS is 90), so a real AWP never comes out the far side.
  const thick = boxWorld([
    { mins: [100, -200, -200], maxs: [300, 200, 200], surface: 'concrete' }
  ]);
  const bot = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.8, 0.4));
  bot.position.set(400 * UNIT_M, 0.9, 0);
  bot.updateMatrixWorld(true);
  bot.userData = { zone: 'chest' };

  const blocked = resolveShot({
    origin, direction, world: thick, weapon: awp, colliders: [bot]
  });
  check(!blocked.hit, '200 units of concrete stops an AWP');

  const through = resolveShot({
    origin, direction, world: thick, weapon: awp, colliders: [bot], ignoreWalls: true
  });
  check(!!through.hit, 'ignoreWalls still hits the bot behind it');
  check(through.hit.object === bot, 'and names that bot');
  check(through.damage >= GRAZE_DAMAGE, 'with enough damage to count');
  check(through.penetrations > 0, 'and still counts as a wallbang');

  const miss = resolveShot({
    origin, direction, world: thick, weapon: awp, colliders: [], ignoreWalls: true
  });
  check(!miss.hit, 'a miss is still a miss');
  check(miss.impacts.length > 0, 'and the tracer still stops on the wall');

  const clean = resolveShot({
    origin, direction, world: boxWorld([]), weapon: awp, colliders: [bot], ignoreWalls: true
  });
  check(!!clean.hit, 'a clear shot still hits');
  check(clean.penetrations === 0, 'and is not a wallbang');
}

// ---- the shipped map -------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const GLB = path.join(root, 'public', 'maps', 'ported', 'dust2', 'dust2.glb');
const DATA = path.join(root, 'src', 'maps', 'dust2MapData.js');

if (!fs.existsSync(GLB) || !fs.existsSync(DATA)) {
  console.log('  (no ported dust2 on disk — run scripts/gen-trainer-map.mjs dust2)');
  console.log(failures ? `wallbang.test: ${failures} failure(s)` : 'wallbang.test: ok (boxes only)');
  if (failures) process.exitCode = 1;
} else {
  const { DUST2_MAP_DATA: data } = await import('../maps/dust2MapData.js');
  const c = data.collision;
  check(!!c, 'the data module carries a collision table');

  // ---- the bands are a partition ------------------------------------------
  {
    let covered = 0;
    let ok = true;
    let last = 0;
    for (const [start, end] of c.bands) {
      if (start !== last) ok = false; // contiguous, in order
      if (end <= start) ok = false;
      covered += end - start;
      last = end;
    }
    check(ok, `the ${c.bands.length} bands are contiguous and in order`);
    check(covered === c.triangles, `and cover every triangle (${covered} of ${c.triangles})`);
    check(last === c.triangles, 'and stop exactly at the end of the hull');
    check(c.ranges.light[0][1] <= c.triangles, 'the light band is inside the hull');
    check(c.ranges.walk[0][1] >= c.ranges.light[0][1], 'walk is at least light');
  }

  // ---- the surfaces are real ----------------------------------------------
  {
    check(c.surfaces.length > 10, `${c.surfaces.length} distinct surfaces came across`);
    // A name that is NOT "default" but resolves to default's row never made it
    // into surfaceproperties_game.txt. One class of those is expected and is
    // the PACK's gap rather than this port's: `vrf_unknown_key_<hash>` is the
    // importer saying the map referenced a surface it could not name.
    const unresolved = c.surfaces.filter(
      (n) => n !== 'default' && surfaceOf(n) === surfaceOf('__nope__')
    );
    const vrf = unresolved.filter((n) => /^vrf_unknown_key_/.test(n));
    check(
      unresolved.length === vrf.length,
      `every named surface resolves (${unresolved.filter((n) => !/^vrf_unknown_key_/.test(n)).join(', ') || 'none unresolved'})`
    );
    if (vrf.length) {
      // Worth knowing how much of the map it is. A handful of triangles is
      // noise; a whole wall being charged as `default` would not be.
      const ids = new Set(vrf.map((n) => c.surfaces.indexOf(n)));
      let tris = 0;
      for (const [start, end, sid] of c.bands) if (ids.has(sid)) tris += end - start;
      console.log(
        `  (${vrf.length} unnamed pack surface(s) over ${tris} of ${c.triangles} triangles ` +
          `— ${((tris / c.triangles) * 100).toFixed(2)}%, charged as default)`
      );
      check(tris < c.triangles * 0.05, 'and the unnamed ones are under 5% of the hull');
    }
    for (const want of ['concrete', 'wood', 'metal']) {
      check(c.surfaces.includes(want), `dust2 has ${want}`);
    }
    // The spread is the point: if every surface resolved to the same modifier
    // the material half of the rule would be decoration.
    const mods = new Set(c.surfaces.map((n) => surfaceOf(n).penetration));
    check(mods.size > 5, `${mods.size} distinct penetration modifiers in play`);
  }

  // ---- the tracer reads them ----------------------------------------------
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  await MeshoptDecoder.ready;
  const buf = fs.readFileSync(GLB);
  const gltf = await new Promise((res, rej) =>
    loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej)
  );
  let collision = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (o.isMesh && (o.name === 'collision' || o.parent?.name === 'collision')) collision = o;
  });
  bakeNodeTransform(collision);
  const collider = new MeshCollider(collision.geometry, { floorY: data.bounds.minY - 2 });
  check(
    collision.geometry.index.count / 3 === c.triangles,
    `the glb's hull is the size the table says (${collision.geometry.index.count / 3} vs ${c.triangles})`
  );

  // The same expansion src/maps/meshMap.js does.
  const surfaceIdx = c.surfaces.length > 255 ? new Uint16Array(c.triangles) : new Uint8Array(c.triangles);
  const passBullets = new Uint8Array(c.triangles);
  for (const [start, end, sid, pass] of c.bands) {
    surfaceIdx.fill(sid, start, end);
    if (pass) passBullets.fill(1, start, end);
  }
  collider.triangles = c.triangles;
  collider.surfaces = c.surfaces;
  collider.surfaceOf = surfaceIdx;
  collider.passBullets = passBullets;
  collider.ranges = c.ranges;
  collider.mask = new Uint8Array(c.triangles);

  const world = createRayWorld(collider, null, { unitScale: UNIT_M, Ray: THREE.Ray });

  // Rays between spawn points: real sightlines across a real map.
  const U = 1 / UNIT_M;
  const toSrc = (p) => ({ x: p[0] * U, y: -p[2] * U, z: p[1] * U });
  const spawns = data.spawns.map((s) => toSrc([s.pos[0], s.pos[1] + 1.6, s.pos[2]]));
  let traces = 0;
  let named = 0;
  const seen = new Set();
  for (let i = 0; i < spawns.length; i++) {
    for (let j = 0; j < spawns.length; j++) {
      if (i === j) continue;
      const hit = world.trace(spawns[i], spawns[j]);
      traces++;
      if (!hit) continue;
      if (hit.surface && hit.surface !== 'default') named++;
      if (hit.surface) seen.add(hit.surface);
    }
  }
  check(named > traces * 0.3, `the tracer names what it hit (${named} named of ${traces} traces)`);
  check(seen.size > 3, `and finds several materials across the map (${[...seen].slice(0, 8).join(', ')})`);

  // ---- bullets across the map --------------------------------------------
  // Between every pair of spawns, with an AK and with a USP. The absolute
  // numbers depend on dust2's layout; the ORDERING is the table's rule and is
  // what this asserts.
  const fire = (weapon) => {
    let arrived = 0;
    let through = 0;
    for (let i = 0; i < spawns.length; i++) {
      for (let j = 0; j < spawns.length; j++) {
        if (i === j) continue;
        const a = spawns[i];
        const b = spawns[j];
        const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
        const l = Math.hypot(d.x, d.y, d.z) || 1;
        const res = fireBullet({
          src: a,
          dir: { x: d.x / l, y: d.y / l, z: d.z / l },
          weapon,
          world
        });
        if (res.penetrations > 0) through++;
        if (res.impacts.length) arrived++;
      }
    }
    return { arrived, through };
  };
  const ak = fire(FALLBACK_WEAPONS.ak47);
  const usp = fire(FALLBACK_WEAPONS.usp_silencer);
  check(ak.through > 0, `an AK penetrates something on ${ak.through} of ${ak.arrived} dust2 sightlines`);
  check(ak.through > usp.through, `and more than a USP does (${ak.through} vs ${usp.through})`);

  // ---- passbullets is free ------------------------------------------------
  {
    let flagged = 0;
    for (let i = 0; i < passBullets.length; i++) flagged += passBullets[i];
    check(flagged > 0, `${flagged} triangles are flagged physics_passbullets`);
    // The tracer must not report them at all: a bullet through one pays nothing,
    // rather than paying what the surface table would charge for a grate.
    let reported = 0;
    for (let i = 0; i < spawns.length; i++) {
      for (let j = 0; j < spawns.length; j++) {
        if (i === j) continue;
        const hit = world.trace(spawns[i], spawns[j]);
        if (hit && passBullets[hit.triangle]) reported++;
      }
    }
    check(reported === 0, 'and the tracer never stops a bullet on one');
  }

  console.log(failures ? `wallbang.test: ${failures} failure(s)` : 'wallbang.test: ok');
  if (failures) process.exitCode = 1;
}
assert.ok(true);

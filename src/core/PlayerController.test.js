// Run: node src/core/PlayerController.test.js
//
// The trainer's player, now that it moves on shared/sim3d/motion.js — the same
// mover the 3D map practice mode walks with. Two things are worth proving and
// neither needs a browser:
//
//   the frames    the sim is Source units and z-up; everything the trainer
//                 reads is metres and y-up. A sign or a factor wrong here is a
//                 player who walks sideways or falls through the floor, and it
//                 would look like a physics bug rather than a conversion one.
//   the physics   CS2's own numbers come out the other end: 215 u/s on the
//                 ground, a 57-unit jump apex, an 18-unit step-up, a duck that
//                 takes the speed cap down and the eye with it.
//
// The DOM is faked down to what the class actually touches — a camera with a
// position and a rotation, and an input object with the four things it reads.
// Anything more would be testing the fake.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxSimWorld, U_PER_M } from '../utils/simWorld.js';
import { PlayerController } from './PlayerController.js';
import { UNIT_M } from '../../shared/sim3d/units.js';
import { EYE_STAND, EYE_DUCK } from '../../shared/sim3d/constants.js';

let failures = 0;
function check(ok, msg) {
  if (ok) {
    console.log('  ok:', msg);
    return;
  }
  failures++;
  console.error('  FAIL:', msg);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- the fakes --------------------------------------------------------------

function fakeCamera() {
  return {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { x: 0, y: 0, z: 0 }
  };
}

function fakeInput() {
  return {
    yaw: 0,
    pitch: 0,
    f: 0,
    r: 0,
    crouchHeld: false,
    walkHeld: false,
    jumpHeld: false,
    jumpQueued: false,
    spawnGraceRemaining: 0,
    moveAxis() {
      return { f: this.f, r: this.r };
    },
    beginSpawnGrace() {},
    tickSpawnGrace() {}
  };
}

/** A controller over an arena of `boxes`, already spawned at `pos` (metres). */
function makePlayer(boxes = [], { pos = [0, 0, 0], bounds = null } = {}) {
  const camera = fakeCamera();
  const engine = { camera, weapon: null, audio: null };
  const input = fakeInput();
  const p = new PlayerController(engine, input);
  // `colliders` is the box list every arena scenario passes; simWorldFor turns
  // it into the soup the sim sweeps against.
  const colliders = boxes;
  colliders.length = boxes.length;
  p.spawn({ pos, bounds, colliders: colliders.length ? colliders : null, floorY: 0 });
  // A scenario with no cover still stands on something: give the empty case the
  // same ground quad rather than the analytic flat world, so both paths here
  // are the one the arenas actually use.
  if (!colliders.length) p.world = boxSimWorld([], { floorY: 0, extent: 64 });
  return { p, input, camera };
}

/** Run `seconds` of frames at 128 Hz (two sim ticks a frame). */
function run(p, seconds) {
  const dt = 1 / 128;
  for (let i = 0; i < Math.round(seconds / dt); i++) p.update(dt);
}

// ---- ground speed -----------------------------------------------------------
// sv_maxspeed for a rifle is 215 u/s. The trainer used to reach it through its
// own friction/accelerate pair; the sim reaches it through CS2's, and the
// number is the number either way.
{
  const { p, input } = makePlayer();
  input.f = 1;
  run(p, 2);
  const speed = Math.hypot(p.vel.x, p.vel.z) * U_PER_M;
  check(near(speed, 215, 2), `holding W tops out at 215 u/s (got ${speed.toFixed(1)})`);
  check(p.onGround, 'and stays on the ground while it does');
  // Yaw 0 looks down -Z in three, so forward is -Z and X must not drift.
  check(p.pos.z < -1 && near(p.pos.x, 0, 1e-3), `forward at yaw 0 is -Z (x ${p.pos.x.toFixed(4)}, z ${p.pos.z.toFixed(2)})`);
}

// ---- walking and crouching take it down -------------------------------------
{
  const { p, input } = makePlayer();
  input.f = 1;
  input.walkHeld = true;
  run(p, 2);
  const walk = Math.hypot(p.vel.x, p.vel.z) * U_PER_M;
  check(near(walk, 215 * 0.52, 3), `shift walks at 52% of the cap (got ${walk.toFixed(1)} u/s)`);
}
{
  const { p, input } = makePlayer();
  input.f = 1;
  input.crouchHeld = true;
  run(p, 2);
  const crouch = Math.hypot(p.vel.x, p.vel.z) * U_PER_M;
  check(near(crouch, 215 * 0.34, 6), `ctrl crouch-walks at 34% of the cap (got ${crouch.toFixed(1)} u/s)`);
  check(near(p.crouchAmt, 1, 0.01), `and the body is fully ducked (${p.crouchAmt.toFixed(3)})`);
}

// ---- the eye follows the duck, not the key ----------------------------------
{
  const { p, input, camera } = makePlayer();
  run(p, 0.2);
  const stand = camera.position.y;
  check(near(stand, EYE_STAND * UNIT_M, 1e-3), `standing eye is CS2's 64.06 u (${(stand / UNIT_M).toFixed(2)} u)`);
  input.crouchHeld = true;
  run(p, 1);
  const ducked = camera.position.y;
  check(near(ducked, EYE_DUCK * UNIT_M, 1e-3), `ducked eye is CS2's 46.04 u (${(ducked / UNIT_M).toFixed(2)} u)`);
}

// ---- the jump ---------------------------------------------------------------
// sv_jump_impulse 301.993 against sv_gravity 800 would be v^2/2g = 57 units in
// closed form, and CS2 does not get 57: CheckJumpButton's FinishGravity and
// FullWalkMove's own both run on the takeoff tick, so the impulse is already
// down 1.5 g dt before the body has moved, and a 64 Hz sample of the arc never
// lands exactly on the peak. The band is the one shared/sim3d/motion.test.js
// holds the sim to against the leak.
{
  const { p, input } = makePlayer();
  run(p, 0.2);
  const floor = p.footY;
  input.jumpHeld = true;
  let apex = floor;
  for (let i = 0; i < 128; i++) {
    p.update(1 / 128);
    if (p.footY > apex) apex = p.footY;
  }
  const rise = (apex - floor) / UNIT_M;
  check(rise > 50 && rise < 58, `a standing jump peaks in CS2's band, 50-58 u (got ${rise.toFixed(1)} u)`);
  input.jumpHeld = false;
  run(p, 1.5);
  check(near(p.footY, floor, 1e-3) && p.onGround, `and lands back on the floor (${p.footY.toFixed(4)} m)`);
}

// ---- a wall stops the body at the hull, not at the surface -------------------
// The sim's hull is 32 units wide, so a body walking east into a box whose face
// is at x = 1 m stops with its centre 16 u short of it.
{
  const box = { pos: [3, 1, 0], size: [4, 2, 4] }; // face at x = 1 m
  const { p, input } = makePlayer([box]);
  input.yaw = -Math.PI / 2; // three yaw -90 looks down +X
  input.f = 1;
  run(p, 3);
  const gap = (1 - p.pos.x) / UNIT_M;
  check(near(gap, 16, 1.5), `a wall stops the 32 u hull 16 u short (gap ${gap.toFixed(1)} u)`);
  check(Math.abs(p.vel.x) < 0.05, `and kills the velocity into it (${p.vel.x.toFixed(3)} m/s)`);
}

// ---- step-up ----------------------------------------------------------------
// STEP_HEIGHT is 18 units. A 16-unit kerb is walked onto; a 24-unit one is not.
//
// Half a second, and not longer: at 215 u/s a body clears a 6 m kerb in under
// two, walks off the far end and is back on the floor — which is correct
// behaviour and reads exactly like a failure to climb.
for (const [units, shouldClimb] of [[16, true], [24, false]]) {
  const h = units * UNIT_M;
  const box = { pos: [4, h / 2, 0], size: [6, h, 8] };
  const { p, input } = makePlayer([box]);
  input.yaw = -Math.PI / 2;
  input.f = 1;
  run(p, 0.5);
  const climbed = p.footY > h - 0.02;
  check(
    climbed === shouldClimb,
    `a ${units} u kerb is ${shouldClimb ? 'climbed' : 'not climbed'} (footY ${(p.footY / UNIT_M).toFixed(1)} u)`
  );
  if (!shouldClimb) {
    const gap = (1 - p.pos.x) / UNIT_M;
    check(near(gap, 16, 1.5), `  and it stops the hull instead (gap ${gap.toFixed(1)} u)`);
  }
}

// ---- scenario bounds are a rule, and they hold ------------------------------
{
  const bounds = { minX: -2, maxX: 2, minZ: -2, maxZ: 2 };
  const { p, input } = makePlayer([], { bounds });
  input.yaw = -Math.PI / 2;
  input.f = 1;
  run(p, 3);
  check(near(p.pos.x, 2, 1e-6), `the bound holds the player at maxX (${p.pos.x.toFixed(4)})`);
  check(Math.abs(p.vel.x) < 1e-6, 'and takes the velocity out of the wall');
  // The clamp has to be written back into the sim, or the mirrored position
  // snaps back the next tick and the player judders along the edge.
  check(near(p.sim.pos.x * UNIT_M, 2, 1e-6), 'and the sim agrees, so it does not judder');
}

// ---- the mirror is a mirror -------------------------------------------------
// Every field the rest of the trainer reads has to match the sim it came from.
{
  const { p, input } = makePlayer();
  input.f = 1;
  input.r = 1;
  run(p, 1);
  const s = p.sim;
  check(near(p.pos.x, s.pos.x * UNIT_M, 1e-9), 'pos.x mirrors sim x');
  check(near(p.pos.z, -s.pos.y * UNIT_M, 1e-9), 'pos.z mirrors -sim y');
  check(near(p.footY, s.pos.z * UNIT_M, 1e-9), 'footY mirrors sim z');
  check(near(p.velY, s.vel.z * UNIT_M, 1e-9), 'velY mirrors sim vz');
  check(p.onGround === s.onGround, 'onGround mirrors the sim');
}

// ---- the mesh world, and the scale that gets it wrong ------------------------
// A ported map's collision hull is in METRES, because the renderer, the bots and
// the decal placer all are. The sim is in Source units. `unitScale` is the whole
// of the bridge, and a bridge with a factor of 39 in it either works or is
// spectacularly broken — so it is checked against the collider the bots already
// use, on the real dust2, at its own spawn points.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, '..', '..');
  const glb = path.join(root, 'public', 'maps', 'ported', 'dust2', 'dust2.glb');
  if (!fs.existsSync(glb)) {
    console.log('  (no ported dust2 on disk — run scripts/gen-trainer-map.mjs dust2)');
  } else {
    const { DUST2_MAP_DATA: data } = await import('../maps/dust2MapData.js');
    const { MeshCollider } = await import('../utils/MeshCollision.js');
    const { meshSimWorld } = await import('../utils/simWorld.js');
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
    const { bakeNodeTransform } = await import('../maps/quantizedGeometry.js');

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    await MeshoptDecoder.ready;
    const buf = fs.readFileSync(glb);
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
    const world = meshSimWorld(collider);
    check(!!world, 'a ported map gives a sim world');

    // At every spawn, drop a hull and see where it stops. The collider's own
    // downward ray is the reference: two independent queries over the same
    // triangles, one asked in metres and one in units, have to agree.
    //
    // The comparison hull is deliberately NEEDLE-thin. A ray has no width and
    // the player's hull is 32 units of it, so a box resting on a kerb or a
    // slope legitimately stops several units above the ray directly under its
    // centre — measured 7.75 u on dust2. That difference is geometry, not a
    // conversion, and comparing the two would only ever be measuring it.
    //
    // The drop starts 2 m up and runs 5 m: the pack's raw spawn entities sit up
    // to 1.6 m off the floor (CS2 settles them at round start; the trainer
    // snaps them in meshMap.js), so a shorter sweep misses the ground at the
    // highest few and reads as a hole in the map.
    let worst = 0;
    let landed = 0;
    let wide = 0;
    for (const sp of data.spawns) {
      const [x, y, z] = sp.pos;
      const ref = collider.groundHeightAt(x, z, y + 2);
      const from = { x: x * U_PER_M, y: -z * U_PER_M, z: (y + 2) * U_PER_M };
      const to = { x: x * U_PER_M, y: -z * U_PER_M, z: (y - 3) * U_PER_M };
      const needle = world.traceHull(from, to, 0.25, 1);
      if (needle.fraction < 1) {
        landed++;
        worst = Math.max(worst, Math.abs(needle.endpos.z * UNIT_M - ref));
      }
      if (world.traceHull(from, to, 16, 72).fraction < 1) wide++;
    }
    check(landed === data.spawns.length, `the sim finds ground at all ${data.spawns.length} spawns (${landed})`);
    check(wide === data.spawns.length, `and the full 32 u hull lands at all of them too (${wide})`);
    // DIST_EPSILON is 1/32 u and the needle still has a width; a unit of
    // agreement over a 6,400-unit map is the scale being right, not approximately
    // right.
    check(worst < 1 * UNIT_M, `and within ${(worst / UNIT_M).toFixed(2)} u of the collider's own ground ray`);

    // A wall is a wall in both scales: sweep 8 m east from every spawn and check
    // the sim stops wherever the collider says the body is blocked.
    let agree = 0;
    let checked = 0;
    for (const sp of data.spawns) {
      const [x, y, z] = sp.pos;
      const t = world.traceHull(
        { x: x * U_PER_M, y: -z * U_PER_M, z: (y + 0.05) * U_PER_M },
        { x: (x + 8) * U_PER_M, y: -z * U_PER_M, z: (y + 0.05) * U_PER_M },
        16,
        72
      );
      const endX = t.endpos.x * UNIT_M;
      // Just short of where the sweep stopped must be walkable, and the collider
      // has to agree that it is.
      const probe = t.fraction >= 1 ? x + 8 : endX - 0.05;
      checked++;
      if (!collider.blockedAt(probe, y + 0.05, z, 0.3)) agree++;
    }
    check(agree >= checked - 2, `a swept stop is somewhere the collider calls clear (${agree}/${checked})`);
  }
}

console.log(failures ? `PlayerController.test: ${failures} failure(s)` : 'PlayerController.test: ok');
if (failures) process.exitCode = 1;
assert.ok(true);

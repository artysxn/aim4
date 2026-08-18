// Run: node shared/sim3d/grenade.test.js
//
// The throw and the bounce against the numbers the demos measured. The corpus
// (scripts/cs3d-oracle.mjs, and the release-velocity probe that produced these
// figures) is the authority on whether the MODEL matches CS2; this file is the
// authority on whether the CODE matches the model.
//
// The observations reproduced here are all from real throws, so they are
// written as literals rather than derived from the constants — a constant
// edited by hand should FAIL this file, not silently redefine what CS2 does.

import { TICK_DT, GRAVITY } from './constants.js';
import { flatWorld, emptyWorld } from './motion.js';
import { triangleSoupTracer, boxTriangles } from './hullTrace.js';
import {
  createGrenade,
  stepGrenade,
  releaseState,
  throwPitch,
  throwSpeed,
  GRENADE_GRAVITY_SCALE,
  GRENADE_ELASTICITY,
  GRENADE_SPEC,
  THROW_STRENGTH,
  VELOCITY_INHERIT,
  RELEASE_FORWARD
} from './grenade.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---- the pitch remap, against measured throws -----------------------------
// throwPitch = -10 + viewPitch * (up ? 80/90 : 100/90). Median error against
// 24 standing throws was 0.000 degrees, so these are exact, not approximate.
{
  close(throwPitch(0), -10, 1e-4, 'level aim leaves 10 degrees high');
  // Looking up 6 degrees: the demo's throw pitch was -15.33.
  close(throwPitch(-6), -15.3333, 1e-3, 'up branch at -6');
  // Looking up 45.3: the demo's throw pitch was -50.30.
  close(throwPitch(-45.3), -50.2667, 1e-3, 'up branch at -45.3');
  // Looking down 4.7: the demo's throw pitch was -4.78.
  close(throwPitch(4.7), -4.7778, 1e-3, 'down branch at +4.7');
  // The branches are NOT symmetric; a remap that used one scale would tie here.
  assert(
    Math.abs(throwPitch(20) + 10) - Math.abs(throwPitch(-20) + 10) > 1,
    'up and down use different scales'
  );
}

// ---- release speed per strength -------------------------------------------
{
  close(throwSpeed(THROW_STRENGTH.full), 675, 1e-3, 'full throw is 675 u/s');
  close(throwSpeed(THROW_STRENGTH.medium), 438.75, 1e-3, 'both buttons is 438.75 u/s');
  close(throwSpeed(THROW_STRENGTH.short), 202.5, 1e-3, 'right click is 202.5 u/s');
  // A strength seen mid-hold in the corpus, with the speed it produced.
  close(throwSpeed(0.6953), 531.03, 0.05, 'mid-hold strength 0.6953');
  close(throwSpeed(2), 675, 1e-3, 'strength clamps at 1');
  close(throwSpeed(-1), 202.5, 1e-3, 'strength clamps at 0');
}

// ---- the release itself ---------------------------------------------------
{
  const eye = { x: 0, y: 0, z: 64 };
  // Aiming level, due east, standing still.
  const r = releaseState({ eye, yaw: 0, pitch: 0, strength: 1 });
  close(Math.hypot(r.vel.x, r.vel.y, r.vel.z), 675, 0.01, 'standing full throw speed');
  // It leaves 10 degrees above level, so vz is positive and vx a touch short.
  close(r.vel.z, 675 * Math.sin(10 * (Math.PI / 180)), 0.05, 'release rises 10 degrees');
  assert(r.vel.y === 0, 'no sideways component when standing');
  // The origin sits RELEASE_FORWARD along the throw axis, not the view axis.
  close(Math.hypot(r.pos.x, r.pos.y, r.pos.z - 64), RELEASE_FORWARD, 0.01, 'release is 16 units out');

  // Velocity inheritance: strafing right at 250 puts 1.25 * 250 sideways on it,
  // and nothing else changes. This is the whole of "jump throw".
  const moving = releaseState({ eye, yaw: 0, pitch: 0, strength: 1, velocity: { x: 0, y: -250, z: 0 } });
  close(moving.vel.y, -250 * VELOCITY_INHERIT, 0.01, 'inherits 1.25 of sideways motion');
  close(moving.vel.x, r.vel.x, 0.01, 'forward component is unchanged by strafing');
  const jump = releaseState({ eye, yaw: 0, pitch: 0, strength: 1, velocity: { x: 0, y: 0, z: 298 } });
  close(jump.vel.z - r.vel.z, 298 * VELOCITY_INHERIT, 0.01, 'a jump adds 1.25 of its rise');
}

// ---- flight: gravity is 0.4 of the world's -------------------------------
{
  const world = emptyWorld();
  const grav = GRAVITY * GRENADE_GRAVITY_SCALE;
  close(grav, 320, 1e-4, 'grenade gravity is 320 u/s^2');
  const g = createGrenade({ x: 0, y: 0, z: 100 }, { x: 250, y: 0, z: 100 });
  for (let k = 1; k <= 64; k++) {
    stepGrenade(g, world);
    const t = k * TICK_DT;
    close(g.pos.z, 100 + 100 * t - (grav / 2) * t * t, 0.02, `parabola tick ${k}`);
    close(g.pos.x, 250 * t, 0.02, `linear x tick ${k}`);
  }
}

// ---- the bounce: reflect fully, THEN damp the whole vector ----------------
{
  const floor = flatWorld(0);
  // Straight down at 200 onto flat ground: the rebound is 200 * 0.4375, and the
  // grenade is above REST_SPEED so it does not stick.
  const g = createGrenade({ x: 0, y: 0, z: 4 }, { x: 0, y: 0, z: -200 }, 'hegrenade');
  let up = 0;
  for (let k = 0; k < 8 && g.bounces === 0; k++) stepGrenade(g, floor);
  assert(g.bounces === 1, 'bounced once');
  up = g.vel.z;
  // One tick of gravity has already been taken off the rebound.
  close(up + (GRAVITY * GRENADE_GRAVITY_SCALE) * TICK_DT * 0.5, 200 * GRENADE_ELASTICITY, 6, 'rebound is elasticity * incoming');

  // A glancing bounce damps the TANGENTIAL component too. Reflecting at
  // (1 + e) and then scaling by e — the shape this file replaced — would leave
  // the tangential speed at e * v and the normal at e^2 * v; Source leaves both
  // at e * v.
  const h = createGrenade({ x: 0, y: 0, z: 4 }, { x: 300, y: 0, z: -300 }, 'hegrenade');
  for (let k = 0; k < 8 && h.bounces === 0; k++) stepGrenade(h, floor);
  assert(h.bounces === 1, 'glancing bounce happened');
  close(h.vel.x, 300 * GRENADE_ELASTICITY, 1, 'tangential speed is damped once, not zero and not twice');
}

// ---- rest -----------------------------------------------------------------
{
  const floor = flatWorld(0);
  const g = createGrenade({ x: 0, y: 0, z: 60 }, { x: 40, y: 0, z: 0 }, 'smokegrenade');
  for (let k = 0; k < 640 && !g.resting; k++) stepGrenade(g, floor);
  assert(g.resting, 'comes to rest on the floor');
  assert(g.bounces > 0, 'rest came via at least one bounce');
  // A smoke detonates BY resting: no timer is involved.
  assert(g.detonated, 'smoke goes off when it stops');
}

// ---- fuses ----------------------------------------------------------------
{
  const world = emptyWorld();
  // HE and flashbang: 1.5 s from creation, in mid-air, wherever they are.
  for (const type of ['hegrenade', 'flashbang']) {
    const g = createGrenade({ x: 0, y: 0, z: 500 }, { x: 100, y: 0, z: 0 }, type);
    let ticks = 0;
    while (!g.detonated && ticks < 400) {
      stepGrenade(g, world);
      ticks++;
    }
    assert(g.detonated, `${type} detonated`);
    close(ticks * TICK_DT, 1.5, TICK_DT, `${type} fuse is 1.5 s`);
    assert(ticks === 96, `${type} fuse is 96 ticks, got ${ticks}`);
  }
  // Fire grenades: the 2 s fuse is only the cap on one that never lands.
  const air = createGrenade({ x: 0, y: 0, z: 5000 }, { x: 0, y: 0, z: 0 }, 'molotov');
  let t = 0;
  while (!air.detonated && t < 400) {
    stepGrenade(air, world);
    t++;
  }
  assert(t === 128, `molotov airtime cap is 128 ticks, got ${t}`);

  // ...and one that lands goes off on contact, long before the cap.
  const floor = flatWorld(0);
  const land = createGrenade({ x: 0, y: 0, z: 40 }, { x: 200, y: 0, z: 0 }, 'molotov');
  let n = 0;
  while (!land.detonated && n < 400) {
    stepGrenade(land, floor);
    n++;
  }
  assert(land.detonated && n < 128, `molotov breaks on impact (${n} ticks)`);
  assert(land.detonateNormal && land.detonateNormal.z > 0.7, 'and reports the surface it broke on');
}

// ---- a fire grenade bounces off walls and burns on floors -----------------
// The rule is NOT "breaks on the first thing it touches". Measured: 61% of fire
// grenades bounce at least once before igniting, and of 15 replayed against
// Nuke's real collision, 15 ended on a surface with normal.z >= 0.7 and none on
// a wall. A molotov that detonated on wall contact would stop dead against
// every wall in the game, which is exactly the bug this guards.
{
  const tris = [];
  boxTriangles([-600, -600, -40], [600, 600, 0], tris); // floor
  boxTriangles([200, -200, 0], [260, 200, 300], tris); // wall in the way
  const world = triangleSoupTracer(tris);

  const m = createGrenade({ x: 0, y: 0, z: 100 }, { x: 500, y: 0, z: 0 }, 'molotov');
  let hitWallAt = -1;
  for (let k = 0; k < 400 && !m.detonated; k++) {
    stepGrenade(m, world);
    if (hitWallAt < 0 && m.hit && !m.hitGround) hitWallAt = k;
  }
  assert(hitWallAt >= 0, 'it reached the wall');
  assert(m.detonated, 'and eventually burned');
  assert(m.hitGround, 'what set it off was ground, not the wall');
  assert(m.detonateNormal && m.detonateNormal.z >= 0.7, 'it burned on a walkable surface');
  assert(m.pos.x < 200, `it came back off the wall instead of stopping at it (x=${m.pos.x.toFixed(1)})`);
  assert(m.bounces >= 2, `wall then floor is at least two contacts, got ${m.bounces}`);

  // ...and a fire grenade that never finds a floor still goes off on its cap.
  const lost = createGrenade({ x: 0, y: 0, z: 9000 }, { x: 0, y: 0, z: 0 }, 'incgrenade');
  let n = 0;
  while (!lost.detonated && n < 400) {
    stepGrenade(lost, emptyWorld());
    n++;
  }
  assert(n === 128, `the 2 s airtime cap still applies, got ${n} ticks`);
}

// ---- two grenades at once do not share a surface --------------------------
// Regression: the contact normal used to live in a module-level temporary, so
// an HE going off in mid-air reported whatever surface the OTHER grenade in
// flight had just bounced off. Effects key off that normal, so the symptom was
// a blast orienting itself to a wall nowhere near it.
{
  const floor = flatWorld(0);
  const bouncing = createGrenade({ x: 0, y: 0, z: 30 }, { x: 120, y: 0, z: 0 }, 'smokegrenade');
  const airborne = createGrenade({ x: 0, y: 0, z: 4000 }, { x: 0, y: 0, z: 0 }, 'hegrenade');
  for (let k = 0; k < 96 && !airborne.detonated; k++) {
    stepGrenade(bouncing, floor);
    stepGrenade(airborne, floor);
  }
  assert(airborne.detonated, 'the airborne HE went off on its fuse');
  assert(bouncing.bounces > 0, 'the other one really did bounce meanwhile');
  assert(airborne.detonateNormal === null, 'an HE that touched nothing reports no surface');
}

// ---- the spec table is complete -------------------------------------------
{
  for (const type of ['hegrenade', 'flashbang', 'smokegrenade', 'molotov', 'incgrenade', 'decoy']) {
    const s = GRENADE_SPEC[type];
    assert(s, `${type} has a spec`);
    assert(['fuse', 'ground', 'rest'].includes(s.detonate), `${type} has a detonation rule`);
    if (s.detonate === 'fuse') assert(s.fuse > 0, `${type} timer is set`);
    if (s.detonate === 'rest') assert(s.fuse === null, `${type} is not on a timer`);
  }
}

console.log('grenade.test: ok');

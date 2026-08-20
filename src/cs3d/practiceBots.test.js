// Run: node src/cs3d/practiceBots.test.js

import {
  oppositeSide,
  hitgroupFromHeight,
  rayAabb,
  botBox,
  boostFeet,
  poseFromPlayer,
  PracticeBots
} from './practiceBots.js';
import { flinchPunch } from '../../shared/sim3d/flinch.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

assert(oppositeSide('T') === 'CT', 'T dummy is CT');
assert(oppositeSide('CT') === 'T', 'CT dummy is T');
assert(oppositeSide('spec') === 'CT', 'unknown treated as T');

assert(hitgroupFromHeight(70) === 'head', 'head');
assert(hitgroupFromHeight(50) === 'chest', 'chest');
assert(hitgroupFromHeight(10) === 'legs', 'legs');

const origin = { x: 0, y: 0, z: 0 };
const box = botBox(origin);
assert(box.min.x === -16 && box.max.x === 16, 'hull wide');
assert(box.max.z === 72, 'stand height');

const miss = rayAabb({ x: 100, y: 0, z: 32 }, { x: 200, y: 0, z: 32 }, box.min, box.max);
assert(!miss, 'misses beside the hull');

const hit = rayAabb({ x: -80, y: 0, z: 64 }, { x: 80, y: 0, z: 64 }, box.min, box.max);
assert(hit, 'hits the hull');
assert(Math.abs(hit.point.x - -16) < 0.01, `entry on -x face (${hit.point.x})`);
assert(hitgroupFromHeight(hit.point.z - origin.z) === 'head', 'eye-height is head');

const feet = boostFeet({ x: 10, y: 20, z: 100 });
assert(feet.x === 10 && feet.z === -20 && feet.y === 172, 'boost is standHeight up in scene');

const walk = poseFromPlayer({
  mode: 'walk',
  sim: { pos: { x: 1, y: 2, z: 3 } },
  yaw: 0,
  pitch: 0,
  camera: { position: { x: 0, y: 0, z: 0 } }
});
assert(walk.origin.x === 1 && walk.origin.y === 2 && walk.origin.z === 3, 'walk uses sim feet');

{
  const bots = new PracticeBots({});
  const punches = [];
  const rags = [];
  bots.list.push({
    id: 1,
    alive: true,
    hp: 100,
    origin: { x: 0, y: 0, z: 0 },
    body: {
      applyFlinch(d) {
        punches.push(d);
      },
      startRagdoll(o) {
        rags.push(o);
      },
      set() {}
    }
  });
  bots.takeHit({
    id: 1,
    damage: 30,
    group: 'chest',
    point: { x: 0, y: 0, z: 40 },
    dir: { x: 1, y: 0, z: 0 },
    armor: 0
  });
  const want = flinchPunch({ hitgroup: 'chest', damage: 30, armor: 0 });
  assert(punches.length === 1 && punches[0].pitch === want.pitch, 'chest hit writes TraceAttack punch');
  assert(bots.list[0].hp === 70, 'HP drops');
  assert(rags.length === 0, 'a living dummy is not a ragdoll');
  bots.takeHit({
    id: 1,
    damage: 80,
    group: 'head',
    point: { x: 0, y: 0, z: 64 },
    dir: { x: 1, y: 0, z: 0 },
    helmet: false
  });
  assert(!bots.list[0].alive, 'the kill is recorded');
  assert(rags.length === 1 && rags[0].force.x > 0, 'the kill carries a scene-frame impulse');
}

console.log('practiceBots.test.js ok');

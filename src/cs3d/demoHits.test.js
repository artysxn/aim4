// Run: node src/cs3d/demoHits.test.js

import assert from 'node:assert/strict';
import {
  consumeForward,
  isBlastWeapon,
  resolveDemoHit,
  applyTraceHit,
  killedOnTick,
  createPovFlinch,
  addPovFlinch,
  decayPovFlinch,
  scaledCameraPunch
} from './demoHits.js';
import { flinchPunch } from '../../shared/sim3d/flinch.js';
import { RECOIL_SCALE, VIEW_RECOIL_TRACKING } from '../../shared/sim3d/recoil.js';

assert.deepEqual(consumeForward([{ tick: 10 }, { tick: 11 }, { tick: 12 }], 10, 12, 64), [
  { tick: 11 },
  { tick: 12 }
]);
assert.deepEqual(consumeForward([{ tick: 10 }], 12, 10, 64), [], 'rewind is empty');
assert.deepEqual(consumeForward([{ tick: 10 }], 0, 80, 64), [], 'a seek wider than one second is empty');
assert.equal(isBlastWeapon('weapon_hegrenade'), true);
assert.equal(isBlastWeapon('ak47'), false);

{
  const players = [
    { id: 'a', slot: 0 },
    { id: 'b', slot: 1 }
  ];
  const states = [
    { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, armor: 0, flags: 1, health: 100, alive: true },
    { x: 100, y: 0, z: 0, yaw: 180, pitch: 0, armor: 0, flags: 1, health: 70, alive: true }
  ];
  const ev = { tick: 50, attacker: 'a', victim: 'b', hp: 27, weapon: 'ak47', hitgroup: 2 };
  const hit = resolveDemoHit(ev, {
    players,
    states,
    shots: [{ tick: 50, player: 'a', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }]
  });
  assert.equal(hit.slot, 1);
  assert.equal(hit.group, 'chest');
  assert.equal(hit.blast, false);
  assert.ok(hit.dir.x > 0, 'shot along +x');
}

{
  const punch = flinchPunch({ hitgroup: 'chest', damage: 30, armor: 0 });
  const body = { flinch: null, rag: null, applyFlinch(d) { this.flinch = d; }, startRagdoll(o) { this.rag = o; } };
  const spawned = [];
  applyTraceHit({
    body,
    blood: { spawn(o) { spawned.push(o); } },
    damage: 30,
    hitgroup: 'chest',
    point: { x: 1, y: 2, z: 3 },
    dir: { x: 1, y: 0, z: 0 }
  });
  assert.equal(body.flinch.pitch, punch.pitch);
  assert.equal(spawned.length, 1);
  assert.equal(body.rag, null);
  applyTraceHit({
    body,
    damage: 80,
    hitgroup: 'head',
    dir: { x: 1, y: 0, z: 0 },
    point: { x: 0, y: 0, z: 64 },
    kill: true
  });
  assert.ok(body.rag?.force.x > 0, 'kill impulse is in scene frame');
}

assert.equal(killedOnTick([{ victim: 'b', tick: 9 }], 'b', 9), true);
assert.equal(killedOnTick([{ victim: 'b', tick: 9 }], 'b', 8), false);

{
  const p = createPovFlinch();
  addPovFlinch(p, { pitch: -6, yaw: 0, roll: 2 });
  const cam = scaledCameraPunch(p);
  assert.equal(cam[0], -6 * RECOIL_SCALE * VIEW_RECOIL_TRACKING);
  decayPovFlinch(p, 0);
  assert.equal(p[0], -6, 'paused clock holds the snap');
}

console.log('demoHits.test.js ok');

// Run: node src/cs3d/hudRadar.test.js

import { worldToRadar } from '../replays/viewer/mapCalibration.js';
import { hudRadarRotation, worldToHudRadar } from './hudRadar.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const size = 256;
const origin = worldToRadar('NUK', 0, 0);
const cx = size / 2;

// Yaw 0 is east. A point east of the player must land above centre (look = up).
const east = worldToHudRadar('NUK', 400, 0, origin, 0, size);
assert(Math.abs(east.x - cx) < 1, `east x ${east.x}`);
assert(east.y < cx - 8, `east should be up, y=${east.y}`);

// Yaw 90 is north. A point north of the player must land above centre.
const north = worldToHudRadar('NUK', 0, 400, origin, 90, size);
assert(Math.abs(north.x - cx) < 1, `north x ${north.x}`);
assert(north.y < cx - 8, `north should be up, y=${north.y}`);

// The player is always the centre.
const self = worldToHudRadar('NUK', 0, 0, origin, 45, size);
assert(Math.abs(self.x - cx) < 0.01 && Math.abs(self.y - cx) < 0.01, 'self centred');

assert(Math.abs(hudRadarRotation(0) + Math.PI / 2) < 1e-9, 'east rotate');
assert(Math.abs(hudRadarRotation(90)) < 1e-9, 'north rotate');

console.log('hudRadar.test.js ok');

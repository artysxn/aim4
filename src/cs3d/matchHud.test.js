// Run: node src/cs3d/matchHud.test.js

import { readFileSync } from 'node:fs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const src = readFileSync(new URL('./matchHud.js', import.meta.url), 'utf8');
const cam = src.slice(src.indexOf('c3-mh-cam'), src.indexOf('c3-mh-chat'));
assert(cam.includes('Pause (J)'), 'pause names J');
assert(cam.includes('Restart (K)'), 'restart names K');
assert(cam.includes('Exit (L)'), 'exit names L');
assert(!cam.includes('data-cam'), 'no T / CT / Spectate strip');
assert(cam.includes('hidden'), 'cam starts hidden until a round is on');
assert(!src.includes('—'), 'no em dash in match hud');

console.log('matchHud.test.js ok');

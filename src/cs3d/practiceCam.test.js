// Run: node src/cs3d/practiceCam.test.js

import { nextCamMode, spectateCaption, cycleLive, parseSpectateTarget, spectateTargetId } from './practiceCam.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

assert(nextCamMode('T') === 'CT', 'T to CT');
assert(nextCamMode('CT') === 'spectate', 'CT to spectate');
assert(nextCamMode('spectate') === 'T', 'wrap');
assert(spectateCaption('s1mple') === 'spectating (s1mple)', 'named');
assert(spectateCaption('') === 'spectating (Bot)', 'fallback');
assert(cycleLive([0, 2, 4], 2, 1) === 4, 'next');
assert(cycleLive([0, 2, 4], 4, 1) === 0, 'wrap next');
assert(cycleLive([0, 2, 4], 2, -1) === 0, 'prev');
assert(cycleLive([0, 2, 4], 9, 1) === 0, 'dead falls to first live');
assert(spectateTargetId('bot', 3) === 'bot:3', 'bot key');
assert(parseSpectateTarget('demo:4').kind === 'demo' && parseSpectateTarget('demo:4').id === 4, 'parse demo');

console.log('practiceCam.test.js ok');

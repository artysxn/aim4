// Run: node src/cs3d/viewModelClips.test.js

import { pickReloadClip, reloadClipAliases } from './viewModelClips.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

assert(reloadClipAliases(true)[0] === 'reload_empty', 'empty mag prefers reload_empty');
assert(reloadClipAliases(false)[0] === 'reload', 'partial mag prefers reload');

assert(pickReloadClip(new Set(['reload']), true) === 'reload', 'AK empty falls back to reload');
assert(pickReloadClip(new Set(['reload', 'reload_empty']), true) === 'reload_empty', 'glock empty uses reload_empty');
assert(pickReloadClip(new Set(['reload', 'reload_empty']), false) === 'reload', 'glock partial uses reload');
assert(pickReloadClip(new Set(['shoot1', 'draw']), true) === null, 'missing reload is null');

console.log('viewModelClips.test.js: ok');

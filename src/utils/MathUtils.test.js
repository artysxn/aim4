// Run: node src/utils/MathUtils.test.js

import { hFovToVFov, sourceVFovFromHFov } from './MathUtils.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function close(a, b, eps, msg) {
  assert(Math.abs(a - b) < eps, msg || `${a} != ${b}`);
}

function sourceRef(hFov) {
  return (2 * Math.atan(Math.tan((hFov * Math.PI) / 360) / (4 / 3)) * 180) / Math.PI;
}

// CS2 / Source: fov 90 is horizontal at 4:3 → ~73.74° vertical for Three.js.
close(sourceVFovFromHFov(90), sourceRef(90), 1e-12, 'world fov 90');
close(sourceVFovFromHFov(90), hFovToVFov(90, 4 / 3), 1e-12, '90 is 4:3 horizontal');
assert(sourceVFovFromHFov(90) > 73.7 && sourceVFovFromHFov(90) < 73.8, 'CS2 world vFOV');

// viewmodel_fov uses the same cvar convention as world fov (rival Sk()).
close(sourceVFovFromHFov(68), sourceRef(68), 1e-12, 'viewmodel_fov 68');
assert(sourceVFovFromHFov(68) < 68 - 10, '68 is not vertical FOV');

console.log('MathUtils.test.js ok');

// ---------------------------------------------------------------------------
// src/cs3d/thirdPerson.js
// Pull the camera back from the eyes along the look vector, and stop at the
// first wall so third person never leaves the room. Map Practice and the
// timeline 3D viewer share this so a later tweak lands in both.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';

const BACK = 110;
const UP = 16;
const HALF = 6;

const _fwd = new THREE.Vector3();
const _eye = { x: 0, y: 0, z: 0 };
const _want = { x: 0, y: 0, z: 0 };

/**
 * `camera` is already on the eyes, looking the right way. After this it sits
 * 110u behind and 16u above, or closer if a hull trace hits a wall.
 * @param {import('three').Camera} camera
 * @param {{ traceHull: Function }|null} world  hullWorld from Player, or null
 */
export function placeThirdPersonCamera(camera, world) {
  camera.getWorldDirection(_fwd);
  const eye = camera.position;
  const wx = eye.x - _fwd.x * BACK;
  const wy = eye.y - _fwd.y * BACK + UP;
  const wz = eye.z - _fwd.z * BACK;
  if (world) {
    _eye.x = eye.x;
    _eye.y = -eye.z;
    _eye.z = eye.y - HALF;
    _want.x = wx;
    _want.y = -wz;
    _want.z = wy - HALF;
    const t = world.traceHull(_eye, _want, HALF, 2 * HALF);
    camera.position.set(t.endpos.x, t.endpos.z + HALF, -t.endpos.y);
    return;
  }
  camera.position.set(wx, wy, wz);
}

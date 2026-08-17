// ---------------------------------------------------------------------------
// src/cs3d/thirdPerson.js
// Pull the camera back from a point (usually the eyes) and stop at the first
// wall so third person never leaves the room. Map Practice and the timeline
// 3D viewer both sit behind the look vector.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';

export const THIRD_PERSON_BACK = 110;
export const THIRD_PERSON_UP = 16;
const HALF = 6;

const _fwd = new THREE.Vector3();
const _eye = { x: 0, y: 0, z: 0 };
const _want = { x: 0, y: 0, z: 0 };

function pullBack(camera, world, from, wx, wy, wz) {
  if (world) {
    _eye.x = from.x;
    _eye.y = -from.z;
    _eye.z = from.y - HALF;
    _want.x = wx;
    _want.y = -wz;
    _want.z = wy - HALF;
    const t = world.traceHull(_eye, _want, HALF, 2 * HALF);
    camera.position.set(t.endpos.x, t.endpos.z + HALF, -t.endpos.y);
    return;
  }
  camera.position.set(wx, wy, wz);
}

/**
 * `camera` is already on the eyes, looking the right way. After this it sits
 * `dist` behind and 16u above, or closer if a hull trace hits a wall.
 * @param {import('three').Camera} camera
 * @param {{ traceHull: Function }|null} world  hullWorld from Player, or null
 * @param {number} [dist]
 */
export function placeThirdPersonCamera(camera, world, dist = THIRD_PERSON_BACK) {
  camera.getWorldDirection(_fwd);
  const eye = camera.position;
  const d = dist > 0 ? dist : THIRD_PERSON_BACK;
  pullBack(
    camera,
    world,
    eye,
    eye.x - _fwd.x * d,
    eye.y - _fwd.y * d + THIRD_PERSON_UP,
    eye.z - _fwd.z * d
  );
}

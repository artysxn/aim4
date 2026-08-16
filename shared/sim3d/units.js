// ---------------------------------------------------------------------------
// shared/sim3d/units.js
// The one place that knows how Source coordinates become scene coordinates.
// (CS3D-PLAN §3: no coordinate math anywhere else.)
//
//   Source: x east, y north, z up, 1 unit = 0.0254 m, yaw 0 = +x, yaw grows
//           toward +y, pitch positive = looking down.
//   Scene:  three.js y-up, right-handed, still in Source UNITS (not metres),
//           three(x, y, z) = source(x, z, -y).
//
// Why units, not metres: every replay tick, every sim position and every
// movement constant is already in units; keeping the scene in units means the
// viewer and the future engine3d read those numbers straight, and yaw is
// three's `rotation.y` with no sign flip for an object whose forward is +x
// (source yaw θ → direction (cos θ, sin θ, 0) → scene (cos θ, 0, -sin θ),
// exactly a +θ rotation about y). A three.js CAMERA looks down -z, so its
// rotation.y is θ - 90°: use cameraYawFromSource for cameras.
//
// VRF's glTF export uses metres, y-up, with x_g = y_s, y_g = z_s, z_g = x_s.
// VRF_TO_SCENE_MAT4 undoes that at pack time so no runtime code sees it.
// ---------------------------------------------------------------------------

export const UNIT_M = 0.0254;
export const DEG = Math.PI / 180;

/** Source (x, y, z) → scene [x, y, z]. */
export function sourceToScene(x, y, z) {
  return [x, z, -y];
}

/** Scene (x, y, z) → source [x, y, z]. */
export function sceneToSource(x, y, z) {
  return [x, -z, y];
}

/** Source view angles (degrees) → object yaw/pitch (radians, +x-forward object, Euler 'YXZ'). */
export function sourceAnglesToScene(pitchDeg, yawDeg) {
  return { yaw: yawDeg * DEG, pitch: -pitchDeg * DEG };
}

/** Object yaw/pitch (radians) → source view angles (degrees). */
export function sceneAnglesToSource(yaw, pitch) {
  return { pitch: -pitch / DEG, yaw: yaw / DEG };
}

/** Source yaw (degrees) → three.js camera rotation.y (radians); cameras look down -z. */
export function cameraYawFromSource(yawDeg) {
  return yawDeg * DEG - Math.PI / 2;
}

/** three.js camera rotation.y (radians) → source yaw (degrees, wrapped to [0, 360)). */
export function sourceYawFromCamera(yaw) {
  const d = ((yaw + Math.PI / 2) / DEG) % 360;
  return d < 0 ? d + 360 : d;
}

/** Unit forward vector in scene space for a source yaw/pitch (degrees). */
export function sourceAnglesToForward(pitchDeg, yawDeg) {
  const p = pitchDeg * DEG;
  const y = yawDeg * DEG;
  const cp = Math.cos(p);
  // Source forward = (cos p cos y, cos p sin y, -sin p) → scene via (x, z, -y).
  return [cp * Math.cos(y), -Math.sin(p), -cp * Math.sin(y)];
}

/**
 * VRF glTF frame (metres; x=source y, y=source z, z=source x) → scene frame.
 * Column-major 4x4 for gltf-transform / three.Matrix4.fromArray.
 * scene = (g.z, g.y, -g.x) / UNIT_M — a proper rotation times a uniform scale.
 */
const K = 1 / UNIT_M;
export const VRF_TO_SCENE_MAT4 = Object.freeze([0, 0, -K, 0, 0, K, 0, 0, K, 0, 0, 0, 0, 0, 0, 1]);

/** Player hull + eye heights (units), the same numbers SourceMovement.js uses in metres. */
export const HULL = Object.freeze({
  width: 32,
  standHeight: 72,
  crouchHeight: 54,
  standEye: 64.06,
  crouchEye: 46.04,
  stepHeight: 18
});

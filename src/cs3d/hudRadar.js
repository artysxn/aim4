// ---------------------------------------------------------------------------
// src/cs3d/hudRadar.js
// Practice HUD radar: player stays in the middle, the overview rotates so
// look direction is up, and the circle shows a local window rather than the
// whole map. World units so every map feels the same zoom.
// ---------------------------------------------------------------------------

import { calibrationFor, worldToRadar, RADAR_SIZE } from '../replays/viewer/mapCalibration.js';

/** World units across the radar circle. */
export const HUD_RADAR_WORLD = 2200;

export function hudRadarRotation(yawDeg) {
  return ((Number(yawDeg) || 0) * Math.PI) / 180 - Math.PI / 2;
}

export function hudRadarScale(mapCode, canvasSize) {
  const cal = calibrationFor(mapCode);
  return (canvasSize * cal.scale) / HUD_RADAR_WORLD;
}

/**
 * World point -> HUD canvas pixel with the player at the centre and facing up.
 * @param {string} mapCode
 * @param {number} x
 * @param {number} y
 * @param {{ x: number, y: number }} originRadar  player in 1024 radar space
 * @param {number} yawDeg
 * @param {number} size
 * @param {{ x?: number, y?: number }} [out]
 */
export function worldToHudRadar(mapCode, x, y, originRadar, yawDeg, size, out = {}) {
  worldToRadar(mapCode, x, y, out);
  const dx = out.x - originRadar.x;
  const dy = out.y - originRadar.y;
  const ang = hudRadarRotation(yawDeg);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const scale = hudRadarScale(mapCode, size);
  out.x = size / 2 + (dx * c - dy * s) * scale;
  out.y = size / 2 + (dx * s + dy * c) * scale;
  return out;
}

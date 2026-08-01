// ---------------------------------------------------------------------------
// replays/viewer/mapCalibration.js
// World coordinates -> radar pixels, per map.
//
// Every radar image in public/maps/radar is 1024x1024, and each map's
// overview declares the world point its top-left corner sits on (pos_x,
// pos_y) plus how many world units one pixel covers (scale). That is the
// whole transform:
//
//   px = (worldX - posX) / scale
//   py = (posY - worldY) / scale      (world Y grows north, pixels grow down)
//
// Values match Valve's overview definitions. If a map gets re-scaled in an
// update, this table is the only thing that needs correcting.
// ---------------------------------------------------------------------------

export const RADAR_SIZE = 1024;

/**
 * @typedef {object} MapCalibration
 * @property {number} posX     world X at pixel column 0
 * @property {number} posY     world Y at pixel row 0
 * @property {number} scale    world units per pixel
 * @property {number} [lowerZ] stacked maps (Nuke): z below this is the lower
 *                             floor. Matches CS2 overview AltitudeMin/Max split
 *                             (default ≥ lowerZ, lower < lowerZ).
 */

/** Keyed by the map codes in the round naming scheme. */
export const CALIBRATION = {
  ANC: { posX: -2953, posY: 2164, scale: 5.0 },
  DD2: { posX: -2476, posY: 3239, scale: 4.4 },
  INF: { posX: -2087, posY: 3870, scale: 4.9 },
  CCH: { posX: -2000, posY: 3250, scale: 5.5 },
  MIR: { posX: -3230, posY: 1713, scale: 5.0 },
  // Nuke: CS2 default radar AltitudeMin -495 / lower radar AltitudeMax -495.
  NUK: { posX: -3453, posY: 2887, scale: 7.0, lowerZ: -495 },
  ANU: { posX: -2796, posY: 3328, scale: 5.22 }
};

export function calibrationFor(mapCode) {
  return CALIBRATION[mapCode] || CALIBRATION.DD2;
}

/**
 * World point -> radar pixel, in the image's own 1024x1024 space. The
 * renderer then applies its own view transform (fit, zoom, pan).
 */
export function worldToRadar(mapCode, x, y, out = {}) {
  const c = calibrationFor(mapCode);
  out.x = (x - c.posX) / c.scale;
  out.y = (c.posY - y) / c.scale;
  return out;
}

/** Inverse, for turning a click back into a world position. */
export function radarToWorld(mapCode, px, py, out = {}) {
  const c = calibrationFor(mapCode);
  out.x = px * c.scale + c.posX;
  out.y = c.posY - py * c.scale;
  return out;
}

/**
 * True when a player is on the lower level of a stacked map (Nuke: z < -495).
 * Used with the dual radar images so off-floor droplets can be dimmed.
 */
export function isLowerLevel(mapCode, z) {
  const c = calibrationFor(mapCode);
  return c.lowerZ !== undefined && z < c.lowerZ;
}

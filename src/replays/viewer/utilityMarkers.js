// ---------------------------------------------------------------------------
// replays/viewer/utilityMarkers.js
// One appearance for a piece of utility drawn on a radar.
//
// The timeline round viewer, the Drawing Board and the Team utility archive all
// draw the same four markers, and all three had grown their own copy of the
// colours, alphas and radii. They drifted: the archive faded smokes to 0.45 and
// fires to 0.35, the board drew both at full-circle rings with no flame icon,
// and neither matched what the viewer put on screen. The same smoke landing in
// the same spot looked like three different smokes depending on which page you
// were on.
//
// The viewer is the reference, so this module is its static half: fill, ring
// and icon, without the time-driven parts (the countdown arc, the number, and
// the HE punch-through) that only mean something while a demo is playing.
//
// Time-independent, so the board and the archive can call it as-is and the
// viewer can layer its countdown on top of the same base.
// ---------------------------------------------------------------------------

import { loadEquipmentIcon } from './equipmentIcons.js';

/** World-unit footprints. CS smoke is ~144u across, a molotov pool ~120u. */
export const SMOKE_RADIUS_UNITS = 144;
export const FIRE_RADIUS_UNITS = 120;

/** Lifetimes in seconds, for the surfaces that do show a countdown. */
export const SMOKE_SECONDS = 22;
export const FIRE_SECONDS = 7;

/**
 * Every colour a utility marker uses, in one object.
 *
 * Neutral ring colours only. A surface that knows which side threw the nade
 * passes its own `ringColor`, which is how the viewer tints the ring T or CT.
 */
export const UTIL_STYLE = Object.freeze({
  smoke: { fill: 'rgba(160, 168, 180, 0.92)', ring: '#a0a8b4', alpha: 0.55 },
  fire: { fill: '#e24e2c', ring: '#e2622a', alpha: 0.4 },
  he: { ring: '#7dff6a', core: '#6dff5a' },
  flash: { fill: 'rgba(255, 255, 255, 0.85)', ring: '#b5b5b5' }
});

/** Point markers (HE, flash) are sized in screen pixels, not world units. */
const HE_RADIUS_PX = 5.5;
const FLASH_RADIUS_PX = 5;

/** Normalize the type names the three call sites use to one of four shapes. */
export function utilityShape(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'smokegrenade' || t === 'smoke') return 'smoke';
  if (t === 'molotov' || t === 'incgrenade' || t === 'inferno' || t === 'fire') return 'fire';
  if (t === 'hegrenade' || t === 'he') return 'he';
  return 'flash';
}

/** Radius in world units for the area shapes, or 0 for the point markers. */
export function utilityRadiusUnits(type) {
  const shape = utilityShape(type);
  if (shape === 'smoke') return SMOKE_RADIUS_UNITS;
  if (shape === 'fire') return FIRE_RADIUS_UNITS;
  return 0;
}

/**
 * Draw one marker.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} opts
 * @param {string} opts.type       grenade type, in any of the spellings above
 * @param {number} opts.x          canvas x, device pixels
 * @param {number} opts.y          canvas y, device pixels
 * @param {number} [opts.radius]   area radius in device pixels (smoke / fire)
 * @param {number} [opts.dpr=1]
 * @param {string} [opts.ringColor]  overrides the neutral ring, for side tinting
 * @param {number} [opts.alpha=1]    multiplied into the shape's own opacity
 * @param {boolean} [opts.active]    archive selection: brighter, thicker ring
 * @param {boolean} [opts.icon=true] draw the flame icon inside a fire disc
 * @param {() => void} [opts.onIconLoad]  repaint hook, icons decode async
 */
export function drawUtilityMarker(ctx, opts) {
  const {
    type,
    x,
    y,
    radius = 0,
    dpr = 1,
    ringColor = '',
    alpha = 1,
    active = false,
    icon = true,
    onIconLoad
  } = opts;

  const shape = utilityShape(type);
  const ringWidth = active ? 2 * dpr : Math.max(0.75, 1 * dpr);

  ctx.save();
  if (shape === 'smoke') {
    const style = UTIL_STYLE.smoke;
    ctx.globalAlpha = style.alpha * alpha;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.globalAlpha = 0.95 * alpha;
    ctx.strokeStyle = active ? '#ffffff' : ringColor || style.ring;
    ctx.lineWidth = ringWidth;
    ctx.stroke();
  } else if (shape === 'fire') {
    const style = UTIL_STYLE.fire;
    ctx.globalAlpha = style.alpha * alpha;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.globalAlpha = 0.95 * alpha;
    ctx.strokeStyle = active ? '#ffffff' : ringColor || style.ring;
    ctx.lineWidth = ringWidth;
    ctx.stroke();
    if (icon) drawFireIcon(ctx, { x, y, radius, dpr, type, alpha, onIconLoad });
  } else if (shape === 'he') {
    const style = UTIL_STYLE.he;
    const r = (active ? 7 : HE_RADIUS_PX) * dpr;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = style.ring;
    ctx.lineWidth = 1.6 * dpr;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = style.core;
    ctx.fill();
  } else {
    const style = UTIL_STYLE.flash;
    const r = (active ? 6.5 : FLASH_RADIUS_PX) * dpr;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.strokeStyle = active ? '#ffffff' : style.ring;
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The flame sitting inside a fire disc. Offset above centre so it does not
 * collide with the countdown the viewer draws in the middle.
 */
export function drawFireIcon(ctx, { x, y, radius, dpr = 1, type, alpha = 1, onIconLoad }) {
  const stem = utilityShape(type) === 'fire' && String(type).toLowerCase() === 'incgrenade'
    ? 'incgrenade'
    : 'molotov';
  const img = loadEquipmentIcon(stem, () => onIconLoad?.());
  const iconR = Math.min(11 * dpr, radius * 0.3);
  const iconY = y - radius * 0.3;

  ctx.save();
  ctx.globalAlpha = 0.95 * alpha;
  if (img?.complete && img.naturalWidth > 0) {
    const scale = Math.min((iconR * 1.7) / img.naturalWidth, (iconR * 1.7) / img.naturalHeight);
    const iw = img.naturalWidth * scale;
    const ih = img.naturalHeight * scale;
    ctx.drawImage(img, x - iw / 2, iconY - ih / 2, iw, ih);
  } else {
    // Fallback flame blob, so a slow icon load is not a blank disc.
    ctx.fillStyle = '#ff6a2a';
    ctx.beginPath();
    ctx.moveTo(x, iconY - iconR);
    ctx.quadraticCurveTo(x + iconR, iconY, x, iconY + iconR * 0.7);
    ctx.quadraticCurveTo(x - iconR, iconY, x, iconY - iconR);
    ctx.fill();
  }
  ctx.restore();
}

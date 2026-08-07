// ---------------------------------------------------------------------------
// replays/zones/visionLayers.js
// Painted vision-block / elevated / underpass masks for FOV rays + editor brushes.
// Stored as piece lists on the zone network (not as positions).
//
// Vision block: always stops FOV rays.
// Elevated: blocks viewers standing outside elevated paint; ignored when the
// viewer stands on elevated (you can see onto and past the ridge).
// Underpass: inverse of elevated — outsiders see into it; from inside, only the
// underpass interior is visible (boundary blocks looking out).
// ---------------------------------------------------------------------------

import { RADAR_SIZE, radarToWorld, worldToRadar } from '../viewer/mapCalibration.js';
import {
  normalizeRect,
  pointInPiece,
  pointInRing,
  subtractRectFromPieces
} from './zoneGeom.js';
import {
  cleanRegionLevel,
  filterPiecesByLevel,
  mapHasStackedFloors,
  withPieceLevel
} from './zoneLevel.js';

export const VISION_LAYER_PIECES_MAX = 5000;
/** Default brush diameter in radar pixels. */
export const DEFAULT_BRUSH_PX = 8;
export const MIN_BRUSH_PX = 3;
export const MAX_BRUSH_PX = 28;

/**
 * @param {unknown} pieces
 * @param {number} [max]
 * @returns {Array<{type:'rect',x:number,y:number,w:number,h:number}|{type:'poly',ring:number[][]}>}
 */
export function sanitizeLayerPieces(pieces, max = VISION_LAYER_PIECES_MAX) {
  if (!Array.isArray(pieces)) return [];
  const out = [];
  for (const piece of pieces.slice(0, max)) {
    if (!piece || typeof piece !== 'object') continue;
    const level = cleanRegionLevel(piece.level);
    const asRect =
      piece.type === 'rect' ||
      (piece.type == null &&
        Number.isFinite(Number(piece.x)) &&
        Number.isFinite(Number(piece.y)) &&
        Number.isFinite(Number(piece.w)) &&
        Number.isFinite(Number(piece.h)));
    if (asRect) {
      const x = Number(piece.x);
      const y = Number(piece.y);
      const w = Number(piece.w);
      const h = Number(piece.h);
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
      out.push({ type: 'rect', x, y, w, h, level });
      continue;
    }
    if (piece.type === 'poly' && Array.isArray(piece.ring) && piece.ring.length >= 3) {
      const ring = [];
      for (const p of piece.ring.slice(0, 64)) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const px = Number(p[0]);
        const py = Number(p[1]);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        ring.push([px, py]);
      }
      if (ring.length >= 3) out.push({ type: 'poly', ring, level });
    }
  }
  return out;
}

export function ensureVisionLayers(network) {
  if (!network || typeof network !== 'object') return network;
  if (!Array.isArray(network.visionBlocks)) network.visionBlocks = [];
  if (!Array.isArray(network.elevated)) network.elevated = [];
  if (!Array.isArray(network.underpasses)) network.underpasses = [];
  return network;
}

/** True when the map has any painted vision-block / elevated / underpass brush. */
export function hasVisionLayers(network) {
  return Boolean(
    (network?.visionBlocks && network.visionBlocks.length) ||
      (network?.elevated && network.elevated.length) ||
      (network?.underpasses && network.underpasses.length)
  );
}

export function pointInPieces(x, y, pieces) {
  if (!pieces?.length) return false;
  for (const p of pieces) {
    if (pointInPiece(x, y, p)) return true;
  }
  return false;
}

/** World-space brush stamp from a radar cursor + brush diameter (radar px). */
export function brushStampRect(mapCode, radarX, radarY, brushPx) {
  const size = Math.max(MIN_BRUSH_PX, Math.min(MAX_BRUSH_PX, Math.round(brushPx)));
  const half = size / 2;
  const rx0 = Math.floor(radarX - half);
  const ry0 = Math.floor(radarY - half);
  const a = radarToWorld(mapCode, rx0, ry0, {});
  const b = radarToWorld(mapCode, rx0 + size, ry0 + size, {});
  const r = normalizeRect(a.x, a.y, b.x, b.y);
  return { ...r, type: 'rect' };
}

/**
 * Paint one brush stamp onto a layer. Returns true if a piece was added.
 * Snaps to the stamp grid and skips if the center is already covered on this floor.
 * @param {object} [opts]
 * @param {'default'|'lower'} [opts.level]
 */
export function paintBrushStamp(pieces, mapCode, radarX, radarY, brushPx, opts = {}) {
  const level = cleanRegionLevel(opts.level);
  const stamp = withPieceLevel(brushStampRect(mapCode, radarX, radarY, brushPx), level);
  const cx = stamp.x + stamp.w * 0.5;
  const cy = stamp.y + stamp.h * 0.5;
  const peers = filterPiecesByLevel(pieces, level, mapCode);
  if (pointInPieces(cx, cy, peers)) return false;
  if (pieces.length >= VISION_LAYER_PIECES_MAX) return false;
  pieces.push(stamp);
  return true;
}

/**
 * Erase with the same stamp shape (subtract from rect pieces on this floor only).
 * @param {object} [opts]
 * @param {'default'|'lower'} [opts.level]
 */
export function eraseBrushStamp(pieces, mapCode, radarX, radarY, brushPx, opts = {}) {
  const level = cleanRegionLevel(opts.level);
  const stamp = brushStampRect(mapCode, radarX, radarY, brushPx);
  const stacked = mapHasStackedFloors(mapCode);
  const same = [];
  const other = [];
  for (const p of pieces) {
    if (stacked && cleanRegionLevel(p.level) !== level) other.push(p);
    else same.push(p);
  }
  const nextSame = subtractRectFromPieces(same, stamp).map((p) =>
    stacked || p.level != null ? withPieceLevel(p, level) : p
  );
  const changed =
    nextSame.length !== same.length || nextSame.some((p, i) => p !== same[i]);
  if (!changed) return false;
  pieces.length = 0;
  pieces.push(...other, ...nextSame);
  return true;
}

/**
 * Sample along a radar stroke and paint/erase stamps.
 * @returns {number} stamps applied
 */
export function strokeBrush(
  pieces,
  mapCode,
  from,
  to,
  brushPx,
  { erase = false, level = 'default' } = {}
) {
  const size = Math.max(MIN_BRUSH_PX, Math.min(MAX_BRUSH_PX, Math.round(brushPx)));
  const step = Math.max(1, size * 0.45);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const n = dist < 1e-6 ? 1 : Math.max(1, Math.ceil(dist / step));
  const opts = { level };
  let applied = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const rx = from.x + dx * t;
    const ry = from.y + dy * t;
    if (erase) {
      if (eraseBrushStamp(pieces, mapCode, rx, ry, size, opts)) applied++;
    } else if (paintBrushStamp(pieces, mapCode, rx, ry, size, opts)) {
      applied++;
    }
  }
  return applied;
}

function fillWorldRectMask(mask, mapCode, r) {
  const a = worldToRadar(mapCode, r.x, r.y, {});
  const b = worldToRadar(mapCode, r.x + r.w, r.y + r.h, {});
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x)));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y)));
  const x1 = Math.min(RADAR_SIZE - 1, Math.ceil(Math.max(a.x, b.x) - 1e-6));
  const y1 = Math.min(RADAR_SIZE - 1, Math.ceil(Math.max(a.y, b.y) - 1e-6));
  for (let y = y0; y <= y1; y++) {
    const row = y * RADAR_SIZE;
    for (let x = x0; x <= x1; x++) mask[row + x] = 1;
  }
}

function fillPolyMask(mask, mapCode, ring) {
  if (!ring?.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const radarRing = [];
  for (const [wx, wy] of ring) {
    const p = worldToRadar(mapCode, wx, wy, {});
    radarRing.push([p.x, p.y]);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(RADAR_SIZE - 1, Math.ceil(maxX));
  const y1 = Math.min(RADAR_SIZE - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const row = y * RADAR_SIZE;
    for (let x = x0; x <= x1; x++) {
      if (pointInRing(x + 0.5, y + 0.5, radarRing)) mask[row + x] = 1;
    }
  }
}

/**
 * Bake a radar bitmask for fast ray tests.
 * @returns {{ mask: Uint8Array, testWorld: (wx:number, wy:number)=>boolean }}
 */
export function bakeLayerMask(mapCode, pieces) {
  const mask = new Uint8Array(RADAR_SIZE * RADAR_SIZE);
  const scratch = {};
  for (const piece of pieces || []) {
    if (!piece) continue;
    if (piece.type === 'rect' || (piece.w > 0 && piece.h > 0 && !piece.ring)) {
      fillWorldRectMask(mask, mapCode, piece);
    } else if (piece.type === 'poly' || piece.ring?.length) {
      fillPolyMask(mask, mapCode, piece.ring);
    }
  }
  const testWorld = (wx, wy) => {
    worldToRadar(mapCode, wx, wy, scratch);
    const x = scratch.x | 0;
    const y = scratch.y | 0;
    if (x < 0 || y < 0 || x >= RADAR_SIZE || y >= RADAR_SIZE) return false;
    return mask[y * RADAR_SIZE + x] !== 0;
  };
  return { mask, testWorld };
}

/**
 * Cached vision / elevated / underpass testers on the network object.
 * On stacked maps (Nuke), only pieces for `level` are baked into the masks.
 *
 * @param {object} network
 * @param {string} mapCode
 * @param {'default'|'lower'} [level]
 * @returns {{
 *   visionBlockAt: Function,
 *   elevatedAt: Function,
 *   underpassAt: Function,
 *   blockerAt: (x:number,y:number,elevatedDisabled?:boolean)=>boolean,
 *   level: string
 * }}
 */
export function getVisionLayerTests(network, mapCode, level = 'default') {
  ensureVisionLayers(network);
  const floor = cleanRegionLevel(level);
  const key = `${mapCode}|${floor}|${network.updatedAt || 0}|${network.visionBlocks.length}|${network.elevated.length}|${network.underpasses.length}|${network._layerPaintGen || 0}`;
  if (network._layerTests?.key === key) return network._layerTests;

  const visionPieces = filterPiecesByLevel(network.visionBlocks, floor, mapCode);
  const elevPieces = filterPiecesByLevel(network.elevated, floor, mapCode);
  const underPieces = filterPiecesByLevel(network.underpasses, floor, mapCode);
  const vision = bakeLayerMask(mapCode, visionPieces);
  const elev = bakeLayerMask(mapCode, elevPieces);
  const under = bakeLayerMask(mapCode, underPieces);
  const visionBlockAt = vision.testWorld;
  const elevatedAt = elev.testWorld;
  const underpassAt = under.testWorld;
  /** One lookup: vision blocks always; elevated unless viewer stands on elevated. */
  const blockerAt = (wx, wy, elevatedDisabled = false) => {
    if (visionBlockAt(wx, wy)) return true;
    if (!elevatedDisabled && elevatedAt(wx, wy)) return true;
    return false;
  };
  const tests = {
    key,
    level: floor,
    visionBlockAt,
    elevatedAt,
    underpassAt,
    blockerAt,
    // Raw rasters so the segment extractor can OR them without re-baking.
    visionMask: vision.mask,
    elevatedMask: elev.mask,
    underpassMask: under.mask
  };
  network._layerTests = tests;
  return tests;
}

/**
 * World units between samples when walking a sight line.
 *
 * The layer masks are rasterised at RADAR_SIZE, which is roughly 5 world units
 * per pixel on every supported map, so 4 is a shade finer than the data and
 * cannot step over a painted block.
 */
const SIGHT_STEP_UNITS = 4;
/** Ceiling on samples for one line, so a map-length ray stays cheap. */
const SIGHT_MAX_SAMPLES = 600;
/**
 * World units at each end of the line that are not tested.
 *
 * The masks are rasterised at radar resolution, roughly 5 world units per
 * pixel, and players stand flush against walls constantly. Without this margin
 * a player whose own position rounds into a painted block reads as blind along
 * every line they hold, including the open angle they are actually watching.
 * A CS player hitbox is ~32 units wide, so 40 clears the body plus rounding.
 */
const SIGHT_ENDPOINT_MARGIN = 40;

/**
 * Is the sight line between two world points broken by painted vision blocks?
 *
 * This is the map's own geometry, the same layer the zone editor paints and the
 * viewer draws. Without it the only occluder available is smoke, which means
 * two players on opposite sides of a wall read as though they can see each
 * other. That matters most for crosshair placement, where a "you were engaged
 * and looking the wrong way" event fires for a duel that could never happen.
 *
 * Elevated geometry is deliberately NOT included: it blocks vision only for
 * players who are not themselves on it, and this test has no height context.
 * Vision blocks are unconditional, which is what makes them safe here.
 *
 * @param {(x: number, y: number) => boolean} visionBlockAt  from getVisionLayerTests
 * @returns {boolean} true when something solid is in the way
 */
export function segmentCrossesVision(visionBlockAt, x0, y0, x1, y1) {
  if (typeof visionBlockAt !== 'function') return false;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return false;

  // Two players closer together than the margins can see each other for any
  // purpose this is used for, so there is nothing worth testing.
  if (length <= SIGHT_ENDPOINT_MARGIN * 2) return false;

  const steps = Math.min(SIGHT_MAX_SAMPLES, Math.max(2, Math.ceil(length / SIGHT_STEP_UNITS)));
  const skip = SIGHT_ENDPOINT_MARGIN / length;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (t < skip || t > 1 - skip) continue;
    if (visionBlockAt(x0 + dx * t, y0 + dy * t)) return true;
  }
  return false;
}

/** Bump editor cache after painting without changing updatedAt yet. */
export function bumpLayerPaintGen(network) {
  network._layerPaintGen = (network._layerPaintGen || 0) + 1;
  network._layerTests = null;
}

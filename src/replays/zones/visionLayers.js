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
      out.push({ type: 'rect', x, y, w, h });
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
      if (ring.length >= 3) out.push({ type: 'poly', ring });
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
 * Snaps to the stamp grid and skips if the center is already covered.
 */
export function paintBrushStamp(pieces, mapCode, radarX, radarY, brushPx) {
  const stamp = brushStampRect(mapCode, radarX, radarY, brushPx);
  const cx = stamp.x + stamp.w * 0.5;
  const cy = stamp.y + stamp.h * 0.5;
  if (pointInPieces(cx, cy, pieces)) return false;
  if (pieces.length >= VISION_LAYER_PIECES_MAX) return false;
  pieces.push(stamp);
  return true;
}

/** Erase with the same stamp shape (subtract from rect pieces). */
export function eraseBrushStamp(pieces, mapCode, radarX, radarY, brushPx) {
  const stamp = brushStampRect(mapCode, radarX, radarY, brushPx);
  const next = subtractRectFromPieces(pieces, stamp);
  const changed = next.length !== pieces.length || next.some((p, i) => p !== pieces[i]);
  if (!changed) return false;
  pieces.length = 0;
  pieces.push(...next);
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
  { erase = false } = {}
) {
  const size = Math.max(MIN_BRUSH_PX, Math.min(MAX_BRUSH_PX, Math.round(brushPx)));
  const step = Math.max(1, size * 0.45);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const n = dist < 1e-6 ? 1 : Math.max(1, Math.ceil(dist / step));
  let applied = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const rx = from.x + dx * t;
    const ry = from.y + dy * t;
    if (erase) {
      if (eraseBrushStamp(pieces, mapCode, rx, ry, size)) applied++;
    } else if (paintBrushStamp(pieces, mapCode, rx, ry, size)) {
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
 * @returns {{
 *   visionBlockAt: Function,
 *   elevatedAt: Function,
 *   underpassAt: Function,
 *   blockerAt: (x:number,y:number,elevatedDisabled?:boolean)=>boolean
 * }}
 */
export function getVisionLayerTests(network, mapCode) {
  ensureVisionLayers(network);
  const key = `${mapCode}|${network.updatedAt || 0}|${network.visionBlocks.length}|${network.elevated.length}|${network.underpasses.length}|${network._layerPaintGen || 0}`;
  if (network._layerTests?.key === key) return network._layerTests;

  const vision = bakeLayerMask(mapCode, network.visionBlocks);
  const elev = bakeLayerMask(mapCode, network.elevated);
  const under = bakeLayerMask(mapCode, network.underpasses);
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

/** Bump editor cache after painting without changing updatedAt yet. */
export function bumpLayerPaintGen(network) {
  network._layerPaintGen = (network._layerPaintGen || 0) + 1;
  network._layerTests = null;
}

// ---------------------------------------------------------------------------
// replays/zones/zoneOverlay.js
// Timeline "positions" overlay: who has been where up to the playhead, who is
// there now, who can see an empty/occupied position (FOV + radar LOS), and
// surround-fill for neutrals locked in by one side.
//
// Colors: gray empty, T yellow, CT blue, both red; active vs controlled
// (darker) for single-side claims.
// ---------------------------------------------------------------------------

import { positionsAtPoint } from './pointInZone.js';
import {
  boundsOverlap,
  pieceBounds,
  rectsFromPieces
} from './zoneGeom.js';
import { RADAR_SIZE, worldToRadar } from '../viewer/mapCalibration.js';

/** @typedef {'empty'|'t-active'|'t-control'|'ct-active'|'ct-control'|'contested'|'contested-active'} ZonePaint */

export const ZONE_PAINT = {
  empty: { fill: 'rgba(130,138,150,0.22)', stroke: 'rgba(170,178,190,0.55)' },
  't-active': { fill: 'rgba(240,193,74,0.48)', stroke: '#f0c14a' },
  't-control': { fill: 'rgba(150,115,28,0.34)', stroke: '#9a7620' },
  'ct-active': { fill: 'rgba(91,159,212,0.48)', stroke: '#5b9fd4' },
  'ct-control': { fill: 'rgba(40,90,130,0.34)', stroke: '#2f6a96' },
  contested: { fill: 'rgba(210,70,70,0.40)', stroke: '#d45555' },
  'contested-active': { fill: 'rgba(240,70,70,0.52)', stroke: '#ff5a5a' }
};

/** Half-angle of the vision cone used for sight-control (degrees). */
const SIGHT_FOV_DEG = 30;
/** Fraction of a position that must be in-FOV + clear LOS to claim it. */
const SIGHT_COVER = 0.6;
/** Radar alpha at or below this is a wall (transparent PNG). */
const WALL_ALPHA = 28;
/** Smoke lifetime — matches radar renderer. */
const SMOKE_SECONDS = 22;
/** World-unit pad when deciding two positions share a border. */
const ADJACENT_PAD = 18;
/** Sample points per position for sight coverage. */
const SIGHT_SAMPLES = 24;

const adjacencyCache = new WeakMap();
const sampleCache = new WeakMap();
/** @type {Map<string, { clearWorld: Function, image: CanvasImageSource }>} */
const losCache = new Map();

/**
 * First tick each side entered each position (sampled once per second).
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {{ sampleAll: Function }} args.track
 * @param {object} args.network
 * @returns {{ firstT: Map<string, number>, firstCT: Map<string, number> } | null}
 */
export function buildZonePresence({ meta, track, network }) {
  if (!meta || !track || !network?.zones?.length) return null;
  const from = meta.freezeEndTick ?? meta.startTick ?? 0;
  const to = Math.max(from, meta.endTick ?? from);
  const tickRate = meta.tickRate || 64;
  const players = meta.players || [];
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  /** @type {Map<string, number>} */
  const firstT = new Map();
  /** @type {Map<string, number>} */
  const firstCT = new Map();
  const scratch = [];

  for (let tick = from; tick <= to; tick += tickRate) {
    track.sampleAll(tick, scratch);
    for (const p of players) {
      const side = teamSides[p.team];
      if (side !== 'T' && side !== 'CT') continue;
      const s = scratch[p.slot];
      if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      const hits = positionsAtPoint(s.x, s.y, network);
      const map = side === 'T' ? firstT : firstCT;
      for (const z of hits) {
        if (!z?.id || map.has(z.id)) continue;
        map.set(z.id, tick);
      }
    }
  }
  return { firstT, firstCT };
}

/**
 * Position ids currently occupied by living players on each side.
 * @returns {{ t: Set<string>, ct: Set<string> }}
 */
export function activePositionsAt({ meta, states, network }) {
  const t = new Set();
  const ct = new Set();
  if (!meta || !network?.zones?.length) return { t, ct };
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  for (const p of meta.players || []) {
    const side = teamSides[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    const s = states?.[p.slot];
    if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    for (const z of positionsAtPoint(s.x, s.y, network)) {
      if (!z?.id) continue;
      if (side === 'T') t.add(z.id);
      else ct.add(z.id);
    }
  }
  return { t, ct };
}

/** Absolute yaw difference in [0, 180]. */
function yawDelta(a, b) {
  let d = Math.abs(Number(a) - Number(b)) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** Source yaw toward a point: 0 = +X, 90 = +Y. */
function yawToward(from, to) {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

/** Shoelace area for a closed or open ring in world units². */
function ringArea(ring) {
  if (!ring || ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum) * 0.5;
}

/** World-unit² area of one position (sum of its pieces). */
export function positionArea(zone) {
  let area = 0;
  for (const p of zone?.pieces || []) {
    if (!p) continue;
    if (p.type === 'rect' || (p.w > 0 && p.h > 0 && !p.ring)) {
      area += Math.max(0, Number(p.w) || 0) * Math.max(0, Number(p.h) || 0);
      continue;
    }
    if (p.type === 'poly' || p.ring?.length) {
      area += ringArea(p.ring);
      continue;
    }
    const b = pieceBounds(p);
    if (Number.isFinite(b.minX)) {
      area += Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
    }
  }
  return area;
}

/** Grid sample points inside a position (for sight coverage). */
function samplePointsForPosition(pos) {
  if (sampleCache.has(pos)) return sampleCache.get(pos);
  /** @type {Array<{x:number,y:number}>} */
  const pts = [];
  const rects = rectsFromPieces(pos.pieces);
  const area = Math.max(1, positionArea(pos));
  for (const r of rects) {
    const share = (r.w * r.h) / area;
    const n = Math.max(1, Math.round(SIGHT_SAMPLES * share));
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * (r.w / Math.max(r.h, 1e-6)))));
    const rows = Math.max(1, Math.ceil(n / cols));
    for (let iy = 0; iy < rows; iy++) {
      for (let ix = 0; ix < cols; ix++) {
        pts.push({
          x: r.x + ((ix + 0.5) / cols) * r.w,
          y: r.y + ((iy + 0.5) / rows) * r.h
        });
      }
    }
  }
  for (const piece of pos.pieces || []) {
    if (piece.type === 'rect' || (piece.w > 0 && piece.h > 0 && !piece.ring)) continue;
    const ring = piece.ring;
    if (!ring?.length) continue;
    const b = pieceBounds(piece);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    pts.push({ x: cx, y: cy });
  }
  if (!pts.length) {
    const b = pieceBounds(pos.pieces?.[0] || { type: 'rect', x: 0, y: 0, w: 0, h: 0 });
    if (Number.isFinite(b.minX)) {
      pts.push({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    }
  }
  sampleCache.set(pos, pts);
  return pts;
}

function rectsShareEdge(a, b, pad = ADJACENT_PAD) {
  const aR = a.x + a.w;
  const aT = a.y + a.h;
  const bR = b.x + b.w;
  const bT = b.y + b.h;
  const yOverlap = Math.min(aT, bT) - Math.max(a.y, b.y);
  const xOverlap = Math.min(aR, bR) - Math.max(a.x, b.x);
  const vert =
    (Math.abs(aR - b.x) <= pad || Math.abs(bR - a.x) <= pad) && yOverlap > pad * 0.5;
  const horiz =
    (Math.abs(aT - b.y) <= pad || Math.abs(bT - a.y) <= pad) && xOverlap > pad * 0.5;
  return vert || horiz;
}

/** Undirected adjacency among positions (shared / near borders). */
export function buildPositionAdjacency(network) {
  if (!network?.zones?.length) return new Map();
  if (adjacencyCache.has(network)) return adjacencyCache.get(network);
  const positions = network.zones.filter((z) => z?.id && !z.hidden && z.pieces?.length);
  /** @type {Map<string, string[]>} */
  const adj = new Map();
  for (const p of positions) adj.set(p.id, []);

  for (let i = 0; i < positions.length; i++) {
    const a = positions[i];
    const aRects = rectsFromPieces(a.pieces);
    const aBounds = a.pieces.reduce(
      (acc, piece) => {
        const b = pieceBounds(piece);
        return {
          minX: Math.min(acc.minX, b.minX),
          minY: Math.min(acc.minY, b.minY),
          maxX: Math.max(acc.maxX, b.maxX),
          maxY: Math.max(acc.maxY, b.maxY)
        };
      },
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    );
    for (let j = i + 1; j < positions.length; j++) {
      const b = positions[j];
      const bRects = rectsFromPieces(b.pieces);
      const bBounds = b.pieces.reduce(
        (acc, piece) => {
          const bb = pieceBounds(piece);
          return {
            minX: Math.min(acc.minX, bb.minX),
            minY: Math.min(acc.minY, bb.minY),
            maxX: Math.max(acc.maxX, bb.maxX),
            maxY: Math.max(acc.maxY, bb.maxY)
          };
        },
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      );
      if (!boundsOverlap(aBounds, bBounds, ADJACENT_PAD)) continue;
      let touch = false;
      for (const ra of aRects) {
        for (const rb of bRects) {
          if (rectsShareEdge(ra, rb)) {
            touch = true;
            break;
          }
        }
        if (touch) break;
      }
      if (!touch && aRects.length && bRects.length) continue;
      if (!touch) {
        // Poly-only / mixed: treat near bounds as adjacent.
        if (!boundsOverlap(aBounds, bBounds, ADJACENT_PAD)) continue;
      }
      adj.get(a.id).push(b.id);
      adj.get(b.id).push(a.id);
    }
  }
  adjacencyCache.set(network, adj);
  return adj;
}

/**
 * Line-of-sight through the radar PNG: transparent pixels are walls.
 * @param {string} mapCode
 * @param {CanvasImageSource} image
 */
export function getRadarLos(mapCode, image) {
  if (!mapCode || !image) return null;
  const hit = losCache.get(mapCode);
  if (hit && hit.image === image) return hit;

  const c = document.createElement('canvas');
  c.width = RADAR_SIZE;
  c.height = RADAR_SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);
  ctx.drawImage(image, 0, 0, RADAR_SIZE, RADAR_SIZE);
  let data;
  try {
    data = ctx.getImageData(0, 0, RADAR_SIZE, RADAR_SIZE).data;
  } catch {
    return null;
  }

  const opaque = (px, py) => {
    const x = px | 0;
    const y = py | 0;
    if (x < 0 || y < 0 || x >= RADAR_SIZE || y >= RADAR_SIZE) return false;
    return data[(y * RADAR_SIZE + x) * 4 + 3] > WALL_ALPHA;
  };

  const a = {};
  const b = {};
  const clearWorld = (x0, y0, x1, y1) => {
    worldToRadar(mapCode, x0, y0, a);
    worldToRadar(mapCode, x1, y1, b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist));
    // Skip the first couple of pixels (player footprint / edge).
    for (let i = 2; i <= steps; i++) {
      const t = i / steps;
      if (!opaque(a.x + dx * t, a.y + dy * t)) return false;
    }
    return true;
  };

  const los = { clearWorld, image };
  losCache.set(mapCode, los);
  return los;
}

/** Position ids that currently have an active smoke on them. */
function smokedPositions(grenades, tick, tickRate, network) {
  const ids = new Set();
  const life = SMOKE_SECONDS * (tickRate || 64);
  for (const g of grenades || []) {
    if (g.type !== 'smokegrenade') continue;
    const det = Number(g.detonateTick);
    if (!Number.isFinite(det) || tick < det || tick > det + life) continue;
    if (!g.at || !Number.isFinite(g.at.x)) continue;
    for (const z of positionsAtPoint(g.at.x, g.at.y, network)) {
      if (z?.id) ids.add(z.id);
    }
  }
  return ids;
}

/**
 * Fraction of sample points in-FOV with clear radar LOS from the player.
 */
function sightCover(player, pos, los) {
  const pts = samplePointsForPosition(pos);
  if (!pts.length) return 0;
  let ok = 0;
  for (const p of pts) {
    if (yawDelta(player.yaw, yawToward(player, p)) > SIGHT_FOV_DEG) continue;
    if (los && !los.clearWorld(player.x, player.y, p.x, p.y)) continue;
    if (!los) continue;
    ok++;
  }
  return ok / pts.length;
}

/**
 * Apply vision claims for the current tick. Mutates `presence` when an empty
 * position is confirmed seen (persists like a foot visit) or when an enemy is
 * seen inside (both sides claim → contested).
 *
 * @returns {{ tSight: Set<string>, ctSight: Set<string>, contestedSight: Set<string> }}
 */
function applyVisionClaims({
  meta,
  states,
  network,
  tick,
  presence,
  active,
  mapCode,
  radarImage,
  grenades
}) {
  const tSight = new Set();
  const ctSight = new Set();
  const contestedSight = new Set();
  if (!meta || !network?.zones?.length || !radarImage) {
    return { tSight, ctSight, contestedSight };
  }
  const los = getRadarLos(mapCode, radarImage);
  if (!los) return { tSight, ctSight, contestedSight };

  const smoked = smokedPositions(grenades, tick, meta.tickRate || 64, network);
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const positions = network.zones.filter((z) => z?.id && !z.hidden && z.pieces?.length);

  for (const p of meta.players || []) {
    const side = teamSides[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    const s = states?.[p.slot];
    if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    if (!Number.isFinite(s.yaw)) continue;
    const viewer = { x: s.x, y: s.y, yaw: s.yaw };

    for (const pos of positions) {
      if (smoked.has(pos.id)) continue;
      if (sightCover(viewer, pos, los) < SIGHT_COVER) continue;

      const hasT = active.t.has(pos.id);
      const hasCt = active.ct.has(pos.id);
      const enemyInside = side === 'T' ? hasCt : hasT;
      const allyInside = side === 'T' ? hasT : hasCt;

      if (enemyInside) {
        contestedSight.add(pos.id);
        if (presence) {
          if (!presence.firstT.has(pos.id)) presence.firstT.set(pos.id, tick);
          if (!presence.firstCT.has(pos.id)) presence.firstCT.set(pos.id, tick);
        }
        continue;
      }
      // Standing in it (or ally is) is already handled by occupancy / visit.
      if (allyInside) continue;
      // Empty and clearly seen → this side controls it.
      if (side === 'T') tSight.add(pos.id);
      else ctSight.add(pos.id);
      if (presence) {
        const map = side === 'T' ? presence.firstT : presence.firstCT;
        if (!map.has(pos.id)) map.set(pos.id, tick);
      }
    }
  }

  // Seen by both sides empty, or contested by sight of enemies.
  for (const id of tSight) {
    if (ctSight.has(id)) {
      contestedSight.add(id);
      tSight.delete(id);
      ctSight.delete(id);
    }
  }
  return { tSight, ctSight, contestedSight };
}

function sideOfPaint(key) {
  if (!key || key === 'empty') return null;
  if (key === 'contested' || key === 'contested-active') return 'both';
  if (key.startsWith('t-')) return 'T';
  if (key.startsWith('ct-')) return 'CT';
  return null;
}

/**
 * Neutrals whose every adjacent border is either still-neutral or owned by
 * exactly one side become that side's controlled. Iterates to a fixpoint so
 * neutral chains fill in (as in the "pocket" next to two CT positions).
 */
function applySurroundControl(paint, network) {
  const adj = buildPositionAdjacency(network);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 64) {
    changed = false;
    for (const pos of network.zones || []) {
      if (!pos?.id || pos.hidden) continue;
      if (paint[pos.id] !== 'empty') continue;
      const neigh = adj.get(pos.id) || [];
      if (!neigh.length) continue;
      let t = false;
      let ct = false;
      let both = false;
      for (const nid of neigh) {
        const s = sideOfPaint(paint[nid] || 'empty');
        if (s == null) continue; // neutral neighbor — allowed, pending
        if (s === 'both') both = true;
        else if (s === 'T') t = true;
        else if (s === 'CT') ct = true;
      }
      if (both || (t && ct)) continue;
      if (t && !ct) {
        paint[pos.id] = 't-control';
        changed = true;
      } else if (ct && !t) {
        paint[pos.id] = 'ct-control';
        changed = true;
      }
    }
  }
}

/**
 * Full paint map for the playhead: foot presence + vision + surround.
 *
 * @param {object} args
 * @returns {Record<string, ZonePaint>}
 */
export function computeZonePaint({
  meta,
  states,
  network,
  tick,
  presence,
  mapCode,
  radarImage,
  grenades
}) {
  /** @type {Record<string, ZonePaint>} */
  const paint = {};
  if (!network?.zones?.length) return paint;

  const active = activePositionsAt({ meta, states, network });
  const { tSight, ctSight, contestedSight } = applyVisionClaims({
    meta,
    states,
    network,
    tick,
    presence,
    active,
    mapCode,
    radarImage,
    grenades
  });

  for (const pos of network.zones) {
    if (!pos?.id || pos.hidden) continue;
    let tVis = (presence?.firstT.get(pos.id) ?? Infinity) <= tick;
    let ctVis = (presence?.firstCT.get(pos.id) ?? Infinity) <= tick;
    // Sight this frame still counts even before presence has been built.
    if (tSight.has(pos.id) || contestedSight.has(pos.id)) tVis = true;
    if (ctSight.has(pos.id) || contestedSight.has(pos.id)) ctVis = true;
    const tAct = active.t.has(pos.id);
    const ctAct = active.ct.has(pos.id);
    if (tVis && ctVis) paint[pos.id] = tAct || ctAct ? 'contested-active' : 'contested';
    else if (tVis) paint[pos.id] = tAct ? 't-active' : 't-control';
    else if (ctVis) paint[pos.id] = ctAct ? 'ct-active' : 'ct-control';
    else paint[pos.id] = 'empty';
  }

  applySurroundControl(paint, network);
  return paint;
}

/**
 * @deprecated Prefer computeZonePaint. Kept for simple foot-only callers.
 */
export function paintForPosition(posId, tick, presence, active) {
  const tVis = (presence?.firstT.get(posId) ?? Infinity) <= tick;
  const ctVis = (presence?.firstCT.get(posId) ?? Infinity) <= tick;
  const tAct = Boolean(active?.t?.has(posId));
  const ctAct = Boolean(active?.ct?.has(posId));
  if (tVis && ctVis) return tAct || ctAct ? 'contested-active' : 'contested';
  if (tVis) return tAct ? 't-active' : 't-control';
  if (ctVis) return ctAct ? 'ct-active' : 'ct-control';
  return 'empty';
}

/**
 * Counts + area-weighted map control for the current paint map.
 *
 * Always tallies **positions** (`network.zones` — lowest tier), never
 * sections/zones or areas. Map control % uses each position's area.
 * Neutral = empty gray + contested red. T/CT = active + controlled only.
 *
 * @param {object} network
 * @param {Record<string, ZonePaint>} paint  keyed by position id
 */
export function summarizeZoneControl(network, paint) {
  const counts = {
    tActive: 0,
    tControl: 0,
    ctActive: 0,
    ctControl: 0,
    contested: 0,
    neutral: 0,
    total: 0
  };
  let tArea = 0;
  let ctArea = 0;
  let neutralArea = 0;
  let totalArea = 0;

  for (const pos of network?.zones || []) {
    if (!pos?.id || pos.hidden) continue;
    const key = paint?.[pos.id] || 'empty';
    const area = positionArea(pos);
    counts.total += 1;
    totalArea += area;

    if (key === 't-active') {
      counts.tActive += 1;
      tArea += area;
    } else if (key === 't-control') {
      counts.tControl += 1;
      tArea += area;
    } else if (key === 'ct-active') {
      counts.ctActive += 1;
      ctArea += area;
    } else if (key === 'ct-control') {
      counts.ctControl += 1;
      ctArea += area;
    } else if (key === 'contested' || key === 'contested-active') {
      counts.contested += 1;
      neutralArea += area;
    } else {
      counts.neutral += 1;
      neutralArea += area;
    }
  }

  const denom = totalArea > 0 ? totalArea : 1;
  return {
    counts,
    area: { t: tArea, ct: ctArea, neutral: neutralArea, total: totalArea },
    pct: {
      t: (tArea / denom) * 100,
      ct: (ctArea / denom) * 100,
      neutral: (neutralArea / denom) * 100
    }
  };
}

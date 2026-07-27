// ---------------------------------------------------------------------------
// replays/zones/zoneOverlay.js
// Timeline "positions" overlay: who has been where up to the playhead, who is
// there now, who can see an empty/occupied position (11-ray FOV fan + radar
// walkable mask + smokes), surround-fill for neutrals locked in by one side,
// and soft-pocket encirclement flips when the enemy ring goes active.
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
import {
  VISION_STRIDE,
  claimVisual,
  createBeamClaimSimulator,
  emptyClaim
} from './mapControl.js';
import { getVisionLayerTests } from './visionLayers.js';
import {
  cellIdAt,
  cellsNear,
  ensureDynamicZones,
  getCellGrid
} from './dynamicControl.js';

/**
 * Attach walkable cell proxies so claim/paint code can run without painted positions.
 * @param {object | null | undefined} network
 * @param {string} mapCode
 * @param {CanvasImageSource | null} [radarImage]
 */
export function prepareDynamicNetwork(network, mapCode, radarImage = null) {
  if (!network || !mapCode) return network;
  const los = radarImage ? getRadarLos(mapCode, radarImage) : null;
  const grid = getCellGrid(mapCode, los);
  if (!grid) return network;
  return ensureDynamicZones(network, grid);
}

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
/**
 * Yaw offsets (degrees) for the FOV ray fan, relative to look direction:
 * left edge, right edge, center, then 4 rays in each half-sector.
 */
const FOV_RAY_OFFSETS = (() => {
  const fov = SIGHT_FOV_DEG;
  const offsets = [-fov, 0, fov];
  for (let i = 1; i <= 4; i++) {
    offsets.push((-fov * i) / 5);
    offsets.push((fov * i) / 5);
  }
  return offsets;
})();
/** World-unit step when marching an FOV ray. */
const SIGHT_RAY_STEP = 48;
/** Stop marching past this world distance. */
const SIGHT_RAY_MAX = 4200;
/** Min ray-step hits inside a position to count it as seen. */
const SIGHT_RAY_MIN_HITS = 1;
/**
 * Radar alpha at or below this is outside the map (transparent PNG) — same
 * mask the zone overlay punches with `destination-in`.
 */
const WALL_ALPHA = 28;
/**
 * Near-black opaque texels are building / roof fill on Valve radars — solid
 * alpha so they survive the clip mask, but they are not walkable floor and
 * must block sight (Inferno Aps wall, Mirage kitchen, etc.).
 */
const WALKABLE_MIN_LUM = 28;
/** Smoke lifetime — matches radar renderer. */
const SMOKE_SECONDS = 22;
/** Smoke cloud radius in world units — matches radarRenderer.SMOKE_RADIUS_UNITS. */
const SMOKE_RADIUS_UNITS = 144;
/** World-unit pad when deciding two positions share a border. */
const ADJACENT_PAD = 18;

const adjacencyCache = new WeakMap();
/** @type {Map<string, object>} */
const losCache = new Map();

/**
 * Per-viewer amortized LOS + beam-claim state for the timeline zones overlay.
 * Sight cones are cached per player; beam claims come from a seek-safe
 * stride simulator (same rules as the map-control graph).
 * @returns {{
 *   rr: number,
 *   byPlayer: Map<string, object>,
 *   smokeKey: string,
 *   lastTick: number|null,
 *   lastStride: number|null,
 *   roundKey: string,
 *   claimSimKey: string,
 *   claimSim: ReturnType<typeof createBeamClaimSimulator>|null
 * }}
 */
export function createZoneVisionCache() {
  return {
    rr: 0,
    byPlayer: new Map(),
    smokeKey: '',
    lastTick: null,
    lastStride: null,
    roundKey: '',
    claimSimKey: '',
    claimSim: null
  };
}

/** Drop all cached per-player sight / claim simulator (round change, seek). */
export function resetZoneVisionCache(cache) {
  if (!cache) return;
  cache.rr = 0;
  cache.byPlayer.clear();
  cache.smokeKey = '';
  cache.lastTick = null;
  cache.lastStride = null;
  cache.roundKey = '';
  cache.claimSimKey = '';
  cache.claimSim = null;
}

/**
 * @typedef {{ tick: number, side: 'T'|'CT'|'both', reason: string, playerId?: string, playerName?: string, detail?: string }} ZoneClaimEvent
 */

/**
 * First tick each side entered each position (sampled once per second), plus
 * a claim-event log used for soft-control ownership.
 *
 * Every foot *entry* (rising edge) is logged — not only the first visit of the
 * round — so a later re-entry is the claim that soft control follows.
 *
 * @returns {{
 *   firstT: Map<string, number>,
 *   firstCT: Map<string, number>,
 *   events: Map<string, ZoneClaimEvent[]>,
 *   activeT: Map<string, number[]>,
 *   activeCT: Map<string, number[]>
 * } | null}
 */
export function buildZonePresence({ meta, track, network, mapCode = '', radarImage = null }) {
  if (mapCode) prepareDynamicNetwork(network, mapCode, radarImage);
  if (!meta || !track || !network?.zones?.length) return null;
  const from = meta.freezeEndTick ?? meta.startTick ?? 0;
  const to = Math.max(from, meta.endTick ?? from);
  const tickRate = meta.tickRate || 64;
  const players = meta.players || [];
  const byId = new Map(players.map((p) => [p.id, p]));
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  /** @type {Map<string, number>} */
  const firstT = new Map();
  /** @type {Map<string, number>} */
  const firstCT = new Map();
  /** @type {Map<string, ZoneClaimEvent[]>} */
  const events = new Map();
  /** 1Hz samples: ticks when each side had feet in the position. */
  /** @type {Map<string, number[]>} */
  const activeT = new Map();
  /** @type {Map<string, number[]>} */
  const activeCT = new Map();
  const scratch = [];
  /** @type {Set<string>} `${playerId}\0${posId}` occupied on the previous sample */
  let prevInside = new Set();

  const pushEvent = (posId, ev) => {
    if (!events.has(posId)) events.set(posId, []);
    events.get(posId).push(ev);
  };

  const pushActive = (map, posId, tick) => {
    const list = map.get(posId);
    if (!list) {
      map.set(posId, [tick]);
      return;
    }
    if (list[list.length - 1] !== tick) list.push(tick);
  };

  for (let tick = from; tick <= to; tick += tickRate) {
    track.sampleAll(tick, scratch);
    /** @type {Set<string>} */
    const curInside = new Set();
    /** @type {Set<string>} */
    const tHere = new Set();
    /** @type {Set<string>} */
    const ctHere = new Set();
    for (const p of players) {
      const side = teamSides[p.team];
      if (side !== 'T' && side !== 'CT') continue;
      const s = scratch[p.slot];
      if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      const hits = network._dynGrid
        ? cellsNear(network._dynGrid, s.x, s.y).map((id) => ({ id }))
        : positionsAtPoint(s.x, s.y, network);
      const map = side === 'T' ? firstT : firstCT;
      for (const z of hits) {
        if (!z?.id) continue;
        const key = `${p.id}\0${z.id}`;
        curInside.add(key);
        if (side === 'T') tHere.add(z.id);
        else ctHere.add(z.id);
        if (!map.has(z.id)) map.set(z.id, tick);
        // Rising edge only — staying inside is not a new claim.
        if (prevInside.has(key)) continue;
        pushEvent(z.id, {
          tick,
          side,
          reason: 'visit',
          playerId: p.id,
          playerName: byId.get(p.id)?.name || p.id,
          detail: 'Entered on foot'
        });
      }
    }
    for (const id of tHere) pushActive(activeT, id, tick);
    for (const id of ctHere) pushActive(activeCT, id, tick);
    prevInside = curInside;
  }
  return { firstT, firstCT, events, activeT, activeCT };
}

/**
 * Record a claim on the presence event log.
 * Same reason/side/player on the same tick is ignored; a later tick is a new
 * claim so soft control can follow the most recent one.
 */
export function recordClaim(presence, posId, ev) {
  if (!presence || !posId || !ev) return;
  if (!presence.events) presence.events = new Map();
  const list = presence.events.get(posId) || [];
  const dup = list.some(
    (e) =>
      e.tick === ev.tick &&
      e.reason === ev.reason &&
      e.side === ev.side &&
      (ev.playerId ? e.playerId === ev.playerId : !e.playerId)
  );
  if (dup) return;
  // Sight/surround/encircle can fire every paint frame while the condition holds —
  // keep one row per reason/side/player and move it forward when re-claimed.
  if (
    ev.reason === 'sight' ||
    ev.reason === 'surround' ||
    ev.reason === 'encircle' ||
    ev.reason === 'sight-enemy'
  ) {
    const prior = list.find(
      (e) =>
        e.reason === ev.reason &&
        e.side === ev.side &&
        (ev.playerId ? e.playerId === ev.playerId : !e.playerId)
    );
    if (prior) {
      if ((ev.tick || 0) > (prior.tick || 0)) {
        prior.tick = ev.tick;
        prior.detail = ev.detail || prior.detail;
        list.sort((a, b) => a.tick - b.tick);
        presence.events.set(posId, list);
      }
      return;
    }
  }
  list.push(ev);
  list.sort((a, b) => a.tick - b.tick);
  presence.events.set(posId, list);
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
  const grid = network._dynGrid;
  for (const p of meta.players || []) {
    const side = teamSides[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    const s = states?.[p.slot];
    if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    if (grid) {
      for (const id of cellsNear(grid, s.x, s.y)) {
        if (side === 'T') t.add(id);
        else ct.add(id);
      }
    } else {
      for (const z of positionsAtPoint(s.x, s.y, network)) {
        if (!z?.id) continue;
        if (side === 'T') t.add(z.id);
        else ct.add(z.id);
      }
    }
  }
  return { t, ct };
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

  // Dynamic cell grid: 4-neighbor adjacency (O(cells)).
  const grid = network._dynGrid;
  if (grid?.ids?.length) {
    /** @type {Map<string, string[]>} */
    const adj = new Map();
    for (const id of grid.ids) adj.set(id, []);
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];
    for (let i = 0; i < grid.ids.length; i++) {
      const id = grid.ids[i];
      const ix = grid.ixOf[i];
      const iy = grid.iyOf[i];
      const list = adj.get(id);
      for (const [dx, dy] of dirs) {
        const j = grid.byKey.get(`${ix + dx},${iy + dy}`);
        if (j == null) continue;
        list.push(grid.ids[j]);
      }
    }
    adjacencyCache.set(network, adj);
    return adj;
  }

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
 * Line-of-sight through the radar PNG.
 * Walkable floor = opaque enough (same alpha punch as zone clips) and not
 * near-black building fill. Transparent AND solid-black both block.
 *
 * Bakes a Uint8 bitmask once so per-ray tests are byte lookups, not RGB math.
 *
 * @param {string} mapCode
 * @param {CanvasImageSource} image
 */
export function getRadarLos(mapCode, image) {
  if (!mapCode || !image) return null;
  const hit = losCache.get(mapCode);
  if (hit && hit.image === image && hit.version === 3) return hit;

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

  const mask = new Uint8Array(RADAR_SIZE * RADAR_SIZE);
  for (let y = 0; y < RADAR_SIZE; y++) {
    const row = y * RADAR_SIZE;
    for (let x = 0; x < RADAR_SIZE; x++) {
      const i = (row + x) * 4;
      const alpha = data[i + 3];
      if (alpha <= WALL_ALPHA) continue;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum >= WALKABLE_MIN_LUM) mask[row + x] = 1;
    }
  }

  /** True when this radar texel is walkable floor (not void, not building). */
  const walkable = (px, py) => {
    const x = px | 0;
    const y = py | 0;
    if (x < 0 || y < 0 || x >= RADAR_SIZE || y >= RADAR_SIZE) return false;
    return mask[y * RADAR_SIZE + x] !== 0;
  };

  const a = {};
  const b = {};
  const scratch = {};

  const isWalkableWorld = (wx, wy) => {
    worldToRadar(mapCode, wx, wy, scratch);
    return walkable(scratch.x, scratch.y);
  };

  /**
   * Clear LOS when every radar texel along the segment is walkable floor.
   * Samples denser than one step per pixel so thin transparent walls cannot
   * be skipped on diagonals.
   */
  const clearWorld = (x0, y0, x1, y1) => {
    worldToRadar(mapCode, x0, y0, a);
    worldToRadar(mapCode, x1, y1, b);
    // Target must sit on floor — zone polys often overhang into voids.
    if (!walkable(b.x, b.y)) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return true;
    // Manhattan + Euclidean margin: never skip a void texel between floors.
    const steps = Math.max(2, Math.ceil(Math.abs(dx) + Math.abs(dy) + dist * 0.5));
    const sx = a.x | 0;
    const sy = a.y | 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      // Skip only the viewer's own cell (feet can sit on a dark edge texel).
      if ((px | 0) === sx && (py | 0) === sy) continue;
      if (!walkable(px, py)) return false;
    }
    return true;
  };

  const los = { clearWorld, isWalkableWorld, walkable, mask, image, version: 3 };
  losCache.set(mapCode, los);
  return los;
}

/** Active smoke grenades at `tick` (detonated, still living). */
function activeSmokes(grenades, tick, tickRate) {
  const out = [];
  const life = SMOKE_SECONDS * (tickRate || 64);
  for (const g of grenades || []) {
    if (g.type !== 'smokegrenade') continue;
    const det = Number(g.detonateTick);
    if (!Number.isFinite(det) || tick < det || tick > det + life) continue;
    if (!g.at || !Number.isFinite(g.at.x) || !Number.isFinite(g.at.y)) continue;
    out.push({ x: g.at.x, y: g.at.y });
  }
  return out;
}

/** Cell / position ids that currently have an active smoke on them. */
function smokedPositions(grenades, tick, tickRate, network) {
  const ids = new Set();
  const grid = network?._dynGrid;
  for (const s of activeSmokes(grenades, tick, tickRate)) {
    if (grid) {
      for (const id of cellsNear(grid, s.x, s.y, SMOKE_RADIUS_UNITS)) ids.add(id);
    } else {
      for (const z of positionsAtPoint(s.x, s.y, network)) {
        if (z?.id) ids.add(z.id);
      }
    }
  }
  return ids;
}

/** True when a world point sits inside any active smoke disc. */
function pointInSmoke(x, y, smokes, radius = SMOKE_RADIUS_UNITS) {
  if (!smokes?.length) return false;
  const r2 = radius * radius;
  for (const s of smokes) {
    const dx = x - s.x;
    const dy = y - s.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

/**
 * March one FOV ray from the viewer until wall, smoke, vision-block, elevated
 * ridge (from ground), or max range. Tallies walkable floor hits per position.
 *
 * Elevated: ground viewers cannot enter / see past painted elevated cells.
 * Viewers standing on elevated can see onto elevated and continue past it.
 *
 * @param {Map<string, number>} hitCounts  posId -> step hits
 * @param {Map<string, number>} rayCounts  posId -> distinct rays that touched it
 */
function castFovRay(
  viewer,
  yawDeg,
  los,
  smokes,
  network,
  smoked,
  hitCounts,
  rayCounts,
  layers
) {
  const rad = (yawDeg * Math.PI) / 180;
  // Match engine yaw: 0 = +X, 90 = +Y.
  const dirX = Math.cos(rad);
  const dirY = Math.sin(rad);
  /** @type {Set<string>} */
  const touched = new Set();
  const viewerElevated = layers?.elevatedAt?.(viewer.x, viewer.y) || false;

  for (let dist = SIGHT_RAY_STEP; dist <= SIGHT_RAY_MAX; dist += SIGHT_RAY_STEP) {
    const x = viewer.x + dirX * dist;
    const y = viewer.y + dirY * dist;
    if (!los.isWalkableWorld(x, y)) break;
    if (layers?.visionBlockAt?.(x, y)) break;
    if (!viewerElevated && layers?.elevatedAt?.(x, y)) break;
    if (pointInSmoke(x, y, smokes)) break;
    const grid = network?._dynGrid;
    if (grid) {
      const id = cellIdAt(grid, x, y);
      if (id && !smoked?.has(id)) {
        hitCounts.set(id, (hitCounts.get(id) || 0) + 1);
        touched.add(id);
      }
    } else {
      for (const z of positionsAtPoint(x, y, network)) {
        if (!z?.id || smoked?.has(z.id)) continue;
        hitCounts.set(z.id, (hitCounts.get(z.id) || 0) + 1);
        touched.add(z.id);
      }
    }
  }
  for (const id of touched) {
    rayCounts.set(id, (rayCounts.get(id) || 0) + 1);
  }
}

/**
 * Cast the 11-ray FOV fan; returns distinct beams per position (1–11).
 * @returns {Map<string, number>}
 */
/**
 * Bind map/radar/grenades into a cast function for `buildMapControlSeries`.
 * @returns {(ctx: { viewer: object, tick: number }) => Map<string, number>}
 */
export function createBeamCaster({ meta, network, mapCode, radarImage }) {
  const prepared = prepareDynamicNetwork(network, mapCode, radarImage);
  const los = getRadarLos(mapCode, radarImage);
  if (!los || !meta || !prepared?.zones?.length) return () => new Map();
  const tickRate = meta.tickRate || 64;
  const grenades = meta.events?.grenades || [];
  return ({ viewer, tick }) => {
    const smokeCenters = activeSmokes(grenades, tick, tickRate);
    const smoked = smokedPositions(grenades, tick, tickRate, prepared);
    return castPlayerBeams({
      viewer,
      los,
      smokeCenters,
      network: prepared,
      smoked,
      layers: getVisionLayerTests(prepared, mapCode),
      mapCode
    });
  };
}

export function castPlayerBeams({
  viewer,
  los,
  smokeCenters,
  network,
  smoked,
  layers = null,
  mapCode = ''
}) {
  /** @type {Map<string, number>} */
  const hitCounts = new Map();
  /** @type {Map<string, number>} */
  const rayCounts = new Map();
  const layerTests =
    layers || (mapCode && network ? getVisionLayerTests(network, mapCode) : null);
  const baseYaw = Number(viewer.yaw) || 0;
  for (const offset of FOV_RAY_OFFSETS) {
    castFovRay(
      viewer,
      baseYaw + offset,
      los,
      smokeCenters,
      network,
      smoked || new Set(),
      hitCounts,
      rayCounts,
      layerTests
    );
  }
  return rayCounts;
}

/**
 * Vision for one living player: 11-ray FOV fan + tip/history events.
 * `beamHits` is the per-position beam count used by the claim accumulator.
 */
function computePlayerVision({
  player,
  side,
  viewer,
  playerName,
  smoked,
  smokeCenters,
  los,
  network,
  active,
  presence,
  tick,
  layers = null,
  mapCode = ''
}) {
  /** @type {Array<{ posId: string, cover: number, through: boolean, direct: boolean }>} */
  const seen = [];
  const rayCounts = castPlayerBeams({
    viewer,
    los,
    smokeCenters,
    network,
    smoked,
    layers,
    mapCode
  });

  const rayTotal = FOV_RAY_OFFSETS.length;
  for (const [posId, rays] of rayCounts) {
    if (rays < SIGHT_RAY_MIN_HITS) continue;
    const reportCover = Math.min(0.99, rays / rayTotal);

    seen.push({
      posId,
      cover: reportCover,
      through: false,
      direct: true
    });

    if (!presence) continue;
    const hasT = active.t.has(posId);
    const hasCt = active.ct.has(posId);
    const enemyInside = side === 'T' ? hasCt : hasT;
    const allyInside = side === 'T' ? hasT : hasCt;

    if (enemyInside) {
      if (!presence.firstT.has(posId)) presence.firstT.set(posId, tick);
      if (!presence.firstCT.has(posId)) presence.firstCT.set(posId, tick);
      recordClaim(presence, posId, {
        tick,
        side: 'both',
        reason: 'sight-enemy',
        playerId: player.id,
        playerName,
        detail: `Saw enemy inside (${Math.round(reportCover * 100)}% cone)`
      });
      continue;
    }
    if (allyInside) continue;
    const map = side === 'T' ? presence.firstT : presence.firstCT;
    if (!map.has(posId)) map.set(posId, tick);
    recordClaim(presence, posId, {
      tick,
      side,
      reason: 'sight',
      playerId: player.id,
      playerName,
      detail: `Clear sight (${rays}/${rayTotal} beams)`
    });
  }

  return { playerId: player.id, side, playerName, seen, beamHits: rayCounts };
}

/** Merge cached per-player sight against *current* occupancy. */
function mergePlayerVision(entries, active) {
  const tSight = new Set();
  const ctSight = new Set();
  const contestedSight = new Set();
  /** @type {Map<string, Array<{side:string, playerId:string, playerName:string, cover:number, enemy:boolean}>>} */
  const sightNow = new Map();

  for (const entry of entries) {
    if (!entry?.seen?.length) continue;
    const side = entry.side;
    for (const s of entry.seen) {
      const hasT = active.t.has(s.posId);
      const hasCt = active.ct.has(s.posId);
      const enemyInside = side === 'T' ? hasCt : hasT;
      const allyInside = side === 'T' ? hasT : hasCt;

      if (!sightNow.has(s.posId)) sightNow.set(s.posId, []);
      sightNow.get(s.posId).push({
        side,
        playerId: entry.playerId,
        playerName: entry.playerName,
        cover: s.cover,
        enemy: enemyInside
      });

      if (enemyInside) {
        contestedSight.add(s.posId);
        continue;
      }
      if (allyInside) continue;
      if (side === 'T') tSight.add(s.posId);
      else ctSight.add(s.posId);
    }
  }

  for (const id of [...tSight]) {
    if (ctSight.has(id)) {
      contestedSight.add(id);
      tSight.delete(id);
      ctSight.delete(id);
    }
  }
  return { tSight, ctSight, contestedSight, sightNow };
}

/**
 * Apply vision + beam claims for the current tick.
 *
 * Beam claims are seek-safe: simulated from freeze-end → playhead with the
 * same stride/RR rules as the map-control graph (snapshots, not live mutate).
 * Sight cones use a short cache for smooth playback, but fully refresh on
 * backward seeks / skipped strides so scrubbing cannot leave stale cones.
 *
 * @returns {{
 *   tSight: Set<string>,
 *   ctSight: Set<string>,
 *   contestedSight: Set<string>,
 *   sightNow: Map<string, Array<{side:string, playerId:string, playerName:string, cover:number, enemy:boolean}>>,
 *   claims: Map<string, import('./mapControl.js').ClaimState>|null
 * }}
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
  grenades,
  visionCache,
  track = null
}) {
  const empty = {
    tSight: new Set(),
    ctSight: new Set(),
    contestedSight: new Set(),
    sightNow: new Map(),
    claims: null
  };
  if (!meta || !radarImage) return empty;
  prepareDynamicNetwork(network, mapCode, radarImage);
  if (!network?.zones?.length) return empty;
  const los = getRadarLos(mapCode, radarImage);
  if (!los) return empty;

  const tickRate = meta.tickRate || 64;
  const smokeCenters = activeSmokes(grenades, tick, tickRate);
  const smoked = smokedPositions(grenades, tick, tickRate, network);
  const layers = getVisionLayerTests(network, mapCode);
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };

  /** @type {Array<{ player: object, side: 'T'|'CT', viewer: {x:number,y:number,yaw:number}, playerName: string }>} */
  const viewers = [];
  for (const p of meta.players || []) {
    const side = teamSides[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    const s = states?.[p.slot];
    if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    if (!Number.isFinite(s.yaw)) continue;
    viewers.push({
      player: p,
      side,
      viewer: { x: s.x, y: s.y, yaw: s.yaw },
      playerName: p.name || p.id
    });
  }

  const runOne = (v) =>
    computePlayerVision({
      player: v.player,
      side: v.side,
      viewer: v.viewer,
      playerName: v.playerName,
      smoked,
      smokeCenters,
      los,
      network,
      active,
      presence,
      tick,
      layers,
      mapCode
    });

  if (!visionCache) {
    const merged = mergePlayerVision(
      viewers.map((v) => runOne(v)),
      active
    );
    return { ...merged, claims: null };
  }

  const roundKey = `${mapCode}|${meta.startTick ?? 0}|${meta.freezeEndTick ?? 0}|${meta.endTick ?? 0}`;
  if (visionCache.roundKey !== roundKey) {
    resetZoneVisionCache(visionCache);
    visionCache.roundKey = roundKey;
  }

  /** @type {Map<string, import('./mapControl.js').ClaimState>|null} */
  let claims = null;
  if (track) {
    const cast = createBeamCaster({ meta, network, mapCode, radarImage });
    // Include team sides so half-time swaps cannot reuse the wrong sim.
    const simKey = `${roundKey}|${meta.team1Side || ''}|${meta.team2Side || ''}|${network.updatedAt || 0}|${network._layerPaintGen || 0}`;
    if (!visionCache.claimSim || visionCache.claimSimKey !== simKey) {
      visionCache.claimSim = createBeamClaimSimulator({
        meta,
        track,
        castPlayerBeams: cast
      });
      visionCache.claimSimKey = simKey;
    }
    claims = visionCache.claimSim.claimsAt(tick);
  }

  const smokeKey = smokeCenters
    .map((s) => `${Math.round(s.x)},${Math.round(s.y)}`)
    .join(';');
  const stride = Math.floor(tick / VISION_STRIDE);
  const lastTick = visionCache.lastTick;
  const lastStride = visionCache.lastStride;
  // Backward seek, skipped strides, or smoke change → refresh every living cone.
  const seekOrSkip =
    lastTick == null ||
    tick < lastTick ||
    (lastStride != null && stride < lastStride) ||
    (lastStride != null && stride > lastStride + 1) ||
    visionCache.smokeKey !== smokeKey ||
    (lastTick != null && Math.abs(tick - lastTick) > tickRate * 2);

  if (seekOrSkip) {
    visionCache.byPlayer.clear();
    visionCache.rr = 0;
    visionCache.lastStride = null;
    visionCache.smokeKey = smokeKey;
    for (const v of viewers) {
      visionCache.byPlayer.set(v.player.id, runOne(v));
    }
    visionCache.lastStride = stride;
  } else if (viewers.length && lastStride !== stride) {
    visionCache.lastStride = stride;
    const focus = viewers[visionCache.rr % viewers.length];
    visionCache.rr++;
    visionCache.byPlayer.set(focus.player.id, runOne(focus));
  }

  const aliveIds = new Set(viewers.map((v) => v.player.id));
  for (const id of [...visionCache.byPlayer.keys()]) {
    if (!aliveIds.has(id)) visionCache.byPlayer.delete(id);
  }

  visionCache.lastTick = tick;

  const merged = [];
  for (const v of viewers) {
    const hit = visionCache.byPlayer.get(v.player.id);
    if (hit) merged.push(hit);
  }
  const sight = mergePlayerVision(merged, active);
  return { ...sight, claims };
}

function sideOfPaint(key) {
  if (!key || key === 'empty') return null;
  if (key === 'contested' || key === 'contested-active') return 'both';
  if (key.startsWith('t-')) return 'T';
  if (key.startsWith('ct-')) return 'CT';
  return null;
}

/**
 * Latest non-contested claim at or before `tick` (for soft empty control).
 * Ownership follows the most recent claim — not the first visit of the round.
 * @returns {{ side: 'T'|'CT', tick: number, reason?: string } | null}
 */
function latestClaimAt(presence, posId, tick) {
  const list = presence?.events?.get(posId) || [];
  let best = null;
  for (const e of list) {
    if ((e.tick || 0) > tick) continue;
    if (e.side !== 'T' && e.side !== 'CT') continue;
    if (!best || e.tick >= best.tick) best = e;
  }
  if (best) {
    return { side: best.side, tick: best.tick, reason: best.reason };
  }
  const t = presence?.firstT.get(posId);
  const ct = presence?.firstCT.get(posId);
  const tOk = Number.isFinite(t) && t <= tick;
  const ctOk = Number.isFinite(ct) && ct <= tick;
  if (tOk && !ctOk) return { side: 'T', tick: t, reason: 'visit' };
  if (ctOk && !tOk) return { side: 'CT', tick: ct, reason: 'visit' };
  if (tOk && ctOk) {
    return t >= ct
      ? { side: 'T', tick: t, reason: 'visit' }
      : { side: 'CT', tick: ct, reason: 'visit' };
  }
  return null;
}

/** @returns {'T'|'CT'|null} */
export function latestOwnerSide(presence, posId, tick) {
  return latestClaimAt(presence, posId, tick)?.side ?? null;
}

/**
 * Tick when `side` began its current soft tenure on `posId` (beam owner or
 * latest presence claim), or null if that side does not soft-own it now.
 */
function softTenureStart(posId, side, tick, presence, claims) {
  const st = claims?.get(posId);
  if (st?.owner === side) {
    if (Number.isFinite(st.ownerTick)) return st.ownerTick;
  }
  const claim = latestClaimAt(presence, posId, tick);
  if (claim?.side === side) return claim.tick;
  if (st?.owner === side) return 0;
  return null;
}

/**
 * Soft pocket flip: a connected soft-control component whose *external*
 * neighbors are only enemy soft/active flips to enemy soft when ≥1 of those
 * neighbors is active (feet). Vice versa. Beam-only rings with nobody
 * standing do not flip.
 *
 * @returns {Map<string, { side: 'T'|'CT', neighborNames: string[] }>}
 */
function applyEncirclementFlip(paint, network, presence, tick, claims) {
  const adj = buildPositionAdjacency(network);
  const byId = new Map((network.zones || []).map((z) => [z.id, z]));
  /** @type {Map<string, { side: 'T'|'CT', neighborNames: string[] }>} */
  const assigned = new Map();
  const seen = new Set();

  for (const pos of network.zones || []) {
    if (!pos?.id || pos.hidden || seen.has(pos.id)) continue;
    const key = paint[pos.id];
    if (key !== 't-control' && key !== 'ct-control') continue;
    const softSide = key === 't-control' ? 'T' : 'CT';
    const softKey = key;
    const enemy = softSide === 'T' ? 'CT' : 'T';
    const enemySoft = enemy === 'T' ? 't-control' : 'ct-control';
    const enemyActive = enemy === 'T' ? 't-active' : 'ct-active';

    // Connected component of the same soft paint.
    const component = [];
    const queue = [pos.id];
    seen.add(pos.id);
    while (queue.length) {
      const id = queue.pop();
      component.push(id);
      for (const nid of adj.get(id) || []) {
        if (seen.has(nid)) continue;
        if ((paint[nid] || 'empty') !== softKey) continue;
        seen.add(nid);
        queue.push(nid);
      }
    }

    let hasEnemyActive = false;
    const neighborNames = [];
    const borderSeen = new Set();
    let ok = true;
    for (const id of component) {
      for (const nid of adj.get(id) || []) {
        if ((paint[nid] || 'empty') === softKey) continue; // inside pocket
        if (borderSeen.has(nid)) continue;
        borderSeen.add(nid);
        const nk = paint[nid] || 'empty';
        const nName = byId.get(nid)?.name || nid;
        if (nk === enemyActive) {
          hasEnemyActive = true;
          neighborNames.push(`${nName} (active)`);
        } else if (nk === enemySoft) {
          neighborNames.push(`${nName} (soft)`);
        } else {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (!ok || !hasEnemyActive || !borderSeen.size) continue;

    // Every cell in the pocket must still be soft-owned by softSide.
    if (
      component.some(
        (id) => softTenureStart(id, softSide, tick, presence, claims) == null
      )
    ) {
      continue;
    }

    const toKey = enemy === 'T' ? 't-control' : 'ct-control';
    for (const id of component) {
      paint[id] = toKey;
      assigned.set(id, { side: enemy, neighborNames });
      if (claims) {
        if (!claims.has(id)) claims.set(id, emptyClaim());
        const st = claims.get(id);
        st.owner = enemy;
        st.ownerTick = tick;
        st.tHits = 0;
        st.ctHits = 0;
        st.tLast = null;
        st.ctLast = null;
      }
      recordClaim(presence, id, {
        tick,
        side: enemy,
        reason: 'encircle',
        detail: `Soft pocket flipped — enclosed by ${enemy}: ${neighborNames.join(', ')}`
      });
      if (presence) {
        const map = enemy === 'T' ? presence.firstT : presence.firstCT;
        if (!map.has(id)) map.set(id, tick);
      }
    }
  }
  return assigned;
}

/**
 * Fill neutral positions only when their entire unbroken neutral component
 * borders exactly one side. A T-controlled cell three neutrals away still
 * blocks a CT fill of the whole pocket.
 *
 * @returns {Map<string, { side: 'T'|'CT', neighborNames: string[] }>}
 */
function applySurroundControl(paint, network, presence, tick) {
  const adj = buildPositionAdjacency(network);
  const byId = new Map((network.zones || []).map((z) => [z.id, z]));
  /** @type {Map<string, { side: 'T'|'CT', neighborNames: string[] }>} */
  const assigned = new Map();
  const seen = new Set();

  for (const pos of network.zones || []) {
    if (!pos?.id || pos.hidden || paint[pos.id] !== 'empty' || seen.has(pos.id)) continue;

    // Connected component of neutrals only — the chain must stay unbroken.
    const component = [];
    const queue = [pos.id];
    seen.add(pos.id);
    while (queue.length) {
      const id = queue.pop();
      component.push(id);
      for (const nid of adj.get(id) || []) {
        if (seen.has(nid)) continue;
        if ((paint[nid] || 'empty') !== 'empty') continue;
        seen.add(nid);
        queue.push(nid);
      }
    }

    let t = false;
    let ct = false;
    let both = false;
    const borderNames = [];
    const borderSeen = new Set();
    for (const id of component) {
      for (const nid of adj.get(id) || []) {
        if ((paint[nid] || 'empty') === 'empty') continue; // still inside the pocket
        if (borderSeen.has(nid)) continue;
        borderSeen.add(nid);
        const s = sideOfPaint(paint[nid]);
        const nName = byId.get(nid)?.name || nid;
        if (s === 'both') {
          both = true;
          borderNames.push(`${nName} (contested)`);
        } else if (s === 'T') {
          t = true;
          borderNames.push(`${nName} (T)`);
        } else if (s === 'CT') {
          ct = true;
          borderNames.push(`${nName} (CT)`);
        }
      }
    }

    // Any opposing (or contested) hard border on the component blocks the fill.
    if (both || (t && ct) || (!t && !ct)) continue;
    const side = t ? 'T' : 'CT';
    const key = side === 'T' ? 't-control' : 'ct-control';
    for (const id of component) {
      paint[id] = key;
      assigned.set(id, { side, neighborNames: borderNames });
      recordClaim(presence, id, {
        tick,
        side,
        reason: 'surround',
        detail: `Neutral pocket borders only ${side}: ${borderNames.join(', ')}`
      });
      if (presence) {
        const map = side === 'T' ? presence.firstT : presence.firstCT;
        if (!map.has(id)) map.set(id, tick);
      }
    }
  }
  return assigned;
}

/**
 * Full paint map for the playhead: foot presence + vision + surround.
 *
 * @returns {{ paint: Record<string, ZonePaint> }}
 */
export function computeZonePaint({
  meta,
  states,
  network,
  tick,
  presence,
  mapCode,
  radarImage,
  grenades,
  visionCache,
  track = null
}) {
  /** @type {Record<string, ZonePaint>} */
  const paint = {};
  prepareDynamicNetwork(network, mapCode, radarImage);
  if (!network?.zones?.length) return { paint };

  const active = activePositionsAt({ meta, states, network });
  const { tSight, ctSight, contestedSight, claims } = applyVisionClaims({
    meta,
    states,
    network,
    tick,
    presence,
    active,
    mapCode,
    radarImage,
    grenades,
    visionCache,
    track
  });

  // Feet first, then beam-claim ownership (3 hits neutral / 20 to flip).
  // If beams have not claimed a position, keep soft control from foot/sight
  // history — never wipe an active visit just because the claim map exists.
  for (const pos of network.zones) {
    if (!pos?.id || pos.hidden) continue;
    const tAct = active.t.has(pos.id);
    const ctAct = active.ct.has(pos.id);
    const tSee = tSight.has(pos.id);
    const ctSee = ctSight.has(pos.id);
    const fightNow = contestedSight.has(pos.id);
    const visual = claims ? claimVisual(claims.get(pos.id)) : null;

    if (tAct && ctAct) {
      paint[pos.id] = 'contested-active';
    } else if (tAct && (fightNow || ctSee || visual === 'contested' || visual === 'CT')) {
      paint[pos.id] = 'contested-active';
    } else if (ctAct && (fightNow || tSee || visual === 'contested' || visual === 'T')) {
      paint[pos.id] = 'contested-active';
    } else if (tAct) {
      paint[pos.id] = 't-active';
    } else if (ctAct) {
      paint[pos.id] = 'ct-active';
    } else if (fightNow || visual === 'contested') {
      paint[pos.id] = 'contested';
    } else if (visual === 'T') {
      paint[pos.id] = 't-control';
    } else if (visual === 'CT') {
      paint[pos.id] = 'ct-control';
    } else {
      const latest = latestOwnerSide(presence, pos.id, tick);
      paint[pos.id] =
        latest === 'T' ? 't-control' : latest === 'CT' ? 'ct-control' : 'empty';
    }
  }

  applySurroundControl(paint, network, presence, tick);
  applyEncirclementFlip(paint, network, presence, tick, claims);

  return { paint };
}

/**
 * @deprecated Prefer computeZonePaint. Contested is present-tense only.
 */
export function paintForPosition(posId, tick, presence, active) {
  const tAct = Boolean(active?.t?.has(posId));
  const ctAct = Boolean(active?.ct?.has(posId));
  if (tAct && ctAct) return 'contested-active';
  if (tAct) return 't-active';
  if (ctAct) return 'ct-active';
  const latest = latestOwnerSide(presence, posId, tick);
  if (latest === 'T') return 't-control';
  if (latest === 'CT') return 'ct-control';
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

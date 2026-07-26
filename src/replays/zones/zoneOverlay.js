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
/** Smoke cloud radius in world units — matches radarRenderer.SMOKE_RADIUS_UNITS. */
const SMOKE_RADIUS_UNITS = 144;
/** World-unit pad when deciding two positions share a border. */
const ADJACENT_PAD = 18;
/** Sample points per position for sight coverage. */
const SIGHT_SAMPLES = 24;

const adjacencyCache = new WeakMap();
const sampleCache = new WeakMap();
/** @type {Map<string, { clearWorld: Function, image: CanvasImageSource }>} */
const losCache = new Map();

/**
 * @typedef {{ tick: number, side: 'T'|'CT'|'both', reason: string, playerId?: string, playerName?: string, detail?: string }} ZoneClaimEvent
 */

/**
 * First tick each side entered each position (sampled once per second), plus
 * a claim-event log used by the Shift-hover explain tip.
 *
 * Every foot *entry* (rising edge) is logged — not only the first visit of the
 * round — so a later re-entry is the claim that soft control follows.
 *
 * @returns {{ firstT: Map<string, number>, firstCT: Map<string, number>, events: Map<string, ZoneClaimEvent[]> } | null}
 */
export function buildZonePresence({ meta, track, network }) {
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
  const scratch = [];
  /** @type {Set<string>} `${playerId}\0${posId}` occupied on the previous sample */
  let prevInside = new Set();

  const pushEvent = (posId, ev) => {
    if (!events.has(posId)) events.set(posId, []);
    events.get(posId).push(ev);
  };

  for (let tick = from; tick <= to; tick += tickRate) {
    track.sampleAll(tick, scratch);
    /** @type {Set<string>} */
    const curInside = new Set();
    for (const p of players) {
      const side = teamSides[p.team];
      if (side !== 'T' && side !== 'CT') continue;
      const s = scratch[p.slot];
      if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      const hits = positionsAtPoint(s.x, s.y, network);
      const map = side === 'T' ? firstT : firstCT;
      for (const z of hits) {
        if (!z?.id) continue;
        const key = `${p.id}\0${z.id}`;
        curInside.add(key);
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
    prevInside = curInside;
  }
  return { firstT, firstCT, events };
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
  // Sight/surround can fire every paint frame while the condition holds —
  // keep one row per reason/side/player and move it forward when re-claimed.
  if (ev.reason === 'sight' || ev.reason === 'surround' || ev.reason === 'sight-enemy') {
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

/** Position ids that currently have an active smoke on them. */
function smokedPositions(grenades, tick, tickRate, network) {
  const ids = new Set();
  for (const s of activeSmokes(grenades, tick, tickRate)) {
    for (const z of positionsAtPoint(s.x, s.y, network)) {
      if (z?.id) ids.add(z.id);
    }
  }
  return ids;
}

/**
 * True when the world-space segment A→B passes through any smoke disc.
 * Used so a mid smoke blocks sight into positions *behind* it, not only the
 * cell the grenade landed in.
 */
function segmentBlockedBySmoke(x0, y0, x1, y1, smokes, radius = SMOKE_RADIUS_UNITS) {
  if (!smokes?.length) return false;
  const r2 = radius * radius;
  for (const s of smokes) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 1e-6) {
      t = ((s.x - x0) * dx + (s.y - y0) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const cx = x0 + dx * t - s.x;
    const cy = y0 + dy * t - s.y;
    if (cx * cx + cy * cy <= r2) return true;
  }
  return false;
}

/**
 * Fraction of sample points in-FOV with clear radar LOS from the player,
 * and not occluded by a smoke cloud on the way.
 * @param {Array<{x:number,y:number}>} [smokes]
 */
function sightCover(player, pos, los, smokes) {
  const pts = samplePointsForPosition(pos);
  if (!pts.length) return 0;
  let ok = 0;
  for (const p of pts) {
    if (yawDelta(player.yaw, yawToward(player, p)) > SIGHT_FOV_DEG) continue;
    if (los && !los.clearWorld(player.x, player.y, p.x, p.y)) continue;
    if (!los) continue;
    if (segmentBlockedBySmoke(player.x, player.y, p.x, p.y, smokes)) continue;
    ok++;
  }
  return ok / pts.length;
}

/**
 * Apply vision claims for the current tick. Mutates `presence` when an empty
 * position is confirmed seen (persists like a foot visit) or when an enemy is
 * seen inside (both sides claim → contested).
 *
 * @returns {{
 *   tSight: Set<string>,
 *   ctSight: Set<string>,
 *   contestedSight: Set<string>,
 *   sightNow: Map<string, Array<{side:string, playerId:string, playerName:string, cover:number, enemy:boolean}>>
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
  grenades
}) {
  const tSight = new Set();
  const ctSight = new Set();
  const contestedSight = new Set();
  /** @type {Map<string, Array<{side:string, playerId:string, playerName:string, cover:number, enemy:boolean}>>} */
  const sightNow = new Map();
  if (!meta || !network?.zones?.length || !radarImage) {
    return { tSight, ctSight, contestedSight, sightNow };
  }
  const los = getRadarLos(mapCode, radarImage);
  if (!los) return { tSight, ctSight, contestedSight, sightNow };

  const tickRate = meta.tickRate || 64;
  const smokeCenters = activeSmokes(grenades, tick, tickRate);
  const smoked = smokedPositions(grenades, tick, tickRate, network);
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const positions = network.zones.filter((z) => z?.id && !z.hidden && z.pieces?.length);

  for (const p of meta.players || []) {
    const side = teamSides[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    const s = states?.[p.slot];
    if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    if (!Number.isFinite(s.yaw)) continue;
    const viewer = { x: s.x, y: s.y, yaw: s.yaw };
    const playerName = p.name || p.id;

    for (const pos of positions) {
      if (smoked.has(pos.id)) continue;
      const cover = sightCover(viewer, pos, los, smokeCenters);
      if (cover < SIGHT_COVER) continue;

      const hasT = active.t.has(pos.id);
      const hasCt = active.ct.has(pos.id);
      const enemyInside = side === 'T' ? hasCt : hasT;
      const allyInside = side === 'T' ? hasT : hasCt;

      if (!sightNow.has(pos.id)) sightNow.set(pos.id, []);
      sightNow.get(pos.id).push({
        side,
        playerId: p.id,
        playerName,
        cover,
        enemy: enemyInside
      });

      if (enemyInside) {
        contestedSight.add(pos.id);
        if (presence) {
          if (!presence.firstT.has(pos.id)) presence.firstT.set(pos.id, tick);
          if (!presence.firstCT.has(pos.id)) presence.firstCT.set(pos.id, tick);
          recordClaim(presence, pos.id, {
            tick,
            side: 'both',
            reason: 'sight-enemy',
            playerId: p.id,
            playerName,
            detail: `Saw enemy inside (${Math.round(cover * 100)}% cover)`
          });
        }
        continue;
      }
      if (allyInside) continue;
      if (side === 'T') tSight.add(pos.id);
      else ctSight.add(pos.id);
      if (presence) {
        const map = side === 'T' ? presence.firstT : presence.firstCT;
        const first = !map.has(pos.id);
        if (first) map.set(pos.id, tick);
        recordClaim(presence, pos.id, {
          tick,
          side,
          reason: 'sight',
          playerId: p.id,
          playerName,
          detail: `Clear sight (${Math.round(cover * 100)}% cover)`
        });
      }
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
function latestOwnerSide(presence, posId, tick) {
  return latestClaimAt(presence, posId, tick)?.side ?? null;
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

function occupantsInPosition(posId, meta, states, network, side) {
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const names = [];
  for (const p of meta.players || []) {
    if (teamSides[p.team] !== side) continue;
    const s = states?.[p.slot];
    if (!s?.alive || !Number.isFinite(s.x)) continue;
    if (positionsAtPoint(s.x, s.y, network).some((z) => z.id === posId)) {
      names.push(p.name || p.id);
    }
  }
  return names;
}

function paintLabel(key) {
  switch (key) {
    case 't-active':
      return 'T active';
    case 't-control':
      return 'T controlled';
    case 'ct-active':
      return 'CT active';
    case 'ct-control':
      return 'CT controlled';
    case 'contested':
      return 'Contested';
    case 'contested-active':
      return 'Contested (occupied)';
    default:
      return 'Neutral';
  }
}

/**
 * Full paint map for the playhead: foot presence + vision + surround.
 *
 * @returns {{ paint: Record<string, ZonePaint>, info: Record<string, object> }}
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
  /** @type {Record<string, object>} */
  const info = {};
  if (!network?.zones?.length) return { paint, info };

  const active = activePositionsAt({ meta, states, network });
  const { tSight, ctSight, contestedSight, sightNow } = applyVisionClaims({
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

  // Contested is present-tense only: both sides here now, or one side here
  // while the other sees it now, or both sides see it now. Old visits never
  // force contested.
  for (const pos of network.zones) {
    if (!pos?.id || pos.hidden) continue;
    const tAct = active.t.has(pos.id);
    const ctAct = active.ct.has(pos.id);
    const tSee = tSight.has(pos.id);
    const ctSee = ctSight.has(pos.id);
    const fightNow = contestedSight.has(pos.id);

    if (tAct && ctAct) {
      paint[pos.id] = 'contested-active';
    } else if (tAct && (fightNow || ctSee)) {
      paint[pos.id] = 'contested-active';
    } else if (ctAct && (fightNow || tSee)) {
      paint[pos.id] = 'contested-active';
    } else if (tAct) {
      paint[pos.id] = 't-active';
    } else if (ctAct) {
      paint[pos.id] = 'ct-active';
    } else if (fightNow || (tSee && ctSee)) {
      paint[pos.id] = 'contested';
    } else if (tSee) {
      paint[pos.id] = 't-control';
    } else if (ctSee) {
      paint[pos.id] = 'ct-control';
    } else {
      // Soft control: whichever side claimed most recently (re-entries count).
      const latest = latestOwnerSide(presence, pos.id, tick);
      paint[pos.id] =
        latest === 'T' ? 't-control' : latest === 'CT' ? 'ct-control' : 'empty';
    }
  }

  const surroundAssigned = applySurroundControl(paint, network, presence, tick);

  for (const pos of network.zones) {
    if (!pos?.id || pos.hidden) continue;
    const key = paint[pos.id] || 'empty';
    const why = [];
    const tOcc = occupantsInPosition(pos.id, meta, states, network, 'T');
    const ctOcc = occupantsInPosition(pos.id, meta, states, network, 'CT');
    if (tOcc.length) {
      why.push({ kind: 'active', side: 'T', text: `T standing here now: ${tOcc.join(', ')}` });
    }
    if (ctOcc.length) {
      why.push({ kind: 'active', side: 'CT', text: `CT standing here now: ${ctOcc.join(', ')}` });
    }
    for (const s of sightNow.get(pos.id) || []) {
      why.push({
        kind: s.enemy ? 'sight-enemy' : 'sight',
        side: s.side,
        text: s.enemy
          ? `${s.playerName} (${s.side}) sees an enemy here now (${Math.round(s.cover * 100)}% cover)`
          : `${s.playerName} (${s.side}) has clear sight now (${Math.round(s.cover * 100)}% cover)`
      });
    }
    const sur = surroundAssigned.get(pos.id);
    if (sur) {
      why.push({
        kind: 'surround',
        side: sur.side,
        text: `Neutral pocket → ${sur.side} (borders: ${sur.neighborNames.join(', ')})`
      });
    }
    // Soft historical control only explained when it actually drives the paint
    // (empty of present fights) — never as a contested reason. Cite the latest
    // claim tick, not the first visit of the round.
    const tFirst = presence?.firstT.get(pos.id);
    const ctFirst = presence?.firstCT.get(pos.id);
    const softClaim = latestClaimAt(presence, pos.id, tick);
    if (
      key === 't-control' &&
      !tSight.has(pos.id) &&
      !sur &&
      softClaim?.side === 'T'
    ) {
      why.push({
        kind: 'visit',
        side: 'T',
        tick: softClaim.tick,
        text: 'Soft T control from the latest claim (no present CT contest)'
      });
    }
    if (
      key === 'ct-control' &&
      !ctSight.has(pos.id) &&
      !sur &&
      softClaim?.side === 'CT'
    ) {
      why.push({
        kind: 'visit',
        side: 'CT',
        tick: softClaim.tick,
        text: 'Soft CT control from the latest claim (no present T contest)'
      });
    }
    if (key === 't-active' && !ctOcc.length) {
      why.push({
        kind: 'present',
        side: 'T',
        text: 'Only T here now — not contested (enemy must be present or see it now)'
      });
    }
    if (key === 'ct-active' && !tOcc.length) {
      why.push({
        kind: 'present',
        side: 'CT',
        text: 'Only CT here now — not contested (enemy must be present or see it now)'
      });
    }
    if (!why.length && key === 'empty') {
      why.push({ kind: 'neutral', side: null, text: 'No team has claimed this position yet' });
    }

    const history = (presence?.events?.get(pos.id) || [])
      .filter((e) => e.tick <= tick)
      .map((e) => ({
        tick: e.tick,
        side: e.side,
        reason: e.reason,
        playerName: e.playerName || '',
        detail: e.detail || ''
      }));

    info[pos.id] = {
      id: pos.id,
      name: pos.name || pos.id,
      paint: key,
      label: paintLabel(key),
      owner: sideOfPaint(key),
      why,
      history,
      firstT: Number.isFinite(tFirst) && tFirst <= tick ? tFirst : null,
      firstCT: Number.isFinite(ctFirst) && ctFirst <= tick ? ctFirst : null
    };
  }

  return { paint, info };
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

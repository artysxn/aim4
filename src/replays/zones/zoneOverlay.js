// ---------------------------------------------------------------------------
// replays/zones/zoneOverlay.js
// Map possession for the timeline overlay: who is where, who can see where,
// and who has held what.
//
// Vision is a vector sweep — one exact visibility polygon per living player per
// frame (see visibilityPolygon.js). Those polygons paint seconds of exposure
// into a hidden lattice (controlField.js), ownership resolves from that, and
// the renderer gets outlines traced back out of it (fieldContours.js). No part
// of the pipeline point-samples a grid, and nothing is ever drawn as cells.
//
// Six paint classes, and only six: T and CT each get an active and a soft tone,
// plus neutral gray and contested red.
// ---------------------------------------------------------------------------

import { RADAR_SIZE, worldToRadar } from '../viewer/mapCalibration.js';
import { getVisionLayerTests } from './visionLayers.js';
import { getMapSegments } from './mapSegments.js';
import { visibilityCone } from './visibilityPolygon.js';
import {
  CLASS_CONTESTED,
  CLASS_CT,
  CLASS_CT_FADING,
  CLASS_EMPTY,
  CLASS_T,
  CLASS_T_FADING,
  FOOT_NEAR_WORLD,
  SIDE_CT,
  SIDE_NONE,
  SIDE_T,
  cellsNearInto,
  classifyCell,
  getFieldGeometry,
  paintClassOf
} from './controlField.js';
import {
  VISION_STRIDE,
  activeMasksFromStates,
  createActiveMasks,
  createControlSimulator,
  controlShares
} from './mapControl.js';
import { contoursFor } from './fieldContours.js';

/** @typedef {'empty'|'t-active'|'t-control'|'ct-active'|'ct-control'|'contested'} ZonePaint */

export const ZONE_PAINT = {
  empty: { fill: 'rgba(130,138,150,0.22)', stroke: 'rgba(170,178,190,0.55)' },
  't-active': { fill: 'rgba(240,193,74,0.48)', stroke: '#f0c14a' },
  't-control': { fill: 'rgba(150,115,28,0.34)', stroke: '#9a7620' },
  'ct-active': { fill: 'rgba(91,159,212,0.48)', stroke: '#5b9fd4' },
  'ct-control': { fill: 'rgba(40,90,130,0.34)', stroke: '#2f6a96' },
  contested: { fill: 'rgba(210,70,70,0.40)', stroke: '#d45555' },
  // Not new colors: the soft tones again, fainter, for ground that is slipping
  // back to neutral. Same hue so a retreating edge still reads as that side's.
  't-fading': { fill: 'rgba(150,115,28,0.15)', stroke: '#9a7620' },
  'ct-fading': { fill: 'rgba(40,90,130,0.15)', stroke: '#2f6a96' }
};

/** Half-angle of the vision cone (degrees). */
const SIGHT_FOV_DEG = 30;
/** Stop the sweep past this world distance. */
const SIGHT_RAY_MAX = 4200;
/**
 * Radar alpha at or below this is outside the map (transparent PNG) — the same
 * mask the overlay punches with `destination-in`.
 */
const WALL_ALPHA = 28;
/**
 * Near-black opaque texels are building / roof fill on Valve radars — solid
 * alpha so they survive the clip mask, but they are not walkable floor and must
 * block sight (Inferno Aps wall, Mirage kitchen, and so on).
 */
const WALKABLE_MIN_LUM = 28;
/** Smoke lifetime — matches the radar renderer. */
const SMOKE_SECONDS = 22;
/** Smoke cloud radius in world units — matches radarRenderer.SMOKE_RADIUS_UNITS. */
const SMOKE_RADIUS_UNITS = 144;

/** @type {Map<string, object>} */
const losCache = new Map();

/**
 * Walkable bitmask from RADAR_SIZE² RGBA bytes.
 *
 * Walkable floor = opaque enough (same alpha punch as the overlay clip) and not
 * near-black building fill. Transparent and solid-black both block. This is the
 * single definition of "walkable" — the browser feeds it canvas pixels, node
 * feeds it decoded PNG bytes.
 *
 * @param {Uint8ClampedArray|Uint8Array} data
 * @returns {Uint8Array}
 */
export function maskFromRgba(data) {
  const mask = new Uint8Array(RADAR_SIZE * RADAR_SIZE);
  for (let y = 0; y < RADAR_SIZE; y++) {
    const row = y * RADAR_SIZE;
    for (let x = 0; x < RADAR_SIZE; x++) {
      const i = (row + x) * 4;
      if (data[i + 3] <= WALL_ALPHA) continue;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum >= WALKABLE_MIN_LUM) mask[row + x] = 1;
    }
  }
  return mask;
}

/**
 * Line-of-sight raster from the radar PNG, via a canvas.
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

  const mask = maskFromRgba(data);
  const scratch = {};
  const walkable = (px, py) => {
    const x = px | 0;
    const y = py | 0;
    if (x < 0 || y < 0 || x >= RADAR_SIZE || y >= RADAR_SIZE) return false;
    return mask[y * RADAR_SIZE + x] !== 0;
  };
  const isWalkableWorld = (wx, wy) => {
    worldToRadar(mapCode, wx, wy, scratch);
    return walkable(scratch.x, scratch.y);
  };

  const los = { isWalkableWorld, walkable, mask, image, version: 3 };
  losCache.set(mapCode, los);
  return los;
}

/**
 * Register a pre-built walkable raster for a map.
 *
 * The browser bakes this from the radar PNG through a canvas, but callers with
 * no DOM (the coach run in node, the baseline sampler) have no canvas to bake
 * with. Handing the mask in lets them share the exact same lattice, which is
 * the only way their numbers can line up with what the viewer shows.
 *
 * @param {string} mapCode
 * @param {Uint8Array} mask  RADAR_SIZE² walkable bitmask
 */
export function registerRadarMask(mapCode, mask) {
  if (!mapCode || mask?.length !== RADAR_SIZE * RADAR_SIZE) return null;
  const scratch = {};
  const walkable = (px, py) => {
    const x = px | 0;
    const y = py | 0;
    if (x < 0 || y < 0 || x >= RADAR_SIZE || y >= RADAR_SIZE) return false;
    return mask[y * RADAR_SIZE + x] !== 0;
  };
  const los = {
    walkable,
    mask,
    image: null,
    version: 3,
    isWalkableWorld: (wx, wy) => {
      worldToRadar(mapCode, wx, wy, scratch);
      return walkable(scratch.x, scratch.y);
    }
  };
  losCache.set(mapCode, los);
  return los;
}

/**
 * Attach the possession lattice and wall segments to a network.
 * Both are per-map and cached, so this is cheap to call every frame.
 *
 * With no image, an already-baked raster for this map is used if there is one —
 * that is what lets the coach run without the renderer plumbing its image
 * through, once the viewer has loaded the radar.
 *
 * @param {object | null | undefined} network
 * @param {string} mapCode
 * @param {CanvasImageSource | null} [radarImage]
 */
export function prepareControlField(network, mapCode, radarImage = null) {
  if (!network || !mapCode) return network;
  const los = radarImage ? getRadarLos(mapCode, radarImage) : losCache.get(mapCode) || null;
  if (!los) return network;
  const geom = getFieldGeometry(mapCode, los);
  if (!geom) return network;
  const layers = getVisionLayerTests(network, mapCode);
  network._fieldGeom = geom;
  network._segments = getMapSegments(mapCode, los, layers);
  network._layers = layers;
  return network;
}

/** @param {object | null | undefined} network */
export function hasControlField(network) {
  return Boolean(network?._fieldGeom?.count);
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

/**
 * One player's visibility polygon.
 *
 * Elevated paint blocks everyone except a viewer standing on it, so it lives in
 * its own segment set and is simply left out of the query in that case.
 *
 * @returns {Float32Array | null}
 */
export function castViewerCone({ viewer, network, smokes }) {
  const segments = network?._segments;
  if (!segments?.base || !viewer) return null;
  const layers = network._layers;
  const onElevated = Boolean(layers?.elevatedAt?.(viewer.x, viewer.y));
  return visibilityCone({
    ox: viewer.x,
    oy: viewer.y,
    yawDeg: Number(viewer.yaw) || 0,
    halfFovDeg: SIGHT_FOV_DEG,
    maxDist: SIGHT_RAY_MAX,
    sources: onElevated ? [segments.base] : [segments.base, segments.elevated],
    smokes,
    smokeRadius: SMOKE_RADIUS_UNITS
  });
}

/**
 * Bind map / radar / grenades into a cast function for the simulator.
 * @returns {(ctx: { viewer: object, tick: number }) => Float32Array|null}
 */
export function createConeCaster({ meta, network, mapCode, radarImage }) {
  prepareControlField(network, mapCode, radarImage);
  if (!meta || !hasControlField(network)) return () => null;
  const tickRate = meta.tickRate || 64;
  const grenades = meta.events?.grenades || [];
  let cachedTick = -1;
  let cachedSmokes = [];
  return ({ viewer, tick }) => {
    if (tick !== cachedTick) {
      cachedSmokes = activeSmokes(grenades, tick, tickRate);
      cachedTick = tick;
    }
    return castViewerCone({ viewer, network, smokes: cachedSmokes });
  };
}

/**
 * Soft ownership over a round: which side last had feet on each cell.
 *
 * Stored as a change list rather than a frame per second — a full lattice per
 * sample would be megabytes per round. Reading walks a cursor forward, and a
 * backward seek replays from the start, which is a few hundred thousand writes.
 *
 * Only foot visits land here. Sight ownership flows through the exposure field
 * instead, so nothing mutates presence during paint any more and the result no
 * longer depends on which frames happened to render.
 *
 * @returns {object | null}
 */
export function buildZonePresence({ meta, track, network, mapCode = '', radarImage = null }) {
  if (mapCode) prepareControlField(network, mapCode, radarImage);
  const geom = network?._fieldGeom;
  if (!meta || !track || !geom) return null;

  const from = meta.freezeEndTick ?? meta.startTick ?? 0;
  const to = Math.max(from, meta.endTick ?? from);
  const tickRate = meta.tickRate || 64;
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const players = meta.players || [];
  const nFrames = Math.floor((to - from) / tickRate) + 1;

  const cur = new Uint8Array(geom.count);
  const frameStart = new Int32Array(nFrames + 1);
  /** @type {number[]} */
  const cells = [];
  /** @type {number[]} */
  const sides = [];
  const foot = new Int32Array(64);
  const scratch = [];

  for (let f = 0; f < nFrames; f++) {
    frameStart[f] = cells.length;
    const tick = from + f * tickRate;
    track.sampleAll(tick, scratch);
    for (const p of players) {
      const side = teamSides[p.team] === 'T' ? SIDE_T : teamSides[p.team] === 'CT' ? SIDE_CT : 0;
      if (!side) continue;
      const s = scratch[p.slot];
      if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      const n = cellsNearInto(geom, s.x, s.y, FOOT_NEAR_WORLD, foot);
      for (let i = 0; i < n; i++) {
        const idx = foot[i];
        if (cur[idx] === side) continue;
        cur[idx] = side;
        cells.push(idx);
        sides.push(side);
      }
    }
  }
  frameStart[nFrames] = cells.length;
  cur.fill(0);

  return {
    from,
    tickRate,
    nFrames,
    frameStart,
    changeCell: Int32Array.from(cells),
    changeSide: Uint8Array.from(sides),
    owners: cur,
    cursor: 0
  };
}

/**
 * Soft owners as of `tick`. Returns the presence buffer itself, so callers must
 * read it before advancing the cursor again.
 * @returns {Uint8Array | null}
 */
export function softOwnersAt(presence, tick) {
  if (!presence) return null;
  const { from, tickRate, nFrames, frameStart, changeCell, changeSide, owners } = presence;
  let target = Math.floor((tick - from) / tickRate) + 1;
  if (target < 0) target = 0;
  if (target > nFrames) target = nFrames;

  if (target < presence.cursor) {
    owners.fill(0);
    presence.cursor = 0;
  }
  for (let k = frameStart[presence.cursor]; k < frameStart[target]; k++) {
    owners[changeCell[k]] = changeSide[k];
  }
  presence.cursor = target;
  return owners;
}

/** Reusable per-network foot masks. */
function ensureMasks(network, geom) {
  if (!network._activeMasks || network._activeMasks.t.length !== geom.count) {
    network._activeMasks = createActiveMasks(geom);
  }
  return network._activeMasks;
}

/**
 * Per-side foot occupancy for the current tick.
 * @returns {{ t: Uint8Array, ct: Uint8Array } | null}
 */
export function activeMasksAt({ meta, states, network }) {
  const geom = network?._fieldGeom;
  if (!geom) return null;
  const masks = ensureMasks(network, geom);
  return activeMasksFromStates(meta, states, geom, masks);
}

/** Per-round simulator + contour cache for the timeline overlay. */
export function createZoneVisionCache() {
  return {
    simKey: '',
    sim: null,
    contour: { key: '', rings: null }
  };
}

export function resetZoneVisionCache(cache) {
  if (!cache) return;
  cache.simKey = '';
  cache.sim = null;
  cache.contour = { key: '', rings: null };
}

/**
 * Everything the renderer needs for one playhead tick.
 *
 * Live cones are cast every frame — they follow the yaw, so sampling them at
 * the simulation stride would make them stutter, and at ~30us each that is not
 * worth avoiding. Territory outlines only change when the simulation steps, so
 * they come from the contour cache.
 *
 * @returns {{
 *   territory: { t: Float32Array[], ct: Float32Array[], contested: Float32Array[] },
 *   cones: { t: Float32Array[], ct: Float32Array[] },
 *   feet: { t: Array<{x:number,y:number}>, ct: Array<{x:number,y:number}> },
 *   footRadius: number
 * } | null}
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
  prepareControlField(network, mapCode, radarImage);
  const geom = network?._fieldGeom;
  if (!geom || !meta) return null;

  const tickRate = meta.tickRate || 64;
  const smokes = activeSmokes(grenades, tick, tickRate);
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };

  // ---- live cones + feet -------------------------------------------------
  const cones = { t: [], ct: [] };
  const feet = { t: [], ct: [] };
  for (const p of meta.players || []) {
    const side = teamSides[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    const s = states?.[p.slot];
    if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    (side === 'T' ? feet.t : feet.ct).push({ x: s.x, y: s.y });
    if (!Number.isFinite(s.yaw)) continue;
    const ring = castViewerCone({ viewer: s, network, smokes });
    if (ring) (side === 'T' ? cones.t : cones.ct).push(ring);
  }

  // ---- accumulated ownership ---------------------------------------------
  let field = null;
  if (track && visionCache) {
    const simKey = [
      mapCode,
      meta.startTick ?? 0,
      meta.freezeEndTick ?? 0,
      meta.endTick ?? 0,
      meta.team1Side || '',
      meta.team2Side || '',
      network.updatedAt || 0,
      network._layerPaintGen || 0
    ].join('|');
    if (!visionCache.sim || visionCache.simKey !== simKey) {
      visionCache.sim = createControlSimulator({
        meta,
        track,
        geom,
        castCone: createConeCaster({ meta, network, mapCode, radarImage })
      });
      visionCache.simKey = simKey;
      visionCache.contour = { key: '', rings: null };
    }
    field = visionCache.sim.fieldAt(tick);
  }

  // Soft control lives entirely in the field: feet claim into it just as vision
  // does. Falling back to raw foot history here would resurrect every cell the
  // field had just decayed, which is the whole point of the decay.
  let classifyAt;
  let key;
  if (field) {
    classifyAt = (i) => paintClassOf(field, i);
    key = `f${field.gen}`;
  } else {
    const soft = softOwnersAt(presence, tick);
    classifyAt = (i) => {
      const v = soft ? soft[i] : SIDE_NONE;
      return v === SIDE_T ? CLASS_T : v === SIDE_CT ? CLASS_CT : CLASS_EMPTY;
    };
    key = `p${presence ? presence.cursor : 0}`;
  }

  const rings = contoursFor(
    geom,
    classifyAt,
    [CLASS_T, CLASS_CT, CLASS_CONTESTED, CLASS_T_FADING, CLASS_CT_FADING],
    visionCache?.contour,
    key
  );

  return {
    territory: {
      t: rings.get(CLASS_T) || [],
      ct: rings.get(CLASS_CT) || [],
      contested: rings.get(CLASS_CONTESTED) || [],
      tFading: rings.get(CLASS_T_FADING) || [],
      ctFading: rings.get(CLASS_CT_FADING) || []
    },
    cones,
    feet,
    footRadius: FOOT_NEAR_WORLD
  };
}

/**
 * Area-weighted possession for the current tick.
 *
 * @param {object} network
 * @param {object|null} field   ControlField, or null for presence-only
 * @param {{ t: Uint8Array, ct: Uint8Array }|null} masks
 * @param {Uint8Array|null} soft
 * @returns {{ counts: object, pct: { t: number, ct: number, neutral: number } }}
 */
export function summarizeZoneControl(network, field, masks, soft = null) {
  const geom = network?._fieldGeom;
  const counts = { t: 0, ct: 0, contested: 0, neutral: 0, total: 0 };
  if (!geom) return { counts, pct: { t: 0, ct: 0, neutral: 100 } };

  for (let i = 0; i < geom.count; i++) {
    if (!geom.walkable[i]) continue;
    counts.total++;
    const tAct = masks ? masks.t[i] === 1 : false;
    const ctAct = masks ? masks.ct[i] === 1 : false;
    if (tAct && ctAct) {
      counts.contested++;
      continue;
    }
    if (tAct) {
      counts.t++;
      continue;
    }
    if (ctAct) {
      counts.ct++;
      continue;
    }
    let cls = field ? classifyCell(field, i) : CLASS_EMPTY;
    if (cls === CLASS_EMPTY && soft) {
      const v = soft[i];
      cls = v === SIDE_T ? CLASS_T : v === SIDE_CT ? CLASS_CT : CLASS_EMPTY;
    }
    if (cls === CLASS_T) counts.t++;
    else if (cls === CLASS_CT) counts.ct++;
    else if (cls === CLASS_CONTESTED) counts.contested++;
    else counts.neutral++;
  }

  const denom = counts.total > 0 ? counts.total : 1;
  return {
    counts,
    area: {
      t: counts.t * geom.area,
      ct: counts.ct * geom.area,
      neutral: (counts.neutral + counts.contested) * geom.area,
      total: counts.total * geom.area
    },
    pct: {
      t: (counts.t / denom) * 100,
      ct: (counts.ct / denom) * 100,
      neutral: ((counts.neutral + counts.contested) / denom) * 100
    }
  };
}

export { VISION_STRIDE, controlShares };

// ---------------------------------------------------------------------------
// replays/duels/sightRay.js
// One ray, nearest occluder.
//
// The zone overlay already casts full visibility polygons (zoneOverlay's
// castViewerCone), but a duel only ever asks two much smaller questions: how
// far does this player's crosshair reach before it meets a wall, and is there
// anything between these two players. Sweeping a whole cone to answer either
// would be paying for 200 rays to read one.
//
// Occluders are the same ones the cone honours, and gathered the same way, so
// an aim ray drawn here stops exactly where the zone cone would have stopped:
//   - walls and painted vision blocks (segments.base)
//   - elevated paint, unless the viewer is standing on it
//   - underpass paint, only when the viewer is inside it
//   - one-way ledges, from the blocking side
//   - live smoke, as a circle
//
// DOM-free on purpose so the trainer in node and the viewer share it.
// ---------------------------------------------------------------------------

import { RADAR_SIZE, worldToRadar } from '../viewer/mapCalibration.js';
import { queryBounds } from '../zones/mapSegments.js';
import { appendBlockingLedgeSegs } from '../zones/ledges.js';
import { getCachedLos } from '../zones/zoneOverlay.js';

const DEG = Math.PI / 180;

/** Hard ceiling on candidate walls per cast. */
const MAX_CANDIDATES = 4096;
/** Smoke cloud radius in world units, matching the viewer's utility markers. */
export const SMOKE_RADIUS_UNITS = 144;

/**
 * World units at each end of a sight line that are not tested.
 *
 * Wall segments come off a raster at roughly 5 world units per texel, and
 * players stand flush against geometry constantly, so a player's own cover can
 * round onto their feet. Without this margin such a player reads as blind along
 * every angle including the one they are holding. Same reasoning and same
 * value as visionLayers' SIGHT_ENDPOINT_MARGIN, which exists for this exact
 * failure.
 */
const ENDPOINT_MARGIN = 40;

const scratchSegs = new Float32Array(MAX_CANDIDATES * 4);

/**
 * Query generation, counting DOWN.
 *
 * queryBounds dedupes with a stamp written into the segment index's shared
 * `mark` array, and visibilityPolygon stamps the same indexes counting up from
 * 1. Going negative from 0 means the two modules can never collide on a value,
 * which they otherwise would after enough casts. A collision drops segments
 * silently, and a dropped segment reads as sight through a wall.
 */
let queryStamp = 0;

/**
 * Gather every occluding segment whose AABB overlaps the query box.
 * @returns {number} segments written into `scratchSegs`, or -1 with no geometry
 */
function gatherOccluders(network, ox, oy, minX, minY, maxX, maxY) {
  const segments = network?._segments;
  if (!segments?.base) return -1;
  const layers = network._layers;
  const onElevated = Boolean(layers?.elevatedAt?.(ox, oy));
  const onUnderpass = Boolean(layers?.underpassAt?.(ox, oy));

  queryStamp--;
  let n = queryBounds(segments.base, minX, minY, maxX, maxY, scratchSegs, 0, queryStamp);
  if (!onElevated && segments.elevated) {
    n = queryBounds(segments.elevated, minX, minY, maxX, maxY, scratchSegs, n, queryStamp);
  }
  if (onUnderpass && segments.underpass) {
    n = queryBounds(segments.underpass, minX, minY, maxX, maxY, scratchSegs, n, queryStamp);
  }
  return appendBlockingLedgeSegs(
    network.ledges,
    ox,
    oy,
    minX,
    minY,
    maxX,
    maxY,
    scratchSegs,
    n
  );
}

/**
 * Nearest segment crossing along a unit-direction ray.
 * @returns {number} distance to the first hit, or `best` when nothing blocks
 */
function nearestSegmentHit(count, ox, oy, dx, dy, best, nearLimit) {
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const px = scratchSegs[o];
    const py = scratchSegs[o + 1];
    const ex = scratchSegs[o + 2] - px;
    const ey = scratchSegs[o + 3] - py;
    const denom = dx * ey - dy * ex;
    if (denom > -1e-12 && denom < 1e-12) continue;
    const wx = px - ox;
    const wy = py - oy;
    const t = (wx * ey - wy * ex) / denom;
    if (t <= nearLimit || t >= best) continue;
    const s = (wx * dy - wy * dx) / denom;
    if (s < 0 || s > 1) continue;
    best = t;
  }
  return best;
}

/**
 * Nearest smoke crossing along a unit-direction ray.
 *
 * A viewer standing inside a cloud is blocked at zero: in CS2 you cannot see
 * out of a smoke you are in, and reporting the far edge would let the model
 * think a smoked player still holds their angle.
 */
function nearestSmokeHit(smokes, radius, ox, oy, dx, dy, best) {
  if (!smokes?.length || !(radius > 0)) return best;
  const r2 = radius * radius;
  for (const s of smokes) {
    const cx = s.x - ox;
    const cy = s.y - oy;
    const proj = cx * dx + cy * dy;
    const perp2 = cx * cx + cy * cy - proj * proj;
    if (perp2 > r2) continue;
    const half = Math.sqrt(r2 - perp2);
    if (proj + half <= 0) continue; // cloud is entirely behind the viewer
    const t = proj - half > 0 ? proj - half : 0;
    if (t < best) best = t;
  }
  return best;
}

/**
 * How far this player can see along one angle.
 *
 * @param {object} args
 * @param {number} args.ox @param {number} args.oy   viewer world position
 * @param {number} args.dirDeg                        world yaw, degrees
 * @param {number} args.maxDist                       range cap, world units
 * @param {object} args.network                       zone network, prepared
 * @param {Array<{x:number,y:number}>} [args.smokes]
 * @param {number} [args.smokeRadius]
 * @returns {{ x: number, y: number, dist: number, blocked: boolean }}
 */
export function castSightRay({
  ox,
  oy,
  dirDeg,
  maxDist,
  network,
  smokes = null,
  smokeRadius = SMOKE_RADIUS_UNITS
}) {
  const a = dirDeg * DEG;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const endX = ox + dx * maxDist;
  const endY = oy + dy * maxDist;

  let best = maxDist;
  const count = gatherOccluders(
    network,
    ox,
    oy,
    Math.min(ox, endX),
    Math.min(oy, endY),
    Math.max(ox, endX),
    Math.max(oy, endY)
  );
  if (count > 0) best = nearestSegmentHit(count, ox, oy, dx, dy, best, ENDPOINT_MARGIN);
  best = nearestSmokeHit(smokes, smokeRadius, ox, oy, dx, dy, best);

  return {
    x: ox + dx * best,
    y: oy + dy * best,
    dist: best,
    blocked: best < maxDist - 1e-3
  };
}

/**
 * Combined "blocks sight" raster for a map: unwalkable radar texels OR painted
 * vision blocks. Cached on the network, rebuilt when the paint changes.
 *
 * This is the same input getMapSegments extracts its walls from, so a line
 * tested against the raster and a ray traced against the segments agree to
 * within the segment simplification tolerance, about ten world units.
 *
 * @returns {Uint8Array | null}
 */
export function getBlockedMask(network, mapCode) {
  const los = getCachedLos(mapCode);
  if (!los?.mask) return null;
  const layers = network?._layers;
  const key = `${mapCode}|${los.version ?? 0}|${layers?.key || ''}`;
  if (network?._duelBlockedMask?.key === key) return network._duelBlockedMask.mask;

  const walkable = los.mask;
  const visionMask = layers?.visionMask || null;
  const n = RADAR_SIZE * RADAR_SIZE;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    mask[i] = walkable[i] === 0 || (visionMask && visionMask[i] !== 0) ? 1 : 0;
  }
  if (network) network._duelBlockedMask = { key, mask };
  return mask;
}

/**
 * World units between samples when walking a sight line. The raster is about
 * five world units per texel on every supported map, so this cannot step over
 * a wall.
 */
const WALK_STEP_UNITS = 4;
/** Ceiling on samples for one line, so a map-length test stays cheap. */
const WALK_MAX_SAMPLES = 600;

/**
 * Lateral tolerance on a sight line, world units, as a function of range.
 *
 * A line drawn between two player origins is a fiction. Players are about 32
 * units wide and shoot from a shoulder, so the shot that kills you routinely
 * comes from an arm past a corner while the shooter's origin is still behind
 * it. Requiring the origin-to-origin line to be clear throws those kills away,
 * and they are exactly the kills a duel model needs most: the ones fought at
 * the edge of cover.
 *
 * The tolerance shrinks with range because the error it is forgiving is angular
 * at heart. Half a body width at 200 units is a wide arc a player really can
 * shoot through; the same offset at 2000 units is a rounding error on a raster,
 * and forgiving it there would start joining rooms that share no sightline.
 *
 * Measured against 2538 real gun kills across the corpus: without this, a third
 * of them read as impossible. With it, one in six. The rest are the flat 2D
 * model's own limits, mostly shooting over waist-high cover.
 */
const CORNER_SLACK_MIN = 24;
const CORNER_SLACK_MAX = 96;
const CORNER_SLACK_FALLOFF = 600;

/**
 * Below this range smoke does not block.
 *
 * A cloud is opaque at distance but not at arm's length: two players inside one
 * see each other, and pros trade point blank in smoke constantly. Without a
 * floor, a 34 unit kill inside a cloud reads as impossible.
 */
const SMOKE_MIN_BLOCK_DIST = 150;

/** Nominal cloud lifetime, matching the viewer's utility markers. */
export const SMOKE_LIFETIME_SECONDS = 22;

/**
 * The tail of a cloud's life during which it no longer blocks.
 *
 * A smoke does not switch off, it thins out, and players become partially
 * visible through the last of it well before it clears. Treating the whole
 * lifetime as opaque marks real kills through dying smoke as impossible.
 */
export const SMOKE_FADE_SECONDS = 3.5;

const radarScratch = { x: 0, y: 0 };

/**
 * Smoke clouds that actually block sight at `tick`.
 *
 * The zone overlay's activeSmokes answers "is there a cloud here", which is the
 * right question for drawing one. This answers "would a player have been hidden
 * by it", which ends earlier: the last few seconds of a cloud are see-through
 * enough to shoot someone in.
 *
 * @param {Array} grenades  meta.events.grenades
 * @param {number} tick
 * @param {number} tickRate
 * @returns {Array<{x:number,y:number}>}
 */
export function blockingSmokesAt(grenades, tick, tickRate = 64) {
  const out = [];
  const opaque = (SMOKE_LIFETIME_SECONDS - SMOKE_FADE_SECONDS) * tickRate;
  for (const g of grenades || []) {
    if (g.type !== 'smokegrenade') continue;
    const det = Number(g.detonateTick);
    if (!Number.isFinite(det) || tick < det || tick > det + opaque) continue;
    if (!g.at || !Number.isFinite(g.at.x) || !Number.isFinite(g.at.y)) continue;
    out.push({ x: g.at.x, y: g.at.y });
  }
  return out;
}

/** @param {number} dist */
export function cornerSlack(dist) {
  return (
    CORNER_SLACK_MIN +
    (CORNER_SLACK_MAX - CORNER_SLACK_MIN) * Math.exp(-dist / CORNER_SLACK_FALLOFF)
  );
}

/** One raster walk. True when any sample along the line lands on a blocker. */
function rasterLineBlocked(mask, mapCode, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const dist = Math.hypot(vx, vy);
  if (dist <= ENDPOINT_MARGIN * 2) return false;

  const steps = Math.min(WALK_MAX_SAMPLES, Math.max(2, Math.ceil(dist / WALK_STEP_UNITS)));
  const skip = ENDPOINT_MARGIN / dist;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (t < skip || t > 1 - skip) continue;
    worldToRadar(mapCode, ax + vx * t, ay + vy * t, radarScratch);
    const px = radarScratch.x | 0;
    const py = radarScratch.y | 0;
    if (px < 0 || py < 0 || px >= RADAR_SIZE || py >= RADAR_SIZE) return true;
    if (mask[py * RADAR_SIZE + px] !== 0) return true;
  }
  return false;
}

/**
 * Is the line between two players broken by anything?
 *
 * Walks the blocked raster rather than intersecting wall segments. This runs
 * twenty-five times per tick during extraction, millions of times over a
 * training corpus, and a raster walk is a flat array lookup per step where the
 * segment query has to gather candidates across a broad-phase index first. It
 * is the same trade visionLayers' segmentCrossesVision already makes, for the
 * same reason.
 *
 * When the centre line is blocked, four more are tried: each player's position
 * shifted sideways by the corner slack above, which stands in for the body one
 * of them has exposed past the edge of their cover. Any of the five clearing is
 * enough.
 *
 * Elevated paint is deliberately not consulted: it blocks only viewers who are
 * not standing on it, and a flat line between two players carries no height
 * context to decide that with. Vision blocks are unconditional and safe.
 *
 * @returns {boolean} true when something is in the way
 */
export function losBlockedBetween({
  ax,
  ay,
  bx,
  by,
  network,
  mapCode,
  blockedMask = null,
  smokes = null,
  smokeRadius = SMOKE_RADIUS_UNITS
}) {
  const vx = bx - ax;
  const vy = by - ay;
  const dist = Math.hypot(vx, vy);
  if (!(dist > 0)) return false;

  if (dist > SMOKE_MIN_BLOCK_DIST) {
    const dx = vx / dist;
    const dy = vy / dist;
    if (nearestSmokeHit(smokes, smokeRadius, ax, ay, dx, dy, dist) < dist) return true;
  }

  // Two players this close are on top of each other; the endpoint margins would
  // consume the whole line and any answer would be noise.
  if (dist <= ENDPOINT_MARGIN * 2) return false;

  const mask = blockedMask || getBlockedMask(network, mapCode);
  if (!mask) return false;

  if (!rasterLineBlocked(mask, mapCode, ax, ay, bx, by)) return false;

  const slack = cornerSlack(dist);
  const px = (-vy / dist) * slack;
  const py = (vx / dist) * slack;
  if (!rasterLineBlocked(mask, mapCode, ax + px, ay + py, bx, by)) return false;
  if (!rasterLineBlocked(mask, mapCode, ax - px, ay - py, bx, by)) return false;
  if (!rasterLineBlocked(mask, mapCode, ax, ay, bx + px, by + py)) return false;
  if (!rasterLineBlocked(mask, mapCode, ax, ay, bx - px, by - py)) return false;
  return true;
}

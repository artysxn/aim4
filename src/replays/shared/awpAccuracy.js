// ---------------------------------------------------------------------------
// AWP accuracy eligibility (stats index / phase combat).
//
// Counts an AWP fire only when the hold is within 10° of a living enemy and
// the path to that enemy does not cross an active smoke. Recalculated from
// round JSON + tick bins when indexing — no demo re-parse required.
// ---------------------------------------------------------------------------

import { readHeader, readRecord } from './tickFormat.js';

/** Max yaw error (degrees) from an enemy to count a hold as "on" them. */
export const AWP_AIM_DEGREES = 10;
/** Smoke lifetime — matches radar / zone overlay. */
const SMOKE_SECONDS = 22;
/** Smoke disc radius in world units. */
const SMOKE_RADIUS = 144;

function bareWeapon(weapon) {
  return String(weapon || '')
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, '');
}

function yawDeltaDeg(a, b) {
  let d = Math.abs(Number(a) - Number(b)) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function yawTowardPoint(from, to) {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

function activeSmokeCenters(grenades, tick, tickRate) {
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

function segmentThroughSmoke(x0, y0, x1, y1, smokes, radius = SMOKE_RADIUS) {
  if (!smokes?.length) return false;
  const r2 = radius * radius;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  for (const s of smokes) {
    let t = 0;
    if (len2 > 1e-9) {
      t = ((s.x - x0) * dx + (s.y - y0) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const px = x0 + t * dx - s.x;
    const py = y0 + t * dy - s.y;
    if (px * px + py * py <= r2) return true;
  }
  return false;
}

function toDataView(buffer) {
  if (!buffer) return null;
  if (buffer instanceof DataView) return buffer;
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  return new DataView(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  );
}

function sideOfPlayer(player, meta) {
  if (!player) return '';
  if (player.team === 1) return meta.team1Side || 'T';
  if (player.team === 2) return meta.team2Side || 'CT';
  return '';
}

/**
 * Nearest tick-buffer row for a demo tick.
 * @returns {number} row index, or -1
 */
function rowForTick(header, tick) {
  if (!header || !Number.isFinite(tick)) return -1;
  const stride = Math.max(1, header.stride || 1);
  const row = Math.round((tick - header.firstTick) / stride);
  if (row < 0 || row >= header.tickCount) return -1;
  return row;
}

/**
 * Eligible AWP fire ticks per player (hold ≤10° on an enemy, clear of smoke).
 *
 * @param {object} meta  round meta (events.shots, events.grenades, players, …)
 * @param {ArrayBuffer|Buffer|DataView|null} tickBuffer
 * @returns {Map<string, Set<number>>} playerId → eligible shot ticks
 */
export function eligibleAwpShotTicks(meta, tickBuffer) {
  /** @type {Map<string, Set<number>>} */
  const out = new Map();
  const view = toDataView(tickBuffer);
  if (!meta || !view) return out;

  let header;
  try {
    header = readHeader(view);
  } catch {
    return out;
  }

  const tickRate = header.tickRate || meta.tickRate || 64;
  const players = meta.players || [];
  const byId = new Map(players.map((p) => [p.id, p]));
  const tmp = {};
  const grenades = meta.events?.grenades || [];

  for (const shot of meta.events?.shots || []) {
    if (bareWeapon(shot.weapon) !== 'awp' || !shot.player) continue;
    const shooter = byId.get(shot.player);
    if (!shooter || shooter.slot == null) continue;

    const row = rowForTick(header, shot.tick);
    if (row < 0) continue;

    readRecord(view, row, shooter.slot, tmp);
    const shooterSide = tmp.side || sideOfPlayer(shooter, meta);
    if (!shooterSide) continue;

    const sx =
      Number.isFinite(shot.x) && (shot.x !== 0 || shot.y !== 0) ? shot.x : tmp.x;
    const sy =
      Number.isFinite(shot.y) && (shot.x !== 0 || shot.y !== 0) ? shot.y : tmp.y;
    const yaw = Number.isFinite(shot.yaw) ? shot.yaw : tmp.yaw;

    const smokes = activeSmokeCenters(grenades, shot.tick, tickRate);

    /** @type {{ x: number, y: number } | null} */
    let bestEnemy = null;
    let bestDelta = Infinity;
    for (const pl of players) {
      if (pl.id === shot.player || pl.slot == null) continue;
      readRecord(view, row, pl.slot, tmp);
      if (!tmp.alive || !(tmp.health > 0)) continue;
      const side = tmp.side || sideOfPlayer(pl, meta);
      if (!side || side === shooterSide) continue;
      const toward = yawTowardPoint({ x: sx, y: sy }, tmp);
      const d = yawDeltaDeg(yaw, toward);
      if (d <= AWP_AIM_DEGREES && d < bestDelta) {
        bestDelta = d;
        bestEnemy = { x: tmp.x, y: tmp.y };
      }
    }
    if (!bestEnemy) continue;
    if (segmentThroughSmoke(sx, sy, bestEnemy.x, bestEnemy.y, smokes)) continue;

    let set = out.get(shot.player);
    if (!set) {
      set = new Set();
      out.set(shot.player, set);
    }
    set.add(shot.tick);
  }

  return out;
}

/**
 * Per-player AWP shot/hit counts after eligibility filter.
 *
 * @param {object} meta
 * @param {ArrayBuffer|Buffer|DataView|null} tickBuffer
 * @returns {Map<string, { shots: number, hits: number }>}
 */
export function awpAccuracyFromTicks(meta, tickBuffer) {
  /** @type {Map<string, { shots: number, hits: number }>} */
  const out = new Map();
  const eligible = eligibleAwpShotTicks(meta, tickBuffer);
  if (!eligible.size) return out;

  for (const [id, ticks] of eligible) {
    const hitTicks = new Set();
    for (const d of meta.events?.damage || []) {
      if (d.attacker !== id) continue;
      if (bareWeapon(d.weapon) !== 'awp') continue;
      if (!ticks.has(d.tick)) continue;
      hitTicks.add(d.tick);
    }
    out.set(id, { shots: ticks.size, hits: hitTicks.size });
  }

  return out;
}

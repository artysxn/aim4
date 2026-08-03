// ---------------------------------------------------------------------------
// replays/shared/aimMetrics.js
// The four measurements behind the Aim rating.
//
// All of it is derived from data already on disk, so this is a stats-index
// rebuild and never a demo reparse:
//
//   tick buffer     x/y/z, yaw, pitch, health, weapon, flags, side, per tick
//   shot events     tick, player, weapon, x/y/z, yaw, pitch
//   damage events   tick, attacker, victim, hp, weapon
//   grenade events  smoke detonations, for excluding shots into smoke
//
// The geometry helpers mirror awpAccuracy.js, which already does angle-to-enemy
// and smoke-intersection tests for AWP accuracy. That module is the precedent
// for computing a "real" accuracy number here rather than trusting a raw
// parser counter.
//
// Everything is measured in the horizontal plane (yaw only) unless stated.
// Pitch is recorded and used for the first-bullet cone, but crosshair placement
// is dominated by yaw and mixing the two into one angle makes crouch/stair
// geometry noisy for no benefit.
// ---------------------------------------------------------------------------

import { FLAG_ALIVE, readHeader, readRecord } from './tickFormat.js';
import { segmentCrossesVision } from '../zones/visionLayers.js';

/** An enemy inside this cone counts as "you were on them" for first bullet. */
export const FIRST_BULLET_CONE_DEG = 25;
/** Enemy engagements are sampled this far back from the enemy's shot. */
const ENGAGE_LOOKBACK_TICKS = 0;
/** How long after a shot a hit may land and still be attributed to it. */
const HIT_WINDOW_SECONDS = 0.2;
/** Smoke geometry, matching awpAccuracy.js and the viewer. */
const SMOKE_SECONDS = 22;
const SMOKE_RADIUS = 144;
/** Beyond this the "enemy can see you" test is unreliable, so the pair is skipped. */
const MAX_ENGAGE_DISTANCE = 3000;
/** The enemy has to be roughly looking at you for it to be an engagement. */
const ENEMY_FACING_DEG = 45;

const bare = (w) =>
  String(w || '')
    .toLowerCase()
    .replace(/^weapon_/, '');

/** Utility, knives and the bomb are not aim. */
const NON_AIM = /grenade|molotov|incgrenade|firebomb|inferno|decoy|flash|knife|bayonet|karambit|c4|world|taser|zeus/i;

export function isAimWeapon(weapon) {
  const b = bare(weapon);
  return Boolean(b) && !NON_AIM.test(b);
}

export function yawDeltaDeg(a, b) {
  let d = Math.abs(Number(a) - Number(b)) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

export function yawTowardPoint(from, to) {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

function toDataView(buffer) {
  if (!buffer) return null;
  if (buffer instanceof DataView) return buffer;
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  return new DataView(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

function rowForTick(header, tick) {
  if (!header || !Number.isFinite(tick)) return -1;
  const stride = Math.max(1, header.stride || 1);
  const row = Math.round((tick - header.firstTick) / stride);
  if (row < 0 || row >= header.tickCount) return -1;
  return row;
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

/** Does the segment from (x0,y0) to (x1,y1) pass through any smoke disc? */
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

/**
 * Is the sight line broken by the map's own painted vision blocks?
 *
 * Same category as smoke, and for the same reason: you cannot be expected to
 * hit, or to be holding an angle on, something you cannot see. The difference
 * is that smoke is temporary and comes from the round's grenades, while these
 * are permanent map geometry from the zone editor.
 *
 * Optional throughout. A map with no painted blocks, or an index built before
 * zones existed, simply behaves as it did before rather than failing.
 */
function blockedByGeometry(vision, x0, y0, x1, y1) {
  return vision ? segmentCrossesVision(vision, x0, y0, x1, y1) : false;
}

/**
 * How far along the shooter's line of fire a smoke sits, as a distance.
 *
 * Used for the "smoke before an enemy" rule: a shot is only excluded when the
 * smoke is closer than the enemy being shot at. Shooting an enemy standing in
 * front of a smoke is a normal duel and must still count.
 */
function nearestSmokeOnLine(from, yaw, smokes, maxDistance) {
  if (!smokes?.length) return Infinity;
  const rad = (yaw * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  let nearest = Infinity;
  for (const s of smokes) {
    // Project the smoke centre onto the aim ray.
    const t = (s.x - from.x) * dx + (s.y - from.y) * dy;
    if (t <= 0 || t > maxDistance) continue;
    const px = from.x + t * dx - s.x;
    const py = from.y + t * dy - s.y;
    if (px * px + py * py <= SMOKE_RADIUS * SMOKE_RADIUS && t < nearest) nearest = t;
  }
  return nearest;
}

function dist2d(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Blank per-player counters. */
function emptyPlayer() {
  return {
    // 1. crosshair placement
    engagements: 0,
    crosshairErrorSum: 0,
    // 2. unaware fights
    fightsReady: 0,
    fightsUnaware: 0,
    // 3. general accuracy, smoke shots excluded
    shots: 0,
    hits: 0,
    shotsInSmoke: 0,
    // 4. first bullet accuracy
    firstBullets: 0,
    firstBulletHits: 0
  };
}

/**
 * Compute all four aim measurements for one round.
 *
 * @param {object} meta  round meta: players, events, tickRate, sides, weapons
 * @param {ArrayBuffer|DataView|Uint8Array} tickBuffer  stride-1 ticks
 * @param {{weaponFilter?: (w: string) => boolean,
 *          visionBlockAt?: (x: number, y: number) => boolean}} [opts]
 *   `visionBlockAt` comes from getVisionLayerTests for this map. Optional: a
 *   map with no painted blocks behaves exactly as before.
 * @returns {Record<string, object>} per player id
 */
export function aimFromRound(meta, tickBuffer, opts = {}) {
  /** @type {Record<string, object>} */
  const out = {};
  if (!meta?.players?.length) return out;
  for (const p of meta.players) out[p.id] = emptyPlayer();

  const view = toDataView(tickBuffer);
  if (!view) return out;
  let header;
  try {
    header = readHeader(view);
  } catch {
    return out;
  }

  const tickRate = header.tickRate || meta.tickRate || 64;
  const players = meta.players;
  const byId = new Map(players.map((p) => [p.id, p]));
  const teamOf = new Map(players.map((p) => [p.id, p.team]));
  const grenades = meta.events?.grenades || [];
  const shots = (meta.events?.shots || []).filter(
    (s) => s.player && isAimWeapon(s.weapon) && (!opts.weaponFilter || opts.weaponFilter(bare(s.weapon)))
  );
  const damage = meta.events?.damage || [];
  const vision = typeof opts.visionBlockAt === 'function' ? opts.visionBlockAt : null;

  const a = {};
  const b = {};

  /** Live state for one player at a tick, or null when dead / missing. */
  const stateAt = (slot, tick, into) => {
    const row = rowForTick(header, tick);
    if (row < 0) return null;
    readRecord(view, row, slot, into);
    return (into.flags & FLAG_ALIVE) !== 0 && into.health > 0 ? into : null;
  };

  // ---- 3 + 4: accuracy, and the first bullet of each burst ----------------
  //
  // A hit is a damage event from the same attacker with a matching weapon
  // inside a short window. Damage is not tagged with a shot id, so proximity in
  // time is the only link available; the window is deliberately tight.
  const hitWindow = Math.max(1, Math.round(HIT_WINDOW_SECONDS * tickRate));
  const damageByAttacker = new Map();
  for (const d of damage) {
    if (!d.attacker || !isAimWeapon(d.weapon)) continue;
    if (teamOf.get(d.attacker) === teamOf.get(d.victim)) continue;
    if (!damageByAttacker.has(d.attacker)) damageByAttacker.set(d.attacker, []);
    damageByAttacker.get(d.attacker).push(d);
  }

  /** Was there a hit by `player` with `weapon` shortly after `tick`? */
  const hitAfter = (player, weapon, tick) => {
    const list = damageByAttacker.get(player);
    if (!list) return false;
    const w = bare(weapon);
    for (const d of list) {
      if (d.tick < tick) continue;
      if (d.tick > tick + hitWindow) break;
      if (bare(d.weapon) === w) return true;
    }
    return false;
  };

  // Shots are grouped into bursts per player: a new burst starts when the gap
  // since the previous shot exceeds this. The first shot of a burst is the one
  // that tests aim rather than recoil control.
  const BURST_GAP = Math.round(0.35 * tickRate);
  const lastShotTick = new Map();

  for (const shot of shots) {
    const shooter = byId.get(shot.player);
    const counters = out[shot.player];
    if (!shooter || !counters || shooter.slot == null) continue;

    const s = stateAt(shooter.slot, shot.tick, a);
    if (!s) continue;

    const sx = Number.isFinite(shot.x) && (shot.x !== 0 || shot.y !== 0) ? shot.x : s.x;
    const sy = Number.isFinite(shot.y) && (shot.x !== 0 || shot.y !== 0) ? shot.y : s.y;
    const yaw = Number.isFinite(shot.yaw) ? shot.yaw : s.yaw;
    const from = { x: sx, y: sy };

    const smokes = activeSmokeCenters(grenades, shot.tick, tickRate);

    // Nearest living enemy inside the first-bullet cone, and how far away.
    let coneEnemy = null;
    let coneEnemyDist = Infinity;
    let nearestEnemyDist = Infinity;
    for (const other of players) {
      if (other.id === shot.player || other.slot == null) continue;
      if (teamOf.get(other.id) === teamOf.get(shot.player)) continue;
      const e = stateAt(other.slot, shot.tick, b);
      if (!e) continue;
      const to = { x: e.x, y: e.y };
      const d = dist2d(from, to);
      if (d < nearestEnemyDist) nearestEnemyDist = d;
      const delta = yawDeltaDeg(yaw, yawTowardPoint(from, to));
      if (delta <= FIRST_BULLET_CONE_DEG && d < coneEnemyDist) {
        coneEnemy = { x: e.x, y: e.y, delta };
        coneEnemyDist = d;
      }
    }

    // --- vision rule ------------------------------------------------------
    // Excluded when a smoke sits on the line of fire BEFORE any enemy, or when
    // there is no enemy on the line at all and a smoke is. Spraying a smoke is
    // not an accuracy failure and must not drag the number down.
    //
    // Painted vision blocks count the same way. Shooting a wall is not a miss
    // in any sense worth measuring, and on maps with a zone network this is a
    // far bigger source of unaimed shots than smoke is.
    const smokeDist = nearestSmokeOnLine(from, yaw, smokes, MAX_ENGAGE_DISTANCE);
    const targetDist = coneEnemy ? coneEnemyDist : nearestEnemyDist;
    const behindSmoke =
      Number.isFinite(smokeDist) && (!Number.isFinite(targetDist) || smokeDist < targetDist);
    // Only meaningful when there is an enemy to be blocked from: with nobody on
    // the line, geometry says nothing the smoke test has not already said.
    const behindWall = Boolean(
      coneEnemy && blockedByGeometry(vision, from.x, from.y, coneEnemy.x, coneEnemy.y)
    );
    const intoSmoke = behindSmoke || behindWall;

    if (intoSmoke) {
      counters.shotsInSmoke += 1;
    } else {
      counters.shots += 1;
      if (hitAfter(shot.player, shot.weapon, shot.tick)) counters.hits += 1;
    }

    // --- first bullet -----------------------------------------------------
    const prev = lastShotTick.get(shot.player);
    const isFirstOfBurst = prev == null || shot.tick - prev > BURST_GAP;
    lastShotTick.set(shot.player, shot.tick);

    if (isFirstOfBurst && coneEnemy && !intoSmoke) {
      counters.firstBullets += 1;
      if (hitAfter(shot.player, shot.weapon, shot.tick)) counters.firstBulletHits += 1;
    }
  }

  // ---- 1 + 2: crosshair placement and unaware fights ----------------------
  //
  // Driven from the ENEMY's shots: every time someone shoots at you while they
  // can see you, that is a moment your crosshair either was or was not near
  // them. This is the same signal the coach uses for unaware deaths, counted
  // continuously instead of only on death.
  for (const shot of shots) {
    const attacker = byId.get(shot.player);
    if (!attacker || attacker.slot == null) continue;
    const attackerState = stateAt(attacker.slot, shot.tick - ENGAGE_LOOKBACK_TICKS, a);
    if (!attackerState) continue;
    const ax = Number.isFinite(shot.x) && (shot.x !== 0 || shot.y !== 0) ? shot.x : attackerState.x;
    const ay = Number.isFinite(shot.y) && (shot.x !== 0 || shot.y !== 0) ? shot.y : attackerState.y;
    const attackerYaw = Number.isFinite(shot.yaw) ? shot.yaw : attackerState.yaw;
    const attackerPos = { x: ax, y: ay };
    const smokes = activeSmokeCenters(grenades, shot.tick, tickRate);

    for (const victim of players) {
      if (victim.id === shot.player || victim.slot == null) continue;
      if (teamOf.get(victim.id) === teamOf.get(shot.player)) continue;
      const counters = out[victim.id];
      if (!counters) continue;

      const vs = stateAt(victim.slot, shot.tick, b);
      if (!vs) continue;
      const victimPos = { x: vs.x, y: vs.y };

      const d = dist2d(attackerPos, victimPos);
      if (d > MAX_ENGAGE_DISTANCE) continue;

      // "That enemy sees you": they are pointed at you, and neither smoke nor
      // map geometry is in the way. The geometry half matters most here. Two
      // players either side of a wall would otherwise register as an
      // engagement every time one of them fired, scoring the other as caught
      // unaware in a duel that could not happen.
      const towardVictim = yawTowardPoint(attackerPos, victimPos);
      if (yawDeltaDeg(attackerYaw, towardVictim) > ENEMY_FACING_DEG) continue;
      if (segmentThroughSmoke(ax, ay, victimPos.x, victimPos.y, smokes)) continue;
      if (blockedByGeometry(vision, ax, ay, victimPos.x, victimPos.y)) continue;

      // How far off was the victim's own crosshair from the attacker?
      const error = yawDeltaDeg(vs.yaw, yawTowardPoint(victimPos, attackerPos));
      counters.engagements += 1;
      counters.crosshairErrorSum += error;
      if (error <= FIRST_BULLET_CONE_DEG) counters.fightsReady += 1;
      else counters.fightsUnaware += 1;
    }
  }

  return out;
}

export const AIM_FIELDS = Object.freeze([
  'engagements',
  'crosshairErrorSum',
  'fightsReady',
  'fightsUnaware',
  'shots',
  'hits',
  'shotsInSmoke',
  'firstBullets',
  'firstBulletHits'
]);

export function addAim(into, from) {
  for (const key of AIM_FIELDS) into[key] = (into[key] || 0) + (from[key] || 0);
  return into;
}

// ---------------------------------------------------------------------------
// The rating
// ---------------------------------------------------------------------------

/**
 * Anchor points for each component, as [worst, best].
 *
 * A value at or beyond `best` scores 100 for that component, at or beyond
 * `worst` scores 0, and everything between is linear. Linear rather than
 * curved on purpose: the whole scale is provisional until it has been run over
 * a real corpus, and a straight line is far easier to re-anchor than a curve.
 *
 * Anchors are tuned from observed library ranges (not a theoretical CS2 ideal):
 *   crosshair ≈ 30° mean (lower better)
 *   ready     ≈ 60–70% with a tight band (a few points matter a lot)
 *   accuracy  ≈ 15–40% (wide)
 *   first bullet ≈ 15–50% (wide)
 */
export const AIM_ANCHORS = Object.freeze({
  /** Mean yaw error, degrees, when an enemy engages you. Lower is better. */
  crosshairError: { worst: 55, best: 15, invert: true },
  /**
   * Share of engagements where you were already within the cone.
   * Typical band is ~60–70%; the span is tight so a few points move the score.
   */
  readyRate: { worst: 0.55, best: 0.75, invert: false },
  /** Hits per shot, smoke shots excluded. High variance across roles/weapons. */
  accuracy: { worst: 0.12, best: 0.42, invert: false },
  /** First bullet of a burst connecting when an enemy was in the cone. */
  firstBullet: { worst: 0.12, best: 0.52, invert: false }
});

/**
 * Component weights. Ready rate is weighted highest because its real range is
 * narrow — small percentage gaps separate mediocre from elite. Accuracy and
 * first-bullet vary widely by weapon and role, so they carry less.
 */
export const AIM_WEIGHTS = Object.freeze({
  readyRate: 0.32,
  crosshairError: 0.28,
  accuracy: 0.2,
  firstBullet: 0.2
});

/** Minimum sample before a component is trusted; below this it is dropped. */
export const AIM_MIN_SAMPLE = Object.freeze({
  crosshairError: 40,
  readyRate: 40,
  accuracy: 60,
  firstBullet: 15
});

function scoreComponent(value, anchor) {
  if (!Number.isFinite(value)) return null;
  const { worst, best } = anchor;
  const t = (value - worst) / (best - worst);
  return Math.max(0, Math.min(100, t * 100));
}

/**
 * Turn accumulated counters into the four component scores and one rating.
 *
 * Components without enough sample are excluded and the remaining weights are
 * renormalised, so a player with two rounds gets a rating built from what is
 * actually known rather than a confident-looking zero.
 *
 * @returns {{rating: number|null, components: object, sample: object}}
 */
export function aimRating(totals) {
  const div = (a, b) => (b > 0 ? a / b : null);

  const raw = {
    crosshairError: div(totals.crosshairErrorSum, totals.engagements),
    readyRate: div(totals.fightsReady, totals.fightsReady + totals.fightsUnaware),
    accuracy: div(totals.hits, totals.shots),
    firstBullet: div(totals.firstBulletHits, totals.firstBullets)
  };

  const sample = {
    crosshairError: totals.engagements || 0,
    readyRate: (totals.fightsReady || 0) + (totals.fightsUnaware || 0),
    accuracy: totals.shots || 0,
    firstBullet: totals.firstBullets || 0
  };

  /** @type {Record<string, number|null>} */
  const components = {};
  let weighted = 0;
  let weightUsed = 0;

  for (const key of Object.keys(AIM_ANCHORS)) {
    const enough = sample[key] >= AIM_MIN_SAMPLE[key];
    const score = enough ? scoreComponent(raw[key], AIM_ANCHORS[key]) : null;
    components[key] = score;
    if (score != null) {
      weighted += score * AIM_WEIGHTS[key];
      weightUsed += AIM_WEIGHTS[key];
    }
  }

  return {
    rating: weightUsed > 0 ? Math.round((weighted / weightUsed) * 10) / 10 : null,
    components,
    raw,
    sample
  };
}

/**
 * Re-anchor the scale from a real population.
 *
 * Takes the per-player raw values across the library and returns anchors at the
 * 5th and 95th percentile of each, which is what makes 0-100 mean "worst to
 * best of the players we actually have" rather than a guess. Run it once there
 * are enough demos indexed, then paste the result over AIM_ANCHORS.
 *
 * @param {Array<Record<string, number|null>>} population  raw values per player
 */
export function calibrateAnchors(population) {
  const out = {};
  for (const key of Object.keys(AIM_ANCHORS)) {
    const values = population
      .map((p) => p?.[key])
      .filter((v) => Number.isFinite(v))
      .sort((x, y) => x - y);
    if (values.length < 20) {
      out[key] = { ...AIM_ANCHORS[key], note: 'too few samples, kept default' };
      continue;
    }
    const at = (q) => values[Math.floor(q * (values.length - 1))];
    const lo = at(0.05);
    const hi = at(0.95);
    out[key] = AIM_ANCHORS[key].invert ? { worst: hi, best: lo, invert: true } : { worst: lo, best: hi, invert: false };
  }
  return out;
}

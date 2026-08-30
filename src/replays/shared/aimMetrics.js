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
import {
  adjustmentsScore,
  higherIsBetter,
  lowerIsBetter,
  precisionScore,
  reactionScore,
  speedScore
} from '../../lib/aim4Ratings.js';

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
/**
 * Yaw sampled this far before a first-bullet shot is the "pre-flick" angle used
 * to decide whether a miss stopped short of the enemy (under) or past them (over).
 */
const FLICK_LOOKBACK_SECONDS = 0.2;
/** Ignore "already on them" / "landed on them" noise below this many degrees. */
const FLICK_EPSILON_DEG = 0.5;
/** Below this target error at lookback, the miss is not treated as a flick. */
const FLICK_MIN_TARGET_DEG = 1.5;

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

/** Signed yaw delta in (−180, 180]: positive means `to` is CCW from `from`. */
export function signedYawDelta(from, to) {
  let d = (Number(to) - Number(from)) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function yawTowardPoint(from, to) {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

/**
 * Classify a first-bullet miss as an underflick or overflick.
 *
 * Relative to the pre-flick yaw: under = stopped short of the enemy, over =
 * went past them. Returns null when the miss is not a directional flick miss
 * (already aimed, flicked the wrong way, or landed on the enemy within epsilon).
 *
 * @returns {'under'|'over'|null}
 */
export function classifyFlickMiss(startYaw, endYaw, targetYaw) {
  const toTarget = signedYawDelta(startYaw, targetYaw);
  if (Math.abs(toTarget) < FLICK_MIN_TARGET_DEG) return null;
  const toEnd = signedYawDelta(startYaw, endYaw);
  // Flicking away from the enemy is not over/under in the usual sense.
  if (toEnd * toTarget < 0) return null;
  const endMag = Math.abs(toEnd);
  const targetMag = Math.abs(toTarget);
  if (endMag + FLICK_EPSILON_DEG < targetMag) return 'under';
  if (endMag > targetMag + FLICK_EPSILON_DEG) return 'over';
  return null;
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
    firstBulletHits: 0,
    // 5. first-bullet miss direction (of firstBullets / engagements in cone)
    overflicks: 0,
    underflicks: 0
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
  const c = {};
  const flickLookback = Math.max(1, Math.round(FLICK_LOOKBACK_SECONDS * tickRate));

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
      const hit = hitAfter(shot.player, shot.weapon, shot.tick);
      if (hit) {
        counters.firstBulletHits += 1;
      } else {
        // Miss: was the adjustment short of the enemy, or past them?
        const start = stateAt(shooter.slot, shot.tick - flickLookback, c);
        if (start) {
          const targetYaw = yawTowardPoint(from, { x: coneEnemy.x, y: coneEnemy.y });
          const kind = classifyFlickMiss(start.yaw, yaw, targetYaw);
          if (kind === 'over') counters.overflicks += 1;
          else if (kind === 'under') counters.underflicks += 1;
        }
      }
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
  'firstBulletHits',
  'overflicks',
  'underflicks'
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
 *   over/underflick ≈ 5–28% of first-bullet cone shots (lower better)
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
  firstBullet: { worst: 0.12, best: 0.52, invert: false },
  /** Share of first-bullet cone shots that overflicked. Lower is better. */
  overflick: { worst: 0.28, best: 0.05, invert: true },
  /** Share of first-bullet cone shots that underflicked. Lower is better. */
  underflick: { worst: 0.28, best: 0.05, invert: true }
});

/**
 * Component weights. Ready rate is weighted highest because its real range is
 * narrow — small percentage gaps separate mediocre from elite. Accuracy and
 * first-bullet vary widely by weapon and role, so they carry less. Over/under
 * flick rates share a lighter slice: lower rates score higher.
 */
export const AIM_WEIGHTS = Object.freeze({
  readyRate: 0.28,
  crosshairError: 0.24,
  accuracy: 0.16,
  firstBullet: 0.16,
  overflick: 0.08,
  underflick: 0.08
});

/** Minimum sample before a component is trusted; below this it is dropped. */
export const AIM_MIN_SAMPLE = Object.freeze({
  crosshairError: 40,
  readyRate: 40,
  accuracy: 60,
  firstBullet: 15,
  /** Same denominator as the rate: first-bullet cone engagements. */
  overflick: 15,
  underflick: 15
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

  const firstBullets = totals.firstBullets || 0;
  const raw = {
    crosshairError: div(totals.crosshairErrorSum, totals.engagements),
    readyRate: div(totals.fightsReady, totals.fightsReady + totals.fightsUnaware),
    accuracy: div(totals.hits, totals.shots),
    firstBullet: div(totals.firstBulletHits, firstBullets),
    /** Share of first-bullet cone engagements that were overflick / underflick misses. */
    overflick: div(totals.overflicks || 0, firstBullets),
    underflick: div(totals.underflicks || 0, firstBullets)
  };

  const sample = {
    crosshairError: totals.engagements || 0,
    readyRate: (totals.fightsReady || 0) + (totals.fightsUnaware || 0),
    accuracy: totals.shots || 0,
    firstBullet: firstBullets,
    // Gate on first-bullet engagements (the rate denominator), not on how
    // many over/under misses happened — a tidy aimer with few flicks still
    // earns the component, and lower rates score higher.
    overflick: firstBullets,
    underflick: firstBullets
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

// ---------------------------------------------------------------------------
// The motion column
//
// aimMotion.js measures the hand; these are the counters it writes and the fold
// that rolls them up. They live here, not there, because aimMotion.js already
// depends on this file for the weapon filter and the yaw helpers, and one of
// the two modules has to be the leaf.
//
// The counters are stored PACKED — `row.a2[playerId]` is an array in exactly
// this order, not an object. Seventeen named keys per player per round is over
// two kilobytes a round of JSON that is nothing but field names; the same
// numbers as an array are a third of that. The order is therefore frozen:
// append to it, never rearrange it, or every stored index becomes a different
// statistic without anything failing.
// ---------------------------------------------------------------------------

/** @see aimMotionFromRound for what each one counts. */
export const AIM_MOTION_FIELDS = Object.freeze([
  /** Flicks that finished on the target hull (or whose bullet connected). */
  'flickHit',
  /** Flicks that finished past the target. */
  'flickOver',
  /** Flicks that stopped short of it. */
  'flickUnder',
  /** Σ per-flick closeness %, and how many flicks had a gap worth closing. */
  'closeSum',
  'closeN',
  /** Σ view travel during flicks (degrees) and Σ time spent flicking (ms). */
  'pathDeg',
  'flickMs',
  /** Σ direct angular distance for the same flicks — the tension denominator. */
  'directDeg',
  /** How many flicks fed the three totals above. Speed and tension gate on it. */
  'speedN',
  /** Motion segments spent on targets, and targets actually killed. */
  'segments',
  'targets',
  /** Σ visible→moving delay (ms) and its sample count. */
  'reactDirMs',
  'reactDirN',
  /** Σ on-target→click delay (ms) and its sample count. */
  'reactHoldMs',
  'reactHoldN',
  /** Engagement ticks with the crosshair on the hull, and total. */
  'trackOn',
  'trackN'
]);

export const AIM_MOTION_WIDTH = AIM_MOTION_FIELDS.length;

/** Blank counter vector. */
export function emptyMotion() {
  return new Array(AIM_MOTION_WIDTH).fill(0);
}

/** Fold `from` into `into`, both packed vectors. Tolerates a missing `into`. */
export function addMotion(into, from) {
  if (!Array.isArray(from)) return into;
  const out = Array.isArray(into) && into.length === AIM_MOTION_WIDTH ? into : emptyMotion();
  for (let i = 0; i < AIM_MOTION_WIDTH; i++) out[i] += Number(from[i]) || 0;
  return out;
}

/** Packed vector → named object, for readers that want names. */
export function motionObject(vec) {
  const out = {};
  for (let i = 0; i < AIM_MOTION_WIDTH; i++) {
    out[AIM_MOTION_FIELDS[i]] = Array.isArray(vec) ? Number(vec[i]) || 0 : 0;
  }
  return out;
}

/** Is there anything in this vector worth reading? */
export function motionHasSample(vec) {
  if (!Array.isArray(vec)) return false;
  for (let i = 0; i < vec.length; i++) if (vec[i]) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Aim rating v2
//
// The rating above measures OUTCOMES: was the crosshair near the enemy, did
// the bullet land. aimMotion.js measures the hand that produced them, in the
// same seven categories the aim trainer scores a run on. v2 is both halves —
// what happened, and the motion behind it — because either alone is half an
// answer. A player who wins fights with lazy placement and a player who loses
// them with a beautiful flick both come out of a one-sided rating wrong.
//
// The trainer's own engines do the per-axis scoring (lib/aim4Ratings.js), so a
// change to the shape of the Speed or Reaction curve moves the trainer and the
// demo page together instead of leaving two versions of the same idea. What is
// local to this file is the BASELINES: 39°/s of flick speed means something in
// Gridshot and nothing in a demo, so every baseline is re-anchored to CS2.
// ---------------------------------------------------------------------------

/**
 * B = a 1.00 engine rating, per axis, on CS2 demo data.
 *
 * PROVISIONAL until run over the library: these are plausible mid-table values,
 * not measured ones. `calibrateMotionBaselines` below turns a population of raw
 * values into the real thing — run it once the rescan has covered the library
 * and paste the result over this.
 */
export const AIM_V2_BASELINES = Object.freeze({
  /** Degrees of view travel per second while flicking. */
  speed: 250,
  /** Share of the engagement with the crosshair on the hull. */
  tracking: 0.35,
  /**
   * Share of flicks that finished on the target.
   *
   * Higher than the first-bullet HIT rate it looks like, and not the same
   * statistic: a flick counts as landed when the crosshair finished on the
   * hull, whether or not spread and recoil put the bullet there.
   */
  flicks_hit_percent: 55,
  /** Motion segments per target killed. 1.0 is one clean flick per kill. */
  adjustments: 2.2,
  /** Visible→moving and on-target→click, blended 50/50, in ms. */
  reaction_time_ms: 250,
  /** Path length over the direct angular distance, as a % excess. */
  tension_percent: 45
});

/**
 * Closeness that scores 1.00 for a demo flick.
 *
 * Much higher than the trainer's 62.5: a trainer target is a small sphere and
 * closing 62% of the gap to it is respectable, while a demo flick ends on a
 * player-sized hull and a competent one closes most of the way there. Scoring
 * demo flicks on the trainer's pivot would put the whole library at the top of
 * the curve, which is a scale that has stopped distinguishing anybody.
 */
export const AIM_V2_PRECISION_PIVOT = 88;

/**
 * Where an engine score (0.00–2.00) lands on the 0–100 aim scale.
 *
 * Chosen so a baseline 1.00 scores 63, which is where the outcome half already
 * puts a typical player (see AIM_ANCHORS). That is not cosmetic: the Aim column
 * feeds the A4R composite against a fixed 0.631 constant, so a motion half
 * centred anywhere else would move every rating in the library the day v2
 * shipped, and the move would be an artefact of the scale rather than anything
 * anybody's aim did.
 */
export const AIM_V2_ENGINE_ANCHOR = Object.freeze({ worst: 0.4, best: 1.35 });

/** Weight of each v2 component. Outcome half and motion half, 50/50. */
export const AIM_V2_WEIGHTS = Object.freeze({
  // Outcome — AIM_WEIGHTS, halved, so their proportions to each other survive.
  readyRate: 0.14,
  crosshairError: 0.12,
  accuracy: 0.08,
  firstBullet: 0.08,
  overflick: 0.04,
  underflick: 0.04,
  // Motion. Precision and Flicks lead: they are the two that say whether the
  // hand arrived, and everything else describes how it got there.
  precision: 0.1,
  flicks: 0.1,
  tracking: 0.08,
  adjustments: 0.08,
  reaction: 0.06,
  speed: 0.04,
  tension: 0.04
});

/** Minimum sample per motion component. Below it the component is dropped. */
export const AIM_V2_MIN_SAMPLE = Object.freeze({
  precision: 25,
  speed: 25,
  flicks: 25,
  adjustments: 10,
  reaction: 15,
  tension: 25,
  tracking: 200
});

/** The seven motion axes, in display order, with their labels. */
export const AIM_V2_MOTION_KEYS = Object.freeze([
  { key: 'precision', label: 'Precision' },
  { key: 'speed', label: 'Speed' },
  { key: 'flicks', label: 'Flicks' },
  { key: 'adjustments', label: 'Adjustments' },
  { key: 'reaction', label: 'Reaction' },
  { key: 'tension', label: 'Tension' },
  { key: 'tracking', label: 'Tracking' }
]);

/**
 * Packed motion counters → the seven raw trainer statistics.
 *
 * Every value is null when its denominator is empty, never 0: "no flick was
 * ever measured" and "every flick missed" are different claims and only one of
 * them is safe to score.
 *
 * @param {number[]|object} totals packed vector, or an already-named object
 */
export function aimTelemetry(totals) {
  const m = Array.isArray(totals) ? motionObject(totals) : { ...(totals || {}) };
  for (const key of AIM_MOTION_FIELDS) m[key] = Number(m[key]) || 0;

  const flicks = m.flickHit + m.flickOver + m.flickUnder;
  const reactN = m.reactDirN + m.reactHoldN;
  const div = (a, b) => (b > 0 ? a / b : null);

  const raw = {
    /** Mean % of the start→target gap one flick closed. */
    precision: div(m.closeSum, m.closeN),
    /** Degrees of view travel per second while flicking. */
    speed: m.flickMs > 0 ? (m.pathDeg / m.flickMs) * 1000 : null,
    /** Share of flicks that finished on the target, as a percent. */
    flicks: flicks > 0 ? (m.flickHit / flicks) * 100 : null,
    /** Motion segments per target killed. */
    adjustments: div(m.segments, m.targets),
    /**
     * Blended reaction, in ms. 50/50 when both halves have samples, matching
     * the trainer; whichever half exists alone carries it otherwise.
     */
    reaction:
      reactN > 0
        ? m.reactDirN > 0 && m.reactHoldN > 0
          ? (m.reactDirMs / m.reactDirN) * 0.5 + (m.reactHoldMs / m.reactHoldN) * 0.5
          : (m.reactDirMs + m.reactHoldMs) / reactN
        : null,
    /** Path length over the direct distance, as a % excess. */
    tension: m.directDeg > 0 ? Math.max(0, (m.pathDeg / m.directDeg - 1) * 100) : null,
    /** Share of engagement ticks with the crosshair on the hull. */
    tracking: div(m.trackOn, m.trackN)
  };

  const sample = {
    precision: m.closeN,
    speed: m.speedN,
    flicks,
    // Both halves of the ratio have to be there for it to be a ratio.
    adjustments: Math.min(m.targets, m.segments),
    reaction: reactN,
    tension: m.speedN,
    tracking: m.trackN
  };

  return { raw, sample, totals: m, flicks };
}

/** Raw motion statistics → the trainer engine's 0.00–2.00 score, per axis. */
export function motionEngineScores(raw, baselines = AIM_V2_BASELINES) {
  const B = { ...AIM_V2_BASELINES, ...(baselines || {}) };
  const at = (v, fn) => (Number.isFinite(v) ? fn(v) : null);
  return {
    precision: at(raw.precision, (v) => precisionScore(v, AIM_V2_PRECISION_PIVOT)),
    speed: at(raw.speed, (v) => speedScore(v, B.speed)),
    flicks: at(raw.flicks, (v) => higherIsBetter(v, B.flicks_hit_percent)),
    adjustments: at(raw.adjustments, (v) => adjustmentsScore(v, B.adjustments)),
    reaction: at(raw.reaction, (v) => reactionScore(v, B.reaction_time_ms)),
    tension: at(raw.tension, (v) => lowerIsBetter(v, B.tension_percent)),
    tracking: at(raw.tracking, (v) => higherIsBetter(v, B.tracking))
  };
}

/** Engine score (0–2) onto the 0–100 aim scale. */
export function engineToHundred(score) {
  if (!Number.isFinite(score)) return null;
  const { worst, best } = AIM_V2_ENGINE_ANCHOR;
  return Math.max(0, Math.min(100, ((score - worst) / (best - worst)) * 100));
}

/**
 * The Aim rating, v2: outcome components and motion components in one score.
 *
 * Degrades in one direction only. A player whose demos have not been scanned
 * for motion yet has no motion components at all, every motion weight drops
 * out, and the renormalised result is exactly the v1 rating — the number the
 * library already shows. So the rescan can run for hours across a live library
 * without any page showing a rating that is neither one thing nor the other.
 *
 * @param {object} totals   summed AIM_FIELDS counters
 * @param {number[]|object|null} motion  summed AIM_MOTION_FIELDS vector
 * @param {{ baselines?: object }} [opts]
 */
export function aimRatingV2(totals, motion = null, opts = {}) {
  const base = aimRating(totals || {});
  const tele = aimTelemetry(motion || []);
  const engines = motionEngineScores(tele.raw, opts.baselines);

  /** @type {Record<string, number|null>} */
  const components = {};
  let weighted = 0;
  let weightUsed = 0;
  const add = (key, score) => {
    components[key] = score;
    if (score == null) return;
    weighted += score * AIM_V2_WEIGHTS[key];
    weightUsed += AIM_V2_WEIGHTS[key];
  };

  for (const key of Object.keys(AIM_ANCHORS)) add(key, base.components[key]);
  for (const { key } of AIM_V2_MOTION_KEYS) {
    const enough = (tele.sample[key] || 0) >= AIM_V2_MIN_SAMPLE[key];
    add(key, enough ? engineToHundred(engines[key]) : null);
  }

  const hasMotion = AIM_V2_MOTION_KEYS.some(({ key }) => components[key] != null);
  return {
    rating: weightUsed > 0 ? Math.round((weighted / weightUsed) * 10) / 10 : null,
    /** The outcome-only rating, kept so the page can show what v2 changed. */
    v1: base.rating,
    hasMotion,
    components,
    raw: { ...base.raw, ...tele.raw },
    sample: { ...base.sample, ...tele.sample },
    engines,
    motion: tele.totals
  };
}

/**
 * Re-anchor the motion baselines from a real population, the same way
 * `calibrateAnchors` re-anchors the outcome half.
 *
 * A baseline is the MEDIAN raw value, not a percentile edge: the engines are
 * curves around B = 1.00, so B has to be the middle of the population for the
 * curve either side of it to mean anything.
 *
 * @param {Array<Record<string, number|null>>} population raw values per player
 */
export function calibrateMotionBaselines(population) {
  const median = (key) => {
    const values = (population || [])
      .map((p) => p?.[key])
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    if (values.length < 20) return null;
    return values[Math.floor(values.length / 2)];
  };
  const out = { ...AIM_V2_BASELINES };
  const map = {
    speed: 'speed',
    tracking: 'tracking',
    flicks_hit_percent: 'flicks',
    adjustments: 'adjustments',
    reaction_time_ms: 'reaction',
    tension_percent: 'tension'
  };
  for (const [baselineKey, rawKey] of Object.entries(map)) {
    const m = median(rawKey);
    if (m != null && m > 0) out[baselineKey] = Math.round(m * 1000) / 1000;
  }
  return out;
}

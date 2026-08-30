// ---------------------------------------------------------------------------
// replays/shared/aimMotion.js
// The aim TRAINER's seven measurements, taken off a CS2 demo.
//
// aimMetrics.js answers "was the crosshair where it needed to be, and did the
// bullet land". That is an outcome. The trainer measures the MOTION that
// produced the outcome — how fast the hand moved, how much of the gap one
// motion closed, how straight the path was, how long the crosshair sat on the
// target before the click. Those are the numbers a player can actually train,
// and they are all recoverable from the same two files the aim pass already
// reads:
//
//   tick buffer   x/y/z, yaw, pitch, duck amount, health, flags, per tick
//   shot events   tick, player, weapon, x/y/z, yaw, pitch
//   damage/kills  who connected with what, and when
//
// The seven trainer categories and their demo equivalents:
//
//   Precision    per-flick closeness: how much of the start→target angular gap
//                the motion closed, in percent
//   Speed        degrees of view travel per second WHILE flicking
//   Flicks       share of flicks that finished on the target
//   Adjustments  motion segments per target killed
//   Reaction     target becomes visible → hand starts moving, blended 50/50
//                with crosshair-lands-on-target → click
//   Tension      path length over the direct angular distance, as a % excess
//   Tracking     share of the engagement's ticks with the crosshair on the hull
//
// Everything here is a SUM plus its denominator, never a ratio: the totals are
// folded across rounds, matches and careers before anything is divided, so a
// filtered view averages over exactly the rounds it kept.
//
// The unit of measurement is a BURST — the trainer's "flick" is a hand motion
// that ends in a click, and a burst's first bullet is the demo's version of
// that. Bursts without an identifiable target are dropped rather than guessed
// at: spraying a doorway is not a flick and must not score as a bad one.
// ---------------------------------------------------------------------------

import { EYE_DUCK, EYE_STAND } from '../../../shared/sim3d/constants.js';
import { FLAG_ALIVE, FLAG_DUCKING, readHeader, readRecord } from './tickFormat.js';
import {
  AIM_MOTION_FIELDS,
  AIM_MOTION_WIDTH,
  emptyMotion,
  isAimWeapon,
  signedYawDelta
} from './aimMetrics.js';
import { segmentCrossesVision } from '../zones/visionLayers.js';

/** Field name → slot in the packed vector. The pass writes by slot. */
const F = Object.freeze(Object.fromEntries(AIM_MOTION_FIELDS.map((k, i) => [k, i])));

/**
 * What a stored `row.a2` was measured by. Stamped on the stats entry as `a2v`.
 *
 * Deliberately NOT part of STATS_VERSION, and deliberately not checked by
 * `needsPhaseEnrichment`: a bump here must never make a page view rewalk the
 * library's tick buffers. The admin "Rescan aim rating" pass is what acts on
 * it, in the background, one demo at a time. Bump it whenever a constant above
 * or the shape of a counter changes, so the rescan knows what is already
 * current and what has to be measured again.
 */
export const AIM_MOTION_VERSION = 1;

// ---- tuning ---------------------------------------------------------------

/** A new burst starts when this long has passed since the previous shot. */
const BURST_GAP_SECONDS = 0.35;
/** How far back a flick may be traced from the shot that ended it. */
const MAX_FLICK_SECONDS = 0.8;
/** Per-tick view travel below this counts as a still crosshair. */
const STILL_DEG_PER_TICK = 0.35;
/** Consecutive still ticks that end a motion segment. */
const STILL_RUN = 3;
/** Below this starting error the motion is a micro-correction, not a flick. */
const MIN_START_ERR_DEG = 2;
/** Below this much travel there was no flick to time. */
const MIN_PATH_DEG = 2;
/** A hit may land this long after the shot and still belong to it. */
const HIT_WINDOW_SECONDS = 0.2;
/** How far back the "when did this enemy become visible" search runs. */
const ACQUIRE_SECONDS = 1;
/** Ticks between samples in that search — LOS tests are the expensive part. */
const ACQUIRE_STEP = 2;
/** Roughly "on screen": an enemy outside this was never there to react to. */
const ACQUIRE_CONE_DEG = 90;
/**
 * How far off the shot an enemy may be and still be what the burst was aimed at.
 *
 * Wider than aimMetrics' 25° first-bullet cone, because a flick that missed
 * badly is precisely what this is here to measure and a 25° gate would drop
 * every one of them, flattering the numbers. Narrower than "on screen",
 * because spraying a corridor with somebody standing 80° off to the side is
 * not a flick at that somebody, and scoring it as one would put a 0% closeness
 * and an underflick on every held angle in the demo.
 *
 * Bullets that actually connected bypass this entirely: a hit is proof of who
 * the burst was for, whatever angle the first shot left at.
 */
const FLICK_TARGET_CONE_DEG = 45;
/** Longest credible reaction. Anything slower was not a reaction. */
const MAX_REACTION_MS = 1000;
/** Longest pre-click hold worth recording — beyond this it is holding an angle. */
const MAX_HOLD_MS = 800;
/** Engagements shorter than this are a single click, not tracking. */
const MIN_TRACK_TICKS = 4;
/** Tracking follows the burst this far past its last shot. */
const TRACK_TAIL_SECONDS = 0.3;
/** Past this the geometry tests stop meaning anything. */
const MAX_ENGAGE_DISTANCE = 3000;
/** Smoke geometry, matching aimMetrics.js and the viewer. */
const SMOKE_SECONDS = 22;
const SMOKE_RADIUS = 144;

/** Player hull: half width, and the height of the chest above the feet. */
const HULL_HALF_WIDTH = 16;
const CHEST_RATIO = 0.7;
/** Vertical half-extent of the hull used for the "on target" test. */
const HULL_HALF_HEIGHT = 30;

const DEG = 180 / Math.PI;

// ---- geometry -------------------------------------------------------------

function duckOf(state) {
  if (!state) return 0;
  if (state.duckAmount > 0) return Math.min(1, state.duckAmount);
  return (state.flags & FLAG_DUCKING) !== 0 ? 1 : 0;
}

function eyeHeight(state) {
  return EYE_STAND + (EYE_DUCK - EYE_STAND) * duckOf(state);
}

/**
 * Where the view has to point to be on an enemy, and how much slack there is.
 *
 * `err` is the combined angular miss in degrees — yaw and pitch treated as a
 * flat plane, which is what a mouse actually moves through and what the
 * trainer's own numbers are measured in. `onTarget` uses the hull's real
 * angular size at this distance instead of a fixed cone, so a body across the
 * map is not scored as generously as one at arm's length.
 */
function aimError(from, fromEyeZ, target) {
  const tz = target.z + eyeHeight(target) * CHEST_RATIO;
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const dz = tz - fromEyeZ;
  const flat = Math.hypot(dx, dy);
  const dist = Math.hypot(flat, dz) || 1e-6;
  const targetYaw = Math.atan2(dy, dx) * DEG;
  // Source pitch grows downward (bulletDirection uses fz = −sin(pitch)).
  const targetPitch = -Math.atan2(dz, flat || 1e-6) * DEG;
  const yawErr = signedYawDelta(targetYaw, from.yaw);
  const pitchErr = from.pitch - targetPitch;
  const radiusYaw = Math.atan2(HULL_HALF_WIDTH, Math.max(1, flat)) * DEG;
  const radiusPitch = Math.atan2(HULL_HALF_HEIGHT, Math.max(1, dist)) * DEG;
  return {
    err: Math.hypot(yawErr, pitchErr),
    yawErr,
    targetYaw,
    targetPitch,
    dist: flat,
    onTarget: Math.abs(yawErr) <= radiusYaw && Math.abs(pitchErr) <= radiusPitch
  };
}

/** View travel between two look angles, in degrees of mouse movement. */
function viewTravel(yaw0, pitch0, yaw1, pitch1) {
  return Math.hypot(signedYawDelta(yaw0, yaw1), pitch1 - pitch0);
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

function segmentThroughSmoke(x0, y0, x1, y1, smokes) {
  if (!smokes?.length) return false;
  const r2 = SMOKE_RADIUS * SMOKE_RADIUS;
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

// ---- the pass -------------------------------------------------------------

/**
 * Trainer-style motion telemetry for one round, per player.
 *
 * Same inputs as `aimFromRound`, so the two run off one read of the round and
 * one read of its ticks. Returns packed vectors keyed by player id; a player
 * with nothing measurable gets an all-zero vector, which reads downstream as
 * "no sample" rather than "scored zero".
 *
 * @param {object} meta round meta: players, events, tickRate
 * @param {ArrayBuffer|DataView|Uint8Array} tickBuffer stride-1 ticks
 * @param {{ visionBlockAt?: (x:number,y:number)=>boolean }} [opts]
 *   The same point test `aimFromRound` takes, from getVisionLayerTests.
 * @returns {Record<string, number[]>}
 */
export function aimMotionFromRound(meta, tickBuffer, opts = {}) {
  /** @type {Record<string, number[]>} */
  const out = {};
  if (!meta?.players?.length || !tickBuffer) return out;

  const view =
    tickBuffer instanceof DataView
      ? tickBuffer
      : tickBuffer instanceof ArrayBuffer
        ? new DataView(tickBuffer)
        : new DataView(
            tickBuffer.buffer.slice(
              tickBuffer.byteOffset,
              tickBuffer.byteOffset + tickBuffer.byteLength
            )
          );

  let header;
  try {
    header = readHeader(view);
  } catch {
    return out;
  }
  // Motion is the whole point: a strided buffer has already thrown the hand
  // movement away, and measuring speed off it would invent a number.
  if ((header.stride || 1) !== 1) return out;

  for (const p of meta.players) out[p.id] = emptyMotion();

  const tickRate = header.tickRate || meta.tickRate || 64;
  const players = meta.players.filter((p) => p.slot != null);
  const teamOf = new Map(meta.players.map((p) => [p.id, p.team]));
  const grenades = meta.events?.grenades || [];
  const vision = typeof opts.visionBlockAt === 'function' ? opts.visionBlockAt : null;
  /** Painted map geometry between two players. No zone network = never blocked. */
  const blocked = (x0, y0, x1, y1) =>
    vision ? segmentCrossesVision(vision, x0, y0, x1, y1) : false;

  const burstGap = Math.max(1, Math.round(BURST_GAP_SECONDS * tickRate));
  const maxFlick = Math.max(2, Math.round(MAX_FLICK_SECONDS * tickRate));
  const hitWindow = Math.max(1, Math.round(HIT_WINDOW_SECONDS * tickRate));
  const acquireBack = Math.max(2, Math.round(ACQUIRE_SECONDS * tickRate));
  const trackTail = Math.max(1, Math.round(TRACK_TAIL_SECONDS * tickRate));
  const msPerTick = 1000 / tickRate;

  const firstTick = header.firstTick;
  const lastTick = header.firstTick + header.tickCount - 1;
  const rowForTick = (tick) => {
    const row = tick - firstTick;
    return row >= 0 && row < header.tickCount ? row : -1;
  };

  const scratchA = {};
  const scratchB = {};
  const scratchC = {};

  /** Live state at a tick, or null when dead / off the end of the buffer. */
  const stateAt = (slot, tick, into) => {
    const row = rowForTick(tick);
    if (row < 0) return null;
    readRecord(view, row, slot, into);
    return (into.flags & FLAG_ALIVE) !== 0 && into.health > 0 ? into : null;
  };

  // ---- events, indexed once ------------------------------------------------

  const shotsByPlayer = new Map();
  for (const shot of meta.events?.shots || []) {
    if (!shot.player || !isAimWeapon(shot.weapon)) continue;
    if (!Number.isFinite(shot.tick)) continue;
    if (shot.tick < firstTick || shot.tick > lastTick) continue;
    let list = shotsByPlayer.get(shot.player);
    if (!list) shotsByPlayer.set(shot.player, (list = []));
    list.push(shot);
  }
  for (const list of shotsByPlayer.values()) list.sort((a, b) => a.tick - b.tick);

  /** attacker → victim → sorted hit ticks. Damage carries no shot id. */
  const hitsByPair = new Map();
  for (const d of meta.events?.damage || []) {
    if (!d.attacker || !d.victim || !isAimWeapon(d.weapon)) continue;
    if (teamOf.get(d.attacker) === teamOf.get(d.victim)) continue;
    let byVictim = hitsByPair.get(d.attacker);
    if (!byVictim) hitsByPair.set(d.attacker, (byVictim = new Map()));
    let ticks = byVictim.get(d.victim);
    if (!ticks) byVictim.set(d.victim, (ticks = []));
    ticks.push(Number(d.tick) || 0);
  }
  for (const byVictim of hitsByPair.values()) {
    for (const ticks of byVictim.values()) ticks.sort((a, b) => a - b);
  }

  const connected = (attacker, victim, from, to) => {
    const ticks = hitsByPair.get(attacker)?.get(victim);
    if (!ticks) return false;
    for (const t of ticks) {
      if (t < from) continue;
      if (t > to) return false;
      return true;
    }
    return false;
  };

  /** Gun kills per player: the denominator of Adjustments. */
  for (const k of meta.events?.kills || []) {
    if (!k.attacker || !isAimWeapon(k.weapon)) continue;
    if (teamOf.get(k.attacker) === teamOf.get(k.victim)) continue;
    const vec = out[k.attacker];
    if (vec) vec[F.targets] += 1;
  }

  // ---- per player, per burst ----------------------------------------------

  for (const shooter of players) {
    const vec = out[shooter.id];
    const shots = shotsByPlayer.get(shooter.id);
    if (!vec || !shots?.length) continue;
    const team = teamOf.get(shooter.id);
    const enemies = players.filter((p) => teamOf.get(p.id) !== team);
    if (!enemies.length) continue;

    // Split this player's shots into bursts.
    /** @type {Array<{ first: number, last: number }>} */
    const bursts = [];
    let open = null;
    for (const shot of shots) {
      if (!open || shot.tick - open.last > burstGap) {
        open = { first: shot.tick, last: shot.tick };
        bursts.push(open);
      } else {
        open.last = shot.tick;
      }
    }

    for (const burst of bursts) {
      const t1 = burst.first;
      const me = stateAt(shooter.slot, t1, scratchA);
      if (!me) continue;
      const myEye = me.z + eyeHeight(me);
      const meAt1 = { x: me.x, y: me.y, yaw: me.yaw, pitch: me.pitch };
      const smokes = activeSmokeCenters(grenades, t1, tickRate);

      // --- who was this burst aimed at? -----------------------------------
      //
      // A bullet that connected is proof; the nearest enemy the crosshair was
      // near is the fallback. Anything else — an empty angle, a wall, a smoke
      // — is not a flick and is dropped, because scoring it would make holding
      // an angle look like a missed one.
      let target = null;
      let targetErr = null;
      const byVictim = hitsByPair.get(shooter.id);
      if (byVictim) {
        for (const enemy of enemies) {
          if (!connected(shooter.id, enemy.id, t1, burst.last + hitWindow)) continue;
          const st = stateAt(enemy.slot, t1, scratchB);
          if (!st) continue;
          const e = aimError(meAt1, myEye, st);
          if (!target || e.err < targetErr.err) {
            target = enemy;
            targetErr = e;
          }
        }
      }
      if (!target) {
        for (const enemy of enemies) {
          const st = stateAt(enemy.slot, t1, scratchB);
          if (!st) continue;
          const e = aimError(meAt1, myEye, st);
          if (e.dist > MAX_ENGAGE_DISTANCE) continue;
          if (Math.abs(e.yawErr) > FLICK_TARGET_CONE_DEG) continue;
          if (segmentThroughSmoke(me.x, me.y, st.x, st.y, smokes)) continue;
          if (blocked(me.x, me.y, st.x, st.y)) continue;
          if (!target || e.err < targetErr.err) {
            target = enemy;
            targetErr = e;
          }
        }
      }
      if (!target) continue;

      // --- where did the motion start? ------------------------------------
      //
      // Walk back until the crosshair has been still for STILL_RUN ticks. That
      // resting point is where the hand began, and everything between it and
      // the shot is one flick.
      let t0 = t1;
      let still = 0;
      let prevYaw = me.yaw;
      let prevPitch = me.pitch;
      const floor = Math.max(firstTick, t1 - maxFlick);
      for (let t = t1 - 1; t >= floor; t--) {
        const st = stateAt(shooter.slot, t, scratchB);
        if (!st) break;
        const step = viewTravel(st.yaw, st.pitch, prevYaw, prevPitch);
        prevYaw = st.yaw;
        prevPitch = st.pitch;
        if (step < STILL_DEG_PER_TICK) {
          still += 1;
          if (still >= STILL_RUN) break;
        } else {
          still = 0;
          t0 = t;
        }
      }

      const startState = stateAt(shooter.slot, t0, scratchB);
      if (!startState) continue;
      const startEye = startState.z + eyeHeight(startState);
      const startPos = {
        x: startState.x,
        y: startState.y,
        yaw: startState.yaw,
        pitch: startState.pitch
      };
      const targetAt0 = stateAt(target.slot, t0, scratchC);
      const startErr = targetAt0 ? aimError(startPos, startEye, targetAt0) : null;

      // --- travel, time, and how straight the path was ---------------------
      let path = 0;
      // From startPos, not startState: startState is the shared scratch record
      // and the loop below is about to overwrite it.
      let lastYaw = startPos.yaw;
      let lastPitch = startPos.pitch;
      for (let t = t0 + 1; t <= t1; t++) {
        const st = stateAt(shooter.slot, t, scratchB);
        if (!st) break;
        path += viewTravel(lastYaw, lastPitch, st.yaw, st.pitch);
        lastYaw = st.yaw;
        lastPitch = st.pitch;
      }
      const flickMs = (t1 - t0) * msPerTick;
      const direct = startErr ? startErr.err : 0;

      // Speed and tension share one denominator on purpose: tension is the
      // excess of `path` over `direct`, so a flick counted into the travel
      // total but not into the direct total would read as pure overshoot. A
      // flick that started on the target has no shortest route to compare
      // against, so it is left out of both rather than half of each.
      if (path >= MIN_PATH_DEG && flickMs > 0 && direct >= MIN_START_ERR_DEG) {
        vec[F.pathDeg] += path;
        vec[F.flickMs] += flickMs;
        vec[F.directDeg] += direct;
        vec[F.speedN] += 1;
      }

      // --- precision: how much of the gap did the motion close? ------------
      const endErr = targetErr.err;
      if (startErr && startErr.err >= MIN_START_ERR_DEG) {
        const closed = ((startErr.err - endErr) / startErr.err) * 100;
        vec[F.closeSum] += Math.max(0, Math.min(100, closed));
        vec[F.closeN] += 1;
      }

      // --- flick outcome ----------------------------------------------------
      const landed =
        targetErr.onTarget || connected(shooter.id, target.id, t1, t1 + hitWindow);
      if (landed) {
        vec[F.flickHit] += 1;
      } else if (startErr) {
        // Over or under is relative to where the hand started: past the enemy,
        // or short of them. With no travel to speak of the crosshair never
        // reached the target, which is "under" by definition.
        const toTarget = signedYawDelta(startPos.yaw, startErr.targetYaw);
        const toEnd = signedYawDelta(startPos.yaw, meAt1.yaw);
        const overshot =
          toEnd * toTarget > 0 && Math.abs(toEnd) > Math.abs(toTarget);
        if (overshot) vec[F.flickOver] += 1;
        else vec[F.flickUnder] += 1;
      } else {
        vec[F.flickUnder] += 1;
      }

      // --- adjustments: motion segments inside the engagement --------------
      //
      // One clean flick onto a body is one segment. A flick that lands short
      // and gets corrected twice is three, and that ratio against targets
      // killed is exactly the trainer's "flicks per target hit".
      let segments = 0;
      let moving = false;
      still = 0;
      lastYaw = startPos.yaw;
      lastPitch = startPos.pitch;
      for (let t = t0 + 1; t <= burst.last; t++) {
        const st = stateAt(shooter.slot, t, scratchB);
        if (!st) break;
        const step = viewTravel(lastYaw, lastPitch, st.yaw, st.pitch);
        lastYaw = st.yaw;
        lastPitch = st.pitch;
        if (step >= STILL_DEG_PER_TICK) {
          if (!moving) {
            moving = true;
            segments += 1;
          }
          still = 0;
        } else if (moving) {
          still += 1;
          if (still >= STILL_RUN) moving = false;
        }
      }
      vec[F.segments] += Math.max(1, segments);

      // --- reaction, half one: enemy visible → hand starts moving -----------
      //
      // Only counted when the enemy actually APPEARED inside the window. An
      // enemy who was already visible when the window opened has no moment to
      // react to, and timing from an arbitrary point would score patience as
      // a slow reaction.
      let appearedAt = null;
      let visibleThroughout = true;
      for (let t = t0; t >= Math.max(firstTick, t0 - acquireBack); t -= ACQUIRE_STEP) {
        const mine = stateAt(shooter.slot, t, scratchB);
        const theirs = mine ? stateAt(target.slot, t, scratchC) : null;
        let visible = false;
        if (mine && theirs) {
          const eye = mine.z + eyeHeight(mine);
          const e = aimError(
            { x: mine.x, y: mine.y, yaw: mine.yaw, pitch: mine.pitch },
            eye,
            theirs
          );
          // The burst's own smoke set stands in for the window's: a smoke
          // lasts 22 seconds and this window is one, so recomputing it per
          // sampled tick would allocate a list to get the same answer.
          visible =
            e.dist <= MAX_ENGAGE_DISTANCE &&
            Math.abs(e.yawErr) <= ACQUIRE_CONE_DEG &&
            !segmentThroughSmoke(mine.x, mine.y, theirs.x, theirs.y, smokes) &&
            !blocked(mine.x, mine.y, theirs.x, theirs.y);
        }
        if (!visible) {
          visibleThroughout = false;
          break;
        }
        appearedAt = t;
      }
      if (appearedAt != null && !visibleThroughout) {
        const ms = (t0 - appearedAt) * msPerTick;
        if (ms > 0 && ms <= MAX_REACTION_MS) {
          vec[F.reactDirMs] += ms;
          vec[F.reactDirN] += 1;
        }
      }

      // --- reaction, half two: crosshair lands → click ----------------------
      if (targetErr.onTarget) {
        let held = 0;
        for (let t = t1 - 1; t >= Math.max(firstTick, t1 - maxFlick); t--) {
          const mine = stateAt(shooter.slot, t, scratchB);
          const theirs = mine ? stateAt(target.slot, t, scratchC) : null;
          if (!mine || !theirs) break;
          const eye = mine.z + eyeHeight(mine);
          const e = aimError(
            { x: mine.x, y: mine.y, yaw: mine.yaw, pitch: mine.pitch },
            eye,
            theirs
          );
          if (!e.onTarget) break;
          held += 1;
        }
        const ms = held * msPerTick;
        if (ms > 0 && ms <= MAX_HOLD_MS) {
          vec[F.reactHoldMs] += ms;
          vec[F.reactHoldN] += 1;
        }
      }

      // --- tracking: the crosshair over the whole engagement ----------------
      const trackTo = Math.min(lastTick, burst.last + trackTail);
      let on = 0;
      let seen = 0;
      for (let t = t1; t <= trackTo; t++) {
        const mine = stateAt(shooter.slot, t, scratchB);
        if (!mine) break;
        const theirs = stateAt(target.slot, t, scratchC);
        if (!theirs) break;
        const eye = mine.z + eyeHeight(mine);
        const e = aimError(
          { x: mine.x, y: mine.y, yaw: mine.yaw, pitch: mine.pitch },
          eye,
          theirs
        );
        seen += 1;
        if (e.onTarget) on += 1;
      }
      if (seen >= MIN_TRACK_TICKS) {
        vec[F.trackOn] += on;
        vec[F.trackN] += seen;
      }
    }
  }

  // Sums of floats, stored as JSON on every round of every demo. Two decimals
  // is finer than any of these statistics can claim to be and roughly halves
  // what the column weighs.
  for (const id of Object.keys(out)) {
    const vec = out[id];
    for (let i = 0; i < vec.length; i++) vec[i] = Math.round(vec[i] * 100) / 100;
  }
  return out;
}

// ---------------------------------------------------------------------------
// lib/replayAnalytics.js — replay aim-analysis engine
// ---------------------------------------------------------------------------

import { lineOfSightClear } from '../utils/spawnVisibility.js';

const MS_PER_TICK = 1000 / 128;
const RAD_TO_DEG = 180 / Math.PI;

// How far (in ticks) to search around each click for on-target samples.
// ~16 ticks ≈ 125 ms @ 128 Hz — catches brief on-target windows the old ±3
// tick scan missed.
const CLICK_WINDOW_TICKS = 16;
const CLICK_SUBSTEPS = [0, 0.5]; // half-tick samples between telemetry frames

// Floor for flick-start speed (rad/tick). Keep this low: short flicks (e.g.
// Microflicks, ~1–3° of travel) only reach modest per-tick speeds, and a high
// floor made them invisible to the detector. ~0.0035 rad/tick ≈ 25°/s @128 tps.
// Forgiving start: any deliberate adjustment toward a target counts as a
// flick — big fast snaps AND small smooth corrections.
const MIN_FLICK_SPEED = 0.002; // ≈14°/s @128 tps
const MIN_MOVE_SPEED = 0.002;
const FLICK_START_RATIO = 1.15;
// Harsh end: one clearly-slow tick closes the flick, so post-flick wobble and
// micro-interruptions don't get folded into the flick and misread as over/under.
const FLICK_END_RATIO = 0.5;
const FLICK_MIN_TICKS = 2;
const FLICK_MAX_TICKS = 128;
const BASELINE_EMA = 0.15;
// A flick that lands within this × the target's angular radius is "accurate".
const ACCURATE_TOL = 1.5;
// Must close at least this fraction of the start→target angle to count as a flick.
const FLICK_MIN_TRAVEL_RATIO = 0.5;
// Ticks the motion classifier reports "reacting" after a sharp heading change.
const REACT_STATE_TICKS = 10;
// Minimum angular travel for the speed metric — small flicks still count.
const MIN_FLICK_ANGLE_DEG = 0.1;
const PAINTBALL_STEPS = 10; // sub-samples per tick so dots form solid lines

// Direction-change ("redirect") flick detection — catches flicks that keep a
// constant angular speed (so they never spike above the baseline) but sharply
// change heading, e.g. steady reposition → 90° snap onto a target.
const REDIRECT_ANGLE = Math.PI / 4; // ≥45° heading change segments a new flick
const REDIRECT_MIN_SPEED = MIN_FLICK_SPEED; // ignore sub-deliberate jitter
const MOTION_EMA = 0.3; // smoothing of the recent heading estimate
const REDIRECT_COOLDOWN = 4; // ticks before another redirect may fire

// A flick only ends after this many CONSECUTIVE slow ticks. A single-/double-
// tick input freeze (render stutter → 0 movement) would otherwise look like the
// flick settling and get mis-classified as an underflick before it lands.
const END_GRACE_TICKS = 1;

function dirFrom(pitch, yaw) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
function len(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalize(a) {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function angleBetween(a, b) {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb))));
}
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function yawFromQuat(q) {
  if (!q || q.length < 4) return 0;
  const [x, y, z, w] = q;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
}

function envMeshesAt(replay, tick) {
  const segs = replay?.environmentSegments;
  if (!segs?.length) return replay?.environment || [];
  let idx = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].start <= tick) idx = i;
    else break;
  }
  return segs[idx]?.meshes || [];
}

function meshToCoverBox(d) {
  if (d.geo !== 'Box' && !d.gridCover) return null;
  const p = d.params || {};
  const sx = d.s?.[0] ?? 1;
  const sy = d.s?.[1] ?? 1;
  const sz = d.s?.[2] ?? 1;
  return {
    pos: d.p || [0, 0, 0],
    size: [(p.width ?? 1) * sx, (p.height ?? 1) * sy, (p.depth ?? 1) * sz],
    rotationY: yawFromQuat(d.q)
  };
}

/** Unit tangent on the view sphere for motion from dirPrev → dirNow. */
function motionTangent(dirPrev, dirNow) {
  const axis = cross(dirPrev, dirNow);
  const axisLen = len(axis);
  if (axisLen < 1e-9) return null;
  return normalize(cross(axis, dirNow));
}

/** Unit tangent at dirNow pointing toward the target. */
function towardTargetTangent(dirNow, toTarget) {
  const d = dot(toTarget, dirNow);
  const proj = sub(toTarget, [dirNow[0] * d, dirNow[1] * d, dirNow[2] * d]);
  const l = len(proj);
  if (l < 1e-9) return null;
  return normalize(proj);
}

export class ReplayAnalytics {
  constructor(replay) {
    this.replay = replay;
    this.totalTicks = replay?.totalTicks || 0;
    this.tickRate = replay?.tickRate || 128;

    this._boundaries = new Set();
    for (const ev of replay?.events || []) {
      if (ev.type === 'shot' && (ev.by === 'player' || ev.by == null) && ev.hit) {
        this._boundaries.add(ev.t | 0);
      }
    }
    for (const ent of replay?.entities || []) {
      this._boundaries.add((ent.start + ent.len - 1) | 0);
    }

    this._shots = (replay?.events || [])
      .filter((e) => e.type === 'shot' && (e.by === 'player' || e.by == null))
      .sort((a, b) => a.t - b.t);

    this._deadAt = this._buildDeadAt();
    this.reset();
  }

  _buildDeadAt() {
    const deadAt = new Map();
    const r = this.replay;
    for (const ev of this._shots) {
      if (!ev.hit) continue;
      const t = ev.t | 0;
      if (ev.ent != null) {
        const prev = deadAt.get(ev.ent);
        if (prev == null || t < prev) deadAt.set(ev.ent, t);
        continue;
      }
      if (!ev.e) continue;
      for (const ent of r.entities || []) {
        const a = r.sampleEntityAim(ent, t);
        if (!a) continue;
        const dx = a.x - ev.e[0];
        const dy = a.y - ev.e[1];
        const dz = a.z - ev.e[2];
        if (Math.hypot(dx, dy, dz) <= a.radius * 1.25) {
          const prev = deadAt.get(ent.id);
          if (prev == null || t < prev) deadAt.set(ent.id, t);
        }
      }
    }
    return deadAt;
  }

  reset() {
    this._cursor = -1;
    this._shotIdx = 0;
    this.flicks = { accurate: 0, over: 0, under: 0 };
    this.clicks = { early: 0, accurate: 0, late: 0, earlyMs: 0, lateMs: 0 };
    this._pathDevSum = 0;
    this._pathDevCount = 0;
    this._trajDevSum = 0;
    this._trajDevCount = 0;
    this._baseline = MIN_FLICK_SPEED;
    this._episodeCounted = false;
    this._flick = null;
    this._flickTrail = [];
    this._flickStartDir = null;
    this._flickRefDist = 10;
    this._motionEMA = null; // smoothed recent heading (unit tangent)
    this._redirectCooldown = 0;
    this._flickSpeedSumMsPerDeg = 0;
    this._flickSpeedCount = 0;
    this._flickAccSum = 0;
    this._flickAccCount = 0;
    this._flashEvents = [];
    // --- Reworked radar stats ---
    this._ticksTotal = 0; // all processed ticks (hold-fire tracking modes)
    this._ticksOnTarget = 0;
    this._onStreak = 0; // consecutive on-target ticks right now
    this._prevOnStreak = 0; // streak as of the previous tick (pre-kill value)
    this._adjSinceKill = 0; // flicks counted since the last landed shot
    this._engageStart = null; // first on-target tick of the current engagement
    this._engageOnTicks = 0;
    this._trackSum = 0; // Σ on-target fraction per engagement (touch → kill)
    this._trackCount = 0;
    this._holdTickSum = 0; // Σ on-target ticks held before each kill shot
    this._holdCount = 0;
    this._dirChange = null; // pending target direction-change awaiting response
    this._dirDelaySum = 0; // Σ ticks from target turn → crosshair follows
    this._dirDelayCount = 0;
    this._prevEntVel = new Map(); // ent.id → last-tick velocity vector
    this._flickDegSum = 0; // total degrees travelled inside flicks
    this._flickTickSum = 0; // total ticks spent inside flicks
    this._killShots = 0; // shots that hit a target
    this._lastKillTick = null; // tick of last kill — measures delay to next flick
    this._killToFlickSum = 0; // Σ ticks from kill → first flick after
    this._killToFlickCount = 0;
    this._reactTicks = 0; // remaining ticks of the "reacting" motion state
    this.motionState = 'idle'; // idle | tracking | flicking | reacting
  }

  _camDir(tickFloat) {
    const c = this.replay.sampleCamera(tickFloat);
    return dirFrom(c.pitch, c.yaw);
  }

  _camAngles(tickFloat) {
    const c = this.replay.sampleCamera(tickFloat);
    return { pitch: c.pitch, yaw: c.yaw };
  }

  /** Interpolate aim angles into the paintball trail (10× per telemetry tick). */
  _appendFlickTrail(from, to, steps = PAINTBALL_STEPS) {
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      this._flickTrail.push({
        pitch: from.pitch + (to.pitch - from.pitch) * t,
        yaw: from.yaw + (to.yaw - from.yaw) * t
      });
    }
  }

  _coverBoxesAt(tick) {
    const meshes = envMeshesAt(this.replay, Math.floor(tick));
    const boxes = [];
    for (const d of meshes) {
      const box = meshToCoverBox(d);
      if (box) boxes.push(box);
    }
    return boxes;
  }

  _canSee(camPos, aim, tickFloat) {
    const boxes = this._coverBoxesAt(tickFloat);
    if (!boxes.length) return true;
    return lineOfSightClear(camPos, [aim.x, aim.y, aim.z], boxes);
  }

  _isEntityDead(ent, tickFloat) {
    const t = this._deadAt.get(ent.id);
    return t != null && tickFloat >= t;
  }

  /** Tick the entity was killed at (from recorded hits), or null. */
  deadAtTick(entId) {
    const t = this._deadAt.get(entId);
    return t == null ? null : t;
  }

  /**
   * Closest visible target to the aim ray at `tickFloat`. By default the ray is
   * the sampled camera; pass `originOverride`/`fwdOverride` to test a recorded
   * shot's exact aim instead (avoids integer-tick camera-sample phase error).
   */
  closestAt(tickFloat, originOverride = null, fwdOverride = null) {
    const r = this.replay;
    const cam = r.sampleCamera(tickFloat);
    const camPos = originOverride || [cam.px, cam.py, cam.pz];
    const fwd = fwdOverride || dirFrom(cam.pitch, cam.yaw);
    let best = null;
    let bestAng = Infinity;
    for (const ent of r.entities) {
      if (this._isEntityDead(ent, tickFloat)) continue;
      const a = r.sampleEntityAim(ent, tickFloat);
      if (!a) continue;
      if (!this._canSee(camPos, a, tickFloat)) continue;
      const to = sub([a.x, a.y, a.z], camPos);
      const dist = len(to);
      if (dist < 1e-6) continue;
      const ang = angleBetween(fwd, to);
      if (ang < bestAng) {
        bestAng = ang;
        best = { ent, aim: a, angle: ang, dist, camPos, fwd };
      }
    }
    return best;
  }

  _onTarget(closest) {
    if (!closest) return false;
    const angularRadius = Math.atan2(closest.aim.radius, closest.dist);
    return closest.angle <= angularRadius;
  }

  _onTargetAt(tickFloat) {
    return this._onTarget(this.closestAt(tickFloat));
  }

  /** Aim ray (origin + unit dir) for a recorded shot, or null for legacy events. */
  _shotRay(ev) {
    if (!ev?.o || !ev?.e) return null;
    const dir = normalize(sub(ev.e, ev.o));
    if (len(dir) < 1e-9) return null;
    return { origin: ev.o, dir };
  }

  /** On-target test for a recorded shot ray against targets at `tickFloat`. */
  _onTargetForShot(ray, tickFloat) {
    if (!ray) return this._onTargetAt(tickFloat);
    return this._onTarget(this.closestAt(tickFloat, ray.origin, ray.dir));
  }

  _recordPathDeviation(dirNow, dirPrev, closest) {
    if (!closest) return;
    const toTarget = normalize(
      sub([closest.aim.x, closest.aim.y, closest.aim.z], closest.camPos)
    );
    const tangent = motionTangent(dirPrev, dirNow);
    const optimal = towardTargetTangent(dirNow, toTarget);
    if (!tangent || !optimal) return;
    this._pathDevSum += angleBetween(tangent, optimal) / Math.PI;
    this._pathDevCount++;
  }

  _advanceTo(tickFloat) {
    const target = Math.min(this.totalTicks - 1, Math.floor(tickFloat));
    if (target < this._cursor) this._resyncFromStart(target);
    while (this._cursor < target) this._processTick(++this._cursor);
  }

  _resyncFromStart(target) {
    this.reset();
    while (this._cursor < target) this._processTick(++this._cursor);
  }

  _processTick(i) {
    if (i <= 0) return;

    if (this._boundaries.has(i)) this._episodeCounted = false;

    const dirNow = this._camDir(i);
    const dirPrev = this._camDir(i - 1);
    const speed = angleBetween(dirNow, dirPrev);
    const redirected = this._detectRedirect(dirNow, dirPrev, speed);
    const closest = this.closestAt(i);
    const closestPrev = this.closestAt(i - 1);
    const angles = this._camAngles(i);

    // On-target bookkeeping (tracking / reaction stats). Keep last tick's
    // streak: a killed entity is excluded from closestAt at its kill tick, so
    // the streak resets to 0 right before the kill click is processed — the
    // pre-kill value is the real "on-target before click" hold.
    this._prevOnStreak = this._onStreak;
    const onTarget = this._onTarget(closest);
    this._ticksTotal++;
    if (onTarget) {
      this._ticksOnTarget++;
      this._onStreak++;
      if (this._engageStart == null) {
        this._engageStart = i;
        this._engageOnTicks = 0;
      }
      this._engageOnTicks++;
    } else {
      this._onStreak = 0;
    }
    this._trackDirectionChange(i, closest, onTarget, dirNow, dirPrev, speed);

    if (closest && speed >= MIN_MOVE_SPEED) {
      this._recordPathDeviation(dirNow, dirPrev, closest);
    }
    if (this._flick && closest && speed >= MIN_MOVE_SPEED) {
      const toTarget = normalize(
        sub([closest.aim.x, closest.aim.y, closest.aim.z], closest.camPos)
      );
      const tangent = motionTangent(dirPrev, dirNow);
      const optimal = towardTargetTangent(dirNow, toTarget);
      if (tangent && optimal) {
        this._trajDevSum += angleBetween(tangent, optimal) / Math.PI;
        this._trajDevCount++;
      }
    }

    this._updateFlick(i, dirNow, dirPrev, speed, closest, closestPrev, angles, redirected);
    this._processShotsUpTo(i);
    this.motionState = this._classifyMotion(onTarget, speed, redirected);
  }

  /**
   * Categorise the mouse motion this tick:
   *   reacting — a drastic direction change was just made (or a tracked target
   *              turned and the player is responding)
   *   flicking — inside a detected flick (big fast snap OR small smooth
   *              adjustment — any adjustment is a flick)
   *   tracking — on a target making smooth, slow corrections
   *   idle     — waiting for a target / moving without aim intent
   */
  _classifyMotion(onTarget, speed, redirected) {
    if (redirected || this._dirChange) this._reactTicks = REACT_STATE_TICKS;
    if (this._reactTicks > 0) {
      this._reactTicks--;
      return 'reacting';
    }
    if (this._flick) return 'flicking';
    if (onTarget) return 'tracking';
    return 'idle';
  }

  /**
   * Reaction part 1: when the tracked target reverses direction while the
   * crosshair is on it, count the ticks until the crosshair starts moving the
   * target's new way. Unresolved changes time out at 64 ticks (~500 ms).
   */
  _trackDirectionChange(i, closest, onTarget, dirNow, dirPrev, speed) {
    if (!closest?.ent) {
      this._dirChange = null;
      return;
    }
    const a = this.replay.sampleEntityAim(closest.ent, i);
    const ap = this.replay.sampleEntityAim(closest.ent, i - 1);
    if (a && ap) {
      const vel = sub([a.x, a.y, a.z], [ap.x, ap.y, ap.z]);
      const prev = this._prevEntVel.get(closest.ent.id);
      if (
        !this._dirChange && onTarget && prev &&
        len(vel) > 1e-4 && len(prev) > 1e-4 &&
        dot(normalize(vel), normalize(prev)) < -0.2
      ) {
        this._dirChange = { tick: i, entId: closest.ent.id, vel: normalize(vel) };
      }
      this._prevEntVel.set(closest.ent.id, vel);
    }
    const dc = this._dirChange;
    if (!dc) return;
    if (i - dc.tick > 64 || closest.ent.id !== dc.entId) {
      if (i - dc.tick > 64) {
        this._dirDelaySum += 64;
        this._dirDelayCount++;
      }
      this._dirChange = null;
      return;
    }
    if (speed >= MIN_MOVE_SPEED) {
      const tangent = motionTangent(dirPrev, dirNow);
      if (tangent && dot(tangent, dc.vel) > 0) {
        this._dirDelaySum += i - dc.tick;
        this._dirDelayCount++;
        this._dirChange = null;
      }
    }
  }

  /**
   * True when the aim's heading changes sharply (≥REDIRECT_ANGLE) versus the
   * smoothed recent heading — a flick that holds speed but turns. Maintains the
   * heading EMA and a short cooldown so one turn fires once, not every tick.
   */
  _detectRedirect(dirNow, dirPrev, speed) {
    if (this._redirectCooldown > 0) this._redirectCooldown--;
    if (speed < REDIRECT_MIN_SPEED) return false;
    const tangent = motionTangent(dirPrev, dirNow);
    if (!tangent) return false;
    if (!this._motionEMA) {
      this._motionEMA = tangent;
      return false;
    }
    const turn = angleBetween(tangent, this._motionEMA);
    if (turn >= REDIRECT_ANGLE && this._redirectCooldown === 0) {
      this._motionEMA = tangent; // snap to the new heading so it fires once
      this._redirectCooldown = REDIRECT_COOLDOWN;
      return true;
    }
    this._motionEMA = normalize([
      this._motionEMA[0] * (1 - MOTION_EMA) + tangent[0] * MOTION_EMA,
      this._motionEMA[1] * (1 - MOTION_EMA) + tangent[1] * MOTION_EMA,
      this._motionEMA[2] * (1 - MOTION_EMA) + tangent[2] * MOTION_EMA
    ]);
    return false;
  }

  _updateFlick(i, dirNow, dirPrev, speed, closest, closestPrev, angles, redirected) {
    if (!this._flick) {
      const toward = closest && closestPrev && closest.angle < closestPrev.angle;
      const threshold = Math.max(FLICK_START_RATIO * this._baseline, MIN_FLICK_SPEED);
      const spikeStart = toward && speed >= threshold;
      // A heading change is a flick even at constant speed (no baseline spike).
      const redirectStart = redirected && speed >= REDIRECT_MIN_SPEED;
      if (closest && (spikeStart || redirectStart)) {
        if (redirectStart) this._episodeCounted = false; // fresh aim intent
        this._startFlick(i, dirPrev, closest, speed);
      } else {
        this._baseline += (speed - this._baseline) * BASELINE_EMA;
      }
      return;
    }

    const f = this._flick;

    // Sharp redirect mid-flick = a new flick. Close out the current episode (so
    // an overshoot-then-correct is segmented, and the overshoot itself counts as
    // an overflick) and immediately open a fresh one anchored at the turn.
    if (redirected && f.ticks >= FLICK_MIN_TICKS && closest) {
      this._classifyFlick(f, dirNow, closest);
      this._endFlick();
      this._episodeCounted = false;
      this._startFlick(i, dirPrev, closest, speed);
      return;
    }

    f.speedSum += speed;
    f.speedCount++;
    f.ticks++;
    const prev = this._flickTrail[this._flickTrail.length - 1];
    if (prev) this._appendFlickTrail(prev, angles);
    else this._flickTrail.push(angles);

    // End only after several CONSECUTIVE slow ticks — a 1–2 tick input freeze
    // (stutter → 0 movement) must not end the flick early as a false underflick.
    const avg = f.speedSum / f.speedCount;
    if (speed <= FLICK_END_RATIO * avg) f.endGrace++;
    else f.endGrace = 0;

    const ended =
      (f.ticks >= FLICK_MIN_TICKS && f.endGrace >= END_GRACE_TICKS) ||
      f.ticks >= FLICK_MAX_TICKS ||
      !closest;

    if (!ended) return;

    this._classifyFlick(f, dirNow, closest);
    this._endFlick();
  }

  _startFlick(i, dirPrev, closest, speed) {
    if (this._lastKillTick != null) {
      this._killToFlickSum += Math.max(0, i - this._lastKillTick);
      this._killToFlickCount++;
      this._lastKillTick = null;
    }
    const startAngles = this._camAngles(i - 1);
    this._flick = {
      startDir: dirPrev,
      speedSum: speed,
      speedCount: 1,
      ticks: 1,
      endGrace: 0,
      startTick: i - 1
    };
    this._flickStartDir = dirPrev;
    this._flickRefDist = closest.dist;
    this._flickTrail = [startAngles];
  }

  _endFlick() {
    this._flick = null;
    this._flickTrail = [];
    this._flickStartDir = null;
    this._baseline = MIN_FLICK_SPEED;
  }

  _classifyFlick(f, dirEnd, closest) {
    if (this._episodeCounted || !closest) return;
    const targetDir = sub(
      [closest.aim.x, closest.aim.y, closest.aim.z],
      closest.camPos
    );
    const traveled = angleBetween(f.startDir, dirEnd);
    const required = angleBetween(f.startDir, targetDir);
    if (required < 1e-6 || traveled < FLICK_MIN_TRAVEL_RATIO * required) return;

    let bucket;
    // Forgiving landing zone: within 1.5× the target's angular radius counts
    // as on target — only clear misses are branded over/under.
    const angularRadius = Math.atan2(closest.aim.radius, closest.dist);
    if (closest.angle <= angularRadius * ACCURATE_TOL) {
      bucket = 'accurate';
    } else {
      bucket = traveled > required ? 'over' : 'under';
    }
    this.flicks[bucket]++;
    this._adjSinceKill++;
    this._episodeCounted = true;
    // Measure speed + accuracy per completed flick (decoupled from clicks) so
    // these metrics always populate when a flick is detected.
    this._measureFlickQuality(f, dirEnd, targetDir);
    const label =
      bucket === 'accurate' ? 'Accurate flick' : bucket === 'over' ? 'Overflick' : 'Underflick';
    this._flashEvents.push({ type: 'flick', bucket, text: label });
  }

  /** Flick speed (ms per °) + accuracy (% of the start→target gap closed). */
  _measureFlickQuality(f, dirEnd, targetDir) {
    const traveledDeg = angleBetween(f.startDir, dirEnd) * RAD_TO_DEG;
    if (f.ticks > 0 && traveledDeg >= MIN_FLICK_ANGLE_DEG) {
      const ms = f.ticks * MS_PER_TICK;
      this._flickSpeedSumMsPerDeg += ms / traveledDeg;
      this._flickSpeedCount++;
      // Speed stat: total distance travelled while flicking vs time spent.
      this._flickDegSum += traveledDeg;
      this._flickTickSum += f.ticks;
    }
    const dStart = angleBetween(f.startDir, targetDir);
    if (dStart > 1e-6) {
      const dEnd = angleBetween(dirEnd, targetDir);
      this._flickAccSum += clamp01(1 - dEnd / dStart) * 100;
      this._flickAccCount++;
    }
  }

  _processShotsUpTo(i) {
    while (this._shotIdx < this._shots.length && this._shots[this._shotIdx].t <= i) {
      this._classifyClick(this._shots[this._shotIdx]);
      this._shotIdx++;
    }
  }

  _classifyClick(ev) {
    const t = ev.t;
    const ray = this._shotRay(ev);
    const timing = this._findClickTiming(t, ray);

    if (timing.kind === 'none') return;

    if (ev.hit) this._recordKillClick(t);

    if (timing.kind === 'accurate') {
      this.clicks.accurate++;
      this._flashEvents.push({ type: 'click', kind: 'accurate', text: 'On target' });
      return;
    }
    if (timing.kind === 'early') {
      this.clicks.early++;
      this.clicks.earlyMs += timing.ms;
      this._flashEvents.push({ type: 'click', kind: 'early', text: `${timing.ms} ms under` });
      return;
    }
    this.clicks.late++;
    this.clicks.lateMs += timing.ms;
    this._flashEvents.push({ type: 'click', kind: 'late', text: `${timing.ms} ms over` });
  }

  /**
   * Scan ±CLICK_WINDOW_TICKS around the shot (with half-tick samples) and
   * classify relative to the click instant. Uses the recorded shot ray when
   * available so timing matches what was actually fired, not a re-sampled camera.
   */
  _findClickTiming(t, ray) {
    const onAt = [];
    for (let k = -CLICK_WINDOW_TICKS; k <= CLICK_WINDOW_TICKS; k++) {
      const steps = k === 0 ? [0] : CLICK_SUBSTEPS;
      for (const frac of steps) {
        const tf = t + k + frac;
        if (tf < 0 || tf >= this.totalTicks) continue;
        if (this._onTargetForShot(ray, tf)) onAt.push(k + frac);
      }
    }
    if (!onAt.length) return { kind: 'none' };

    // On target within ±¼ tick of the click → timed correctly.
    if (onAt.some((s) => Math.abs(s) <= 0.25)) return { kind: 'accurate' };

    let nearest = onAt[0];
    for (const s of onAt) {
      if (Math.abs(s) < Math.abs(nearest)) nearest = s;
    }
    const ms = Math.max(1, Math.round(Math.abs(nearest) * MS_PER_TICK));
    if (nearest < 0) return { kind: 'late', ms };
    return { kind: 'early', ms };
  }

  /** Kill-shot bookkeeping (reaction / tracking / adjustments). */
  _recordKillClick(t) {
    this._killShots++;
    this._lastKillTick = t;
    this._adjSinceKill = 0;
    this._holdTickSum += this._onStreak > 0 ? this._onStreak : this._prevOnStreak + 1;
    this._holdCount++;
    if (this._engageStart != null) {
      const span = Math.max(1, t - this._engageStart + 1);
      this._trackSum += Math.min(1, this._engageOnTicks / span);
      this._trackCount++;
    }
    this._engageStart = null;
    this._engageOnTicks = 0;
  }

  /**
   * Tension = average % deviation of the crosshair's motion from the direct
   * path to the target it ends up engaging, averaged across the whole run.
   */
  get tensionPct() {
    if (!this._pathDevCount) return 0;
    return 100 * clamp01(this._pathDevSum / this._pathDevCount);
  }

  /** Tracking: avg on-target fraction per engagement (first touch → kill), %. */
  get trackingPct() {
    if (!this._trackCount) return 0;
    return 100 * (this._trackSum / this._trackCount);
  }

  /** Tracking for hold-fire modes: % of ALL run ticks spent on target. */
  get onTargetPct() {
    if (!this._ticksTotal) return 0;
    return (100 * this._ticksOnTarget) / this._ticksTotal;
  }

  /** Avg ticks from target direction reversal → crosshair follows (on-target only). */
  get reactionDirMs() {
    if (!this._dirDelayCount) return null;
    return (this._dirDelaySum / this._dirDelayCount) * MS_PER_TICK;
  }

  /** Avg on-target ticks held before each kill (incl. the click/kill frame). */
  get reactionHoldMs() {
    if (!this._holdCount) return null;
    return (this._holdTickSum / this._holdCount) * MS_PER_TICK;
  }

  /** Avg ticks from a kill to the next detected flick. */
  get killToFlickMs() {
    if (!this._killToFlickCount) return null;
    return (this._killToFlickSum / this._killToFlickCount) * MS_PER_TICK;
  }

  /**
   * Reaction (ms): 50/50 blend of direction-change response and hold-before-click.
   * Null when the run produced no reaction samples at all.
   */
  get reactionMs() {
    const dir = this.reactionDirMs;
    const hold = this.reactionHoldMs;
    if (dir != null && hold != null) return (dir + hold) / 2;
    if (dir != null) return dir;
    if (hold != null) return hold;
    return null;
  }

  /** Total detected flicks (accurate + over + under). */
  get flicksTotal() {
    return this.flicks.accurate + this.flicks.over + this.flicks.under;
  }

  /** Flicks per target hit — always ≥ 1 when targets were hit. */
  get adjustmentsPerTarget() {
    if (!this._killShots) return null;
    return this.flicksTotal / this._killShots;
  }

  /** Speed: degrees travelled inside flicks over the time spent flicking (°/s). */
  get flickSpeedDegS() {
    if (!this._flickTickSum) return 0;
    return this._flickDegSum / ((this._flickTickSum * MS_PER_TICK) / 1000);
  }

  /** Average ms per degree of angular travel over each detected flick. */
  get flickSpeedMsPerDeg() {
    if (!this._flickSpeedCount) return 0;
    return this._flickSpeedSumMsPerDeg / this._flickSpeedCount;
  }

  get flickAccuracyPct() {
    if (!this._flickAccCount) return 0;
    return this._flickAccSum / this._flickAccCount;
  }

  get clickAccuracyPct() {
    const total = this.clicks.early + this.clicks.accurate + this.clicks.late;
    if (!total) return 0;
    return (this.clicks.accurate / total) * 100;
  }

  sampleTick(tickFloat) {
    this._advanceTo(tickFloat);
    const closest = this.closestAt(tickFloat);
    const camNow = this.replay.sampleCamera(tickFloat);
    const camPrev = this.replay.sampleCamera(Math.max(0, tickFloat - 1));
    const flashEvents = this._flashEvents;
    this._flashEvents = [];

    return {
      target: closest
        ? { x: closest.aim.x, y: closest.aim.y, z: closest.aim.z, radius: closest.aim.radius }
        : null,
      onTarget: this._onTarget(closest),
      moveDir: { yaw: camNow.yaw - camPrev.yaw, pitch: camNow.pitch - camPrev.pitch },
      flickActive: !!this._flick,
      flickTrail: this._flickTrail.map((a) => ({ pitch: a.pitch, yaw: a.yaw })),
      flickStartDir: this._flickStartDir,
      flickRefDist: this._flickRefDist,
      flicks: { ...this.flicks },
      clicks: { ...this.clicks },
      adjustmentsTotal: this.flicksTotal,
      adjustmentsSinceKill: this._adjSinceKill,
      targetsHit: this._killShots,
      tensionPct: this.tensionPct,
      flickSpeedMsPerDeg: this.flickSpeedMsPerDeg,
      flickAccuracyPct: this.flickAccuracyPct,
      clickAccuracyPct: this.clickAccuracyPct,
      flicksMeasured: this._flickSpeedCount,
      motionState: this.motionState,
      flashEvents
    };
  }

  aggregate() {
    this.reset();
    if (this.totalTicks > 0) this._advanceTo(this.totalTicks - 1);
    this._processShotsUpTo(this.totalTicks);
    return {
      flicks_accurate: this.flicks.accurate,
      flicks_over: this.flicks.over,
      flicks_under: this.flicks.under,
      clicks_early: this.clicks.early,
      clicks_accurate: this.clicks.accurate,
      clicks_late: this.clicks.late,
      click_early_ms: Math.round(this.clicks.earlyMs * 10) / 10,
      click_late_ms: Math.round(this.clicks.lateMs * 10) / 10,
      tension_pct: Math.round(this.tensionPct * 10) / 10,
      flick_speed_ms: Math.round(this.flickSpeedMsPerDeg * 10) / 10,
      flick_accuracy_pct: Math.round(this.flickAccuracyPct * 10) / 10,
      flicks_measured: this._flickSpeedCount,
      // Reworked radar stats
      tracking_pct: Math.round(this.trackingPct * 10) / 10,
      on_target_pct: Math.round(this.onTargetPct * 10) / 10,
      reaction_ms: this.reactionMs == null ? null : Math.round(this.reactionMs * 10) / 10,
      reaction_dir_ms: this.reactionDirMs == null ? null : Math.round(this.reactionDirMs * 10) / 10,
      reaction_hold_ms: this.reactionHoldMs == null ? null : Math.round(this.reactionHoldMs * 10) / 10,
      kill_to_flick_ms: this.killToFlickMs == null ? null : Math.round(this.killToFlickMs * 10) / 10,
      reaction_dir_samples: this._dirDelayCount,
      reaction_hold_samples: this._holdCount,
      kill_to_flick_samples: this._killToFlickCount,
      adjustments_per_target:
        this.adjustmentsPerTarget == null ? null : Math.round(this.adjustmentsPerTarget * 100) / 100,
      flicks_total: this.flicksTotal,
      targets_hit: this._killShots,
      flick_deg_total: Math.round(this._flickDegSum * 10) / 10,
      flick_time_ms: Math.round(this._flickTickSum * MS_PER_TICK * 10) / 10,
      speed_deg_s: Math.round(this.flickSpeedDegS * 10) / 10,
      targets_hit: this._killShots
    };
  }
}

export default ReplayAnalytics;

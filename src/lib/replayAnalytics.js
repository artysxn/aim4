// ---------------------------------------------------------------------------
// lib/replayAnalytics.js — replay aim-analysis engine
// ---------------------------------------------------------------------------

import { lineOfSightClear } from '../utils/spawnVisibility.js';

const MS_PER_TICK = 1000 / 128;
const RAD_TO_DEG = 180 / Math.PI;

// Floor for flick-start speed (rad/tick). Keep this low: short flicks (e.g.
// Microflicks, ~1–3° of travel) only reach modest per-tick speeds, and a high
// floor made them invisible to the detector. ~0.0035 rad/tick ≈ 25°/s @128 tps.
const MIN_FLICK_SPEED = 0.0035;
const MIN_MOVE_SPEED = 0.002;
const FLICK_START_RATIO = 1.3;
const FLICK_END_RATIO = 1 / 3;
const FLICK_MIN_TICKS = 2;
const FLICK_MAX_TICKS = 128;
const BASELINE_EMA = 0.15;
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
const END_GRACE_TICKS = 3;

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

    // On-target bookkeeping (tracking / reaction stats).
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
    let bucket;
    if (this._onTarget(closest)) {
      bucket = 'accurate';
    } else {
      const traveled = angleBetween(f.startDir, dirEnd);
      const required = angleBetween(f.startDir, targetDir);
      bucket = traveled > required ? 'over' : 'under';
    }
    this.flicks[bucket]++;
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
    const t = ev.t | 0;
    const ray = this._shotRay(ev);

    // A recorded HIT is ground truth: the crosshair WAS on the target. Re-deriving
    // it from an integer-tick camera sample drifts ~1 tick and mislabels hits as
    // "8 ms under". Trust the hit (and the exact shot ray) → accurate.
    if (ev.hit || this._onTargetForShot(ray, t)) {
      this.clicks.accurate++;
      // Reaction part 2: on-target ticks held before this landed shot.
      this._killShots++;
      this._holdTickSum += Math.max(0, this._onStreak - 1);
      this._holdCount++;
      // Tracking: on-target fraction of this engagement (first touch → kill).
      if (this._engageStart != null) {
        const span = Math.max(1, t - this._engageStart + 1);
        this._trackSum += Math.min(1, this._engageOnTicks / span);
        this._trackCount++;
      }
      this._engageStart = null;
      this._engageOnTicks = 0;
      this._flashEvents.push({ type: 'click', kind: 'accurate', text: 'On target' });
      return;
    }
    // Miss: was the crosshair sweeping ACROSS the target just before/after? This
    // is camera-timing (when the aim crossed the dot), so vary the camera here.
    for (let k = 1; k <= 2; k++) {
      if (this._onTargetAt(t + k)) {
        this.clicks.early++;
        const ms = Math.round((k - 1) * MS_PER_TICK);
        this.clicks.earlyMs += ms;
        this._flashEvents.push({ type: 'click', kind: 'early', text: `${ms} ms under` });
        return;
      }
    }
    for (let k = 1; k <= 3; k++) {
      if (this._onTargetAt(t - k)) {
        this.clicks.late++;
        const ms = Math.round(k * MS_PER_TICK);
        this.clicks.lateMs += ms;
        this._flashEvents.push({ type: 'click', kind: 'late', text: `${ms} ms over` });
        return;
      }
    }
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

  /**
   * Reaction (ms): 50/50 blend of (a) delay following a target's direction
   * change and (b) time held on target before each landed shot. 0 = aimbot.
   * Null when the run produced no reaction samples at all.
   */
  get reactionMs() {
    const parts = [];
    if (this._dirDelayCount) parts.push((this._dirDelaySum / this._dirDelayCount) * MS_PER_TICK);
    if (this._holdCount) parts.push((this._holdTickSum / this._holdCount) * MS_PER_TICK);
    if (!parts.length) return null;
    return parts.reduce((a, b) => a + b, 0) / parts.length;
  }

  /** Adjustments: detected flicks per target actually hit (1.0 = one-and-done). */
  get adjustmentsPerTarget() {
    if (!this._killShots) return null;
    const flicksTotal = this.flicks.accurate + this.flicks.over + this.flicks.under;
    return Math.max(1, flicksTotal / this._killShots);
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
      tensionPct: this.tensionPct,
      flickSpeedMsPerDeg: this.flickSpeedMsPerDeg,
      flickAccuracyPct: this.flickAccuracyPct,
      clickAccuracyPct: this.clickAccuracyPct,
      flicksMeasured: this._flickSpeedCount,
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
      adjustments_per_target:
        this.adjustmentsPerTarget == null ? null : Math.round(this.adjustmentsPerTarget * 100) / 100,
      speed_deg_s: Math.round(this.flickSpeedDegS * 10) / 10,
      targets_hit: this._killShots
    };
  }
}

export default ReplayAnalytics;

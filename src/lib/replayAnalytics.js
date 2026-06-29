// ---------------------------------------------------------------------------
// lib/replayAnalytics.js — replay aim-analysis engine
// ---------------------------------------------------------------------------

import { lineOfSightClear } from '../utils/spawnVisibility.js';

const MS_PER_TICK = 1000 / 128;
const RAD_TO_DEG = 180 / Math.PI;

const MIN_FLICK_SPEED = 0.01;
const MIN_MOVE_SPEED = 0.002;
const FLICK_START_RATIO = 1.5;
const FLICK_END_RATIO = 1 / 3;
const FLICK_MIN_TICKS = 2;
const FLICK_MAX_TICKS = 128;
const BASELINE_EMA = 0.15;
const MIN_FLICK_ANGLE_DEG = 0.5;
const PAINTBALL_STEPS = 10; // sub-samples per tick so dots form solid lines

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
    this._pendingFlick = null;
    this._flickSpeedSumMsPerDeg = 0;
    this._flickSpeedCount = 0;
    this._flickAccSum = 0;
    this._flickAccCount = 0;
    this._flashEvents = [];
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

  closestAt(tickFloat) {
    const r = this.replay;
    const cam = r.sampleCamera(tickFloat);
    const camPos = [cam.px, cam.py, cam.pz];
    const fwd = dirFrom(cam.pitch, cam.yaw);
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
    const closest = this.closestAt(i);
    const closestPrev = this.closestAt(i - 1);
    const angles = this._camAngles(i);

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

    this._updateFlick(i, dirNow, dirPrev, speed, closest, closestPrev, angles);
    this._processShotsUpTo(i);
  }

  _updateFlick(i, dirNow, dirPrev, speed, closest, closestPrev, angles) {
    if (!this._flick) {
      const toward =
        closest && closestPrev && closest.angle < closestPrev.angle;
      const threshold = Math.max(FLICK_START_RATIO * this._baseline, MIN_FLICK_SPEED);
      if (closest && toward && speed >= threshold) {
        const startAngles = this._camAngles(i - 1);
        this._flick = {
          startDir: dirPrev,
          speedSum: speed,
          speedCount: 1,
          ticks: 1
        };
        this._flickStartDir = dirPrev;
        this._flickRefDist = closest.dist;
        this._flickTrail = [startAngles];
        this._pendingFlick = { startTick: i - 1, startDir: dirPrev };
      } else {
        this._baseline += (speed - this._baseline) * BASELINE_EMA;
      }
      return;
    }

    const f = this._flick;
    f.speedSum += speed;
    f.speedCount++;
    f.ticks++;
    const prev = this._flickTrail[this._flickTrail.length - 1];
    if (prev) this._appendFlickTrail(prev, angles);
    else this._flickTrail.push(angles);

    const avg = f.speedSum / f.speedCount;
    const ended =
      (f.ticks >= FLICK_MIN_TICKS && speed <= FLICK_END_RATIO * avg) ||
      f.ticks >= FLICK_MAX_TICKS ||
      !closest;

    if (!ended) return;

    this._classifyFlick(f, dirNow, closest);
    this._flick = null;
    this._flickTrail = [];
    this._flickStartDir = null;
    this._pendingFlick = null;
    this._baseline = MIN_FLICK_SPEED;
  }

  _classifyFlick(f, dirEnd, closest) {
    if (this._episodeCounted || !closest) return;
    let bucket;
    if (this._onTarget(closest)) {
      bucket = 'accurate';
    } else {
      const targetDir = sub(
        [closest.aim.x, closest.aim.y, closest.aim.z],
        closest.camPos
      );
      const traveled = angleBetween(f.startDir, dirEnd);
      const required = angleBetween(f.startDir, targetDir);
      bucket = traveled > required ? 'over' : 'under';
    }
    this.flicks[bucket]++;
    this._episodeCounted = true;
    const label =
      bucket === 'accurate' ? 'Accurate flick' : bucket === 'over' ? 'Overflick' : 'Underflick';
    this._flashEvents.push({ type: 'flick', bucket, text: label });
  }

  _processShotsUpTo(i) {
    while (this._shotIdx < this._shots.length && this._shots[this._shotIdx].t <= i) {
      this._classifyClick(this._shots[this._shotIdx].t);
      this._shotIdx++;
    }
  }

  _measureFlickClick(t) {
    const pf = this._pendingFlick;
    if (!pf) return;
    this._pendingFlick = null;

    const dtTicks = t - pf.startTick;
    const clickDir = this._camDir(t);
    const angleDeg = angleBetween(pf.startDir, clickDir) * RAD_TO_DEG;

    if (dtTicks > 0 && angleDeg >= MIN_FLICK_ANGLE_DEG) {
      const ms = dtTicks * MS_PER_TICK;
      this._flickSpeedSumMsPerDeg += ms / angleDeg;
      this._flickSpeedCount++;
    }

    const closest = this.closestAt(t);
    if (!closest) return;
    const targetDir = normalize(
      sub([closest.aim.x, closest.aim.y, closest.aim.z], closest.camPos)
    );
    const dStart = angleBetween(pf.startDir, targetDir);
    const dClick = angleBetween(clickDir, targetDir);
    if (dStart <= 1e-6) return;
    const acc = Math.max(0, Math.min(1, 1 - dClick / dStart)) * 100;
    this._flickAccSum += acc;
    this._flickAccCount++;
  }

  _classifyClick(t) {
    this._measureFlickClick(t);

    // Shots are stamped on the tick boundary before the camera sample that reflects
    // the click aim, so t+1 is the matching sample for an on-time shot.
    if (this._onTargetAt(t) || this._onTargetAt(t + 1)) {
      this.clicks.accurate++;
      this._flashEvents.push({ type: 'click', kind: 'accurate', text: 'On target' });
      return;
    }
    for (let k = 2; k <= 3; k++) {
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

  get tensionPct() {
    const path = this._pathDevCount ? this._pathDevSum / this._pathDevCount : 0;
    const flickTotal = this.flicks.accurate + this.flicks.over + this.flicks.under;
    const flickStray = flickTotal ? (this.flicks.over + this.flicks.under) / flickTotal : 0;
    const traj = this._trajDevCount ? this._trajDevSum / this._trajDevCount : 0;
    if (!this._pathDevCount && !flickTotal && !this._trajDevCount) return 0;
    return 100 * clamp01(0.55 * path + 0.3 * flickStray + 0.15 * traj);
  }

  /** Average ms per degree of angular travel from flick start to first click. */
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
      flicks_measured: this._flickSpeedCount
    };
  }
}

export default ReplayAnalytics;

// ---------------------------------------------------------------------------
// lib/replayAnalytics.js — replay aim-analysis engine
//
// Pure, deterministic analysis layer for a decoded replay view (the object
// produced by replayCodec.buildReplayView). Everything is derived from data the
// replay already contains: the 128 Hz camera track, per-entity position/aim
// tracks, and shot events. Nothing here touches the DOM or THREE — ReplayPlayer
// owns rendering and feeds the per-tick results to the HUD/overlay.
//
// Two consumers:
//   • live playback  — `sampleTick(tickFloat)` advances internal state to the
//     current tick and returns a snapshot (closest target, crosshair motion,
//     running counters) for the on-screen overlay + stats panel.
//   • persistence     — `aggregate()` runs the whole track once and returns the
//     final counters stored alongside the replay in Supabase.
//
// Detection model (shared by every metric):
//   - "crosshair direction" = the camera forward vector from pitch/yaw.
//   - "closest target"      = the live entity whose AIM POINT (head for bots,
//     centre for dots — see replayCodec.sampleEntityAim) is at the smallest
//     ANGULAR distance from the crosshair.
//   - "on target/head"      = that angular distance < atan(radius / distance).
// ---------------------------------------------------------------------------

const MS_PER_TICK = 1000 / 128;

// Flick tuning. Angular speed is radians of crosshair travel per tick (128 Hz).
const MIN_FLICK_SPEED = 0.01; // ~0.57°/tick (~73°/s) — floor so idle jitter never "flicks"
const MIN_MOVE_SPEED = 0.002; // below this the crosshair is considered still
const FLICK_START_RATIO = 1.5; // start: speed ≥ 1.5× the pre-motion baseline
const FLICK_END_RATIO = 1 / 3; // end:   speed ≤ ⅓ of the flick's average speed
const FLICK_MIN_TICKS = 2; // a flick must last at least this long before it can end
const FLICK_MAX_TICKS = 128; // hard stop after 1s so a slow drag can't run forever
const BASELINE_EMA = 0.15; // how fast the idle-speed baseline tracks recent motion

// --- tiny vector helpers (plain arrays, no allocation churn) ----------------

/** Camera forward vector for a YXZ (yaw,pitch) rotation. Unit length. */
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
function len(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalize(a) {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
/** Angle (radians) between two vectors; 0 when either is degenerate. */
function angleBetween(a, b) {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb))));
}

export class ReplayAnalytics {
  constructor(replay) {
    this.replay = replay;
    this.totalTicks = replay?.totalTicks || 0;
    this.tickRate = replay?.tickRate || 128;

    // Episode boundaries (kill / hit / death / miss) gate flick counting to ONE
    // adjustment each: every shot fired + every moment a tracked target ends.
    this._boundaries = new Set();
    for (const ev of replay?.events || []) {
      if (ev.type === 'shot') this._boundaries.add(ev.t | 0);
    }
    for (const ent of replay?.entities || []) {
      this._boundaries.add((ent.start + ent.len - 1) | 0);
    }
    // Player shots, sorted, for click-timing analysis.
    this._shots = (replay?.events || [])
      .filter((e) => e.type === 'shot' && (e.by === 'player' || e.by == null))
      .sort((a, b) => a.t - b.t);

    this.reset();
  }

  reset() {
    this._cursor = -1; // last integer tick folded into state
    this._shotIdx = 0; // next unprocessed player shot
    this.flicks = { accurate: 0, over: 0, under: 0 };
    this.clicks = { early: 0, accurate: 0, late: 0, earlyMs: 0, lateMs: 0 };
    this._tensionSum = 0;
    this._tensionCount = 0;
    this._baseline = MIN_FLICK_SPEED;
    this._episodeCounted = false;
    this._flick = null; // { startDir, speedSum, speedCount, ticks }

    // Flick speed: ms from flick start to its FIRST click (averaged per flick).
    // Flick accuracy: where the first click lands along start→target (0 = start,
    // 100 = on target), averaged per flick.
    this._pendingFlick = null; // { startTick, startDir } awaiting its first click
    this._flickSpeedSumMs = 0;
    this._flickSpeedCount = 0;
    this._flickAccSum = 0;
    this._flickAccCount = 0;
  }

  // ---- random-access sampling helpers -------------------------------------

  _camDir(tickFloat) {
    const c = this.replay.sampleCamera(tickFloat);
    return dirFrom(c.pitch, c.yaw);
  }

  /** Closest target (by angular distance) at an interpolated tick, or null. */
  closestAt(tickFloat) {
    const r = this.replay;
    const cam = r.sampleCamera(tickFloat);
    const camPos = [cam.px, cam.py, cam.pz];
    const fwd = dirFrom(cam.pitch, cam.yaw);
    let best = null;
    let bestAng = Infinity;
    for (const ent of r.entities) {
      const a = r.sampleEntityAim(ent, tickFloat);
      if (!a) continue;
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

  /** True when the crosshair sits on the closest target's aim zone. */
  _onTarget(closest) {
    if (!closest) return false;
    const angularRadius = Math.atan2(closest.aim.radius, closest.dist);
    return closest.angle <= angularRadius;
  }

  _onTargetAt(tickFloat) {
    return this._onTarget(this.closestAt(tickFloat));
  }

  // ---- forward state machine ----------------------------------------------

  /** Fold every integer tick up to floor(tickFloat) into the running state. */
  _advanceTo(tickFloat) {
    const target = Math.min(this.totalTicks - 1, Math.floor(tickFloat));
    if (target < this._cursor) this._resyncFromStart(target);
    while (this._cursor < target) this._processTick(++this._cursor);
  }

  /** A backward seek invalidates accumulated state — replay from scratch. */
  _resyncFromStart(target) {
    this.reset();
    while (this._cursor < target) this._processTick(++this._cursor);
  }

  _processTick(i) {
    if (i <= 0) return; // need a previous tick for any motion delta

    // New episode? Re-open flick counting for it.
    if (this._boundaries.has(i)) this._episodeCounted = false;

    const dirNow = this._camDir(i);
    const dirPrev = this._camDir(i - 1);
    const speed = angleBetween(dirNow, dirPrev);
    const closest = this.closestAt(i);
    const closestPrev = this.closestAt(i - 1);

    this._updateTension(i, dirNow, dirPrev, speed, closest);
    this._updateFlick(i, dirNow, dirPrev, speed, closest, closestPrev);
    this._processShotsUpTo(i);
  }

  _updateTension(i, dirNow, dirPrev, speed, closest) {
    if (!closest || speed < MIN_MOVE_SPEED) return;
    const moveVec = sub(dirNow, dirPrev); // where the crosshair actually went
    const optimalVec = sub(
      [closest.aim.x, closest.aim.y, closest.aim.z],
      closest.camPos
    ); // where it should have gone (straight at the target)
    const a = angleBetween(moveVec, optimalVec);
    this._tensionSum += (1 - Math.cos(a)) / 2; // 0 = perfectly on-path, 1 = opposite
    this._tensionCount++;
  }

  _updateFlick(i, dirNow, dirPrev, speed, closest, closestPrev) {
    if (!this._flick) {
      // --- looking for a flick to START ---
      const toward =
        closest && closestPrev && closest.angle < closestPrev.angle;
      const threshold = Math.max(FLICK_START_RATIO * this._baseline, MIN_FLICK_SPEED);
      if (closest && toward && speed >= threshold) {
        this._flick = {
          startDir: dirPrev, // crosshair position when the flick began
          speedSum: speed,
          speedCount: 1,
          ticks: 1
        };
        // Arm flick-speed / flick-accuracy measurement for the next click.
        this._pendingFlick = { startTick: i - 1, startDir: dirPrev };
      } else {
        // idle/tracking — let the baseline follow the ambient speed
        this._baseline += (speed - this._baseline) * BASELINE_EMA;
      }
      return;
    }

    // --- inside a flick ---
    const f = this._flick;
    f.speedSum += speed;
    f.speedCount++;
    f.ticks++;
    const avg = f.speedSum / f.speedCount;
    const ended =
      (f.ticks >= FLICK_MIN_TICKS && speed <= FLICK_END_RATIO * avg) ||
      f.ticks >= FLICK_MAX_TICKS ||
      !closest;

    if (!ended) return;
    this._classifyFlick(f, dirNow, closest);
    this._flick = null;
    this._baseline = MIN_FLICK_SPEED; // re-seat baseline after the burst
  }

  /** Bucket a finished flick as accurate / over / under (one per episode). */
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
      const traveled = angleBetween(f.startDir, dirEnd); // how far the crosshair moved
      const required = angleBetween(f.startDir, targetDir); // how far the target was
      bucket = traveled > required ? 'over' : 'under';
    }
    this.flicks[bucket]++;
    this._episodeCounted = true;
  }

  /** Classify every player click whose tick we've now reached. */
  _processShotsUpTo(i) {
    while (this._shotIdx < this._shots.length && this._shots[this._shotIdx].t <= i) {
      this._classifyClick(this._shots[this._shotIdx].t);
      this._shotIdx++;
    }
  }

  /**
   * If a flick is awaiting its first click, this shot resolves it:
   *   • flick speed = ms from flick start to this click.
   *   • flick accuracy = how far start→target the crosshair got at click time
   *     (0% = still at the start point, 100% = on the target).
   */
  _measureFlickClick(t) {
    const pf = this._pendingFlick;
    if (!pf) return;
    this._pendingFlick = null;

    const dtTicks = t - pf.startTick;
    if (dtTicks > 0) {
      this._flickSpeedSumMs += dtTicks * MS_PER_TICK;
      this._flickSpeedCount++;
    }

    const closest = this.closestAt(t);
    if (!closest) return;
    const targetDir = normalize(
      sub([closest.aim.x, closest.aim.y, closest.aim.z], closest.camPos)
    );
    const clickDir = this._camDir(t);
    const dStart = angleBetween(pf.startDir, targetDir); // start → target span
    const dClick = angleBetween(clickDir, targetDir); // click → target remaining
    if (dStart <= 1e-6) return;
    const acc = Math.max(0, Math.min(1, 1 - dClick / dStart)) * 100;
    this._flickAccSum += acc;
    this._flickAccCount++;
  }

  /**
   * Click timing: compare the crosshair to the closest target a few ticks
   * around the shot. On target → accurate. Off now but on within 2 ticks →
   * early (it would have landed). On target recently but off now → late.
   */
  _classifyClick(t) {
    this._measureFlickClick(t);
    if (this._onTargetAt(t)) {
      this.clicks.accurate++;
      return;
    }
    for (let k = 1; k <= 2; k++) {
      if (this._onTargetAt(t + k)) {
        this.clicks.early++;
        this.clicks.earlyMs += k * MS_PER_TICK;
        return;
      }
    }
    for (let k = 1; k <= 3; k++) {
      if (this._onTargetAt(t - k)) {
        this.clicks.late++;
        this.clicks.lateMs += k * MS_PER_TICK;
        return;
      }
    }
    // A click nowhere near a target fits no timing bucket — ignored.
  }

  // ---- public API ----------------------------------------------------------

  get tensionPct() {
    if (!this._tensionCount) return 0;
    return (this._tensionSum / this._tensionCount) * 100;
  }

  /** Average ms from flick start to its first click (0 when none measured). */
  get flickSpeedMs() {
    if (!this._flickSpeedCount) return 0;
    return this._flickSpeedSumMs / this._flickSpeedCount;
  }

  /** Average first-click placement along start→target, 0–100% (0 when none). */
  get flickAccuracyPct() {
    if (!this._flickAccCount) return 0;
    return this._flickAccSum / this._flickAccCount;
  }

  /**
   * Live snapshot for the current (possibly fractional) tick. Advances internal
   * counters to floor(tickFloat) and returns instantaneous overlay data plus
   * the running tallies for the stats panel.
   */
  sampleTick(tickFloat) {
    this._advanceTo(tickFloat);
    const closest = this.closestAt(tickFloat);
    const camNow = this.replay.sampleCamera(tickFloat);
    const camPrev = this.replay.sampleCamera(Math.max(0, tickFloat - 1));
    return {
      target: closest
        ? { x: closest.aim.x, y: closest.aim.y, z: closest.aim.z, radius: closest.aim.radius }
        : null,
      onTarget: this._onTarget(closest),
      // Crosshair angular motion this tick, in screen-friendly deltas.
      moveDir: { yaw: camNow.yaw - camPrev.yaw, pitch: camNow.pitch - camPrev.pitch },
      flickActive: !!this._flick,
      flicks: { ...this.flicks },
      clicks: { ...this.clicks },
      tensionPct: this.tensionPct,
      flickSpeedMs: this.flickSpeedMs,
      flickAccuracyPct: this.flickAccuracyPct,
      flicksMeasured: this._flickSpeedCount
    };
  }

  /** Full-track pass for persistence. Resets, folds every tick, returns totals. */
  aggregate() {
    this.reset();
    if (this.totalTicks > 0) this._advanceTo(this.totalTicks - 1);
    // Make sure trailing shots after the last processed tick are counted.
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
      flick_speed_ms: Math.round(this.flickSpeedMs * 10) / 10,
      flick_accuracy_pct: Math.round(this.flickAccuracyPct * 10) / 10,
      flicks_measured: this._flickSpeedCount
    };
  }
}

export default ReplayAnalytics;

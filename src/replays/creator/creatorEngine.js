// ---------------------------------------------------------------------------
// replays/creator/creatorEngine.js
// The simulation behind the 2D Strategy Creator.
//
// One body is under the mouse and keyboard; every previously recorded body
// plays back alongside it, so a round is built one pass at a time the way a
// team walks a strat. Movement runs through the SAME Source functions the 3D
// trainer uses (utils/SourceMovement.js) at a 220 u/s cap, so a recorded run
// accelerates and stops exactly like a player rather than sliding on rails.
//
// Collision is the painted vision-block layer: those pieces are the map's
// walls as far as the 2D radar is concerned. Holding the noclip bind lifts the
// check, because a strat sometimes has to cross a wall the paint does not know
// about.
// ---------------------------------------------------------------------------

import { srcAccelerate, srcFriction, UNIT } from '../../utils/SourceMovement.js';
import { createFrameLoop } from './frameLoop.js';
import {
  MOVE_SPEED_UNITS,
  SAMPLE_MS,
  emptyTrack,
  makeNade,
  normalizeYaw,
  pushSample
} from './recordingFormat.js';
import { DEFAULT_BINDS, UTIL_ACTION_TYPES } from './creatorBinds.js';

/** Physics step. Fixed, so a slow frame cannot change how far a body travels. */
const STEP_MS = 1000 / 128;

/** Seconds counted down before recording starts. */
export const COUNTDOWN_SECONDS = 3;

/** Radius used when pushing a body out of a wall, in world units. */
const BODY_RADIUS = 16;

const MOVE_SPEED_MS = MOVE_SPEED_UNITS * UNIT;

/**
 * @param {{
 *   blockedAt?: (x: number, y: number) => boolean,
 *   onFrame?: (state: object) => void,
 *   onFinish?: (track: object) => void,
 *   selfDriven?: boolean,
 *   binds?: import('./creatorBinds.js').CreatorBinds
 * }} deps
 *   `selfDriven: false` leaves the clock to the caller through `advance(ms)`,
 *   which is what lets the movement model be tested without a display.
 */
export function createCreatorEngine({
  blockedAt = null,
  onFrame = null,
  onFinish = null,
  selfDriven = true,
  binds = null
} = {}) {
  /** @type {'idle'|'countdown'|'recording'|'playing'} */
  let mode = 'idle';
  let lastFrameAt = 0;
  let accumulator = 0;

  /** Milliseconds since the round started (negative during the countdown). */
  let clock = 0;
  let sampleDue = 0;

  /** @type {object|null} the track being written */
  let track = null;
  /** Velocity in m/s, named x/z to match the shared Source mover. */
  const vel = { x: 0, z: 0 };
  const pos = { x: 0, y: 0 };
  let yaw = 0;

  /** Which grenade is in hand, or '' for a gun. */
  let equipped = '';

  /** Physical key/mouse codes currently held. */
  const keys = new Set();
  let noclip = false;

  /** @type {import('./creatorBinds.js').CreatorBinds} */
  let keyBinds = { ...DEFAULT_BINDS, ...(binds || {}) };

  /** @type {{x: number, y: number}} cursor in world units */
  const cursor = { x: 0, y: 0 };

  const held = (action) => keys.has(keyBinds[action]);

  const state = () => ({
    mode,
    clock,
    countdown: mode === 'countdown' ? Math.ceil(-clock / 1000) : 0,
    pos: { ...pos },
    yaw,
    equipped,
    noclip,
    track
  });

  // ---- movement -----------------------------------------------------------

  /**
   * WASD is screen-fixed on the radar: W up, S down, A left, D right.
   * World Y grows north (screen up); world X grows east (screen right).
   */
  function wishDirection() {
    let x = 0;
    let y = 0;
    if (held('moveUp')) y += 1;
    if (held('moveDown')) y -= 1;
    if (held('moveRight')) x += 1;
    if (held('moveLeft')) x -= 1;
    if (!x && !y) return null;
    const len = Math.hypot(x, y);
    return { x: x / len, y: y / len };
  }

  const solid = (x, y) => Boolean(blockedAt && !noclip && blockedAt(x, y));

  /**
   * Move, then slide. A blocked diagonal keeps whichever axis is clear, which
   * is what stops a body sticking to every corner it brushes.
   */
  function stepPosition(dx, dy) {
    if (!dx && !dy) return;
    const nx = pos.x + dx;
    const ny = pos.y + dy;
    if (!solidBody(nx, ny)) {
      pos.x = nx;
      pos.y = ny;
      return;
    }
    if (!solidBody(nx, pos.y)) {
      pos.x = nx;
      vel.z = 0;
      return;
    }
    if (!solidBody(pos.x, ny)) {
      pos.y = ny;
      vel.x = 0;
      return;
    }
    vel.x = 0;
    vel.z = 0;
  }

  /** The body is a disc, so a wall stops it before its centre is inside one. */
  function solidBody(x, y) {
    if (!blockedAt || noclip) return false;
    if (solid(x, y)) return true;
    const r = BODY_RADIUS;
    return (
      solid(x + r, y) ||
      solid(x - r, y) ||
      solid(x, y + r) ||
      solid(x, y - r)
    );
  }

  function physics(dtMs) {
    const dt = dtMs / 1000;
    const wish = wishDirection();
    srcFriction(vel, dt, wish ? MOVE_SPEED_MS : 0);
    if (wish) srcAccelerate(vel, wish.x, wish.y, MOVE_SPEED_MS, dt);
    // Velocity is metres per second; the map is in units.
    stepPosition((vel.x * dt) / UNIT, (vel.z * dt) / UNIT);
  }

  // ---- loop ---------------------------------------------------------------

  function tick(now) {
    // Clamped: a stalled tab must not advance the round by however long the
    // user was away. The pass simply pauses while nothing is being drawn.
    const dt = Math.min(100, now - lastFrameAt);
    lastFrameAt = now;

    if (mode === 'countdown') {
      clock += dt;
      if (clock >= 0) {
        clock = 0;
        mode = 'recording';
        // Samples are evenly spaced from t0, so the first one lands exactly at
        // the moment the countdown ends.
        sampleDue = SAMPLE_MS;
        if (track) pushSample(track, pos.x, pos.y, yaw);
      }
      onFrame?.(state());
      return;
    }

    if (mode !== 'recording' && mode !== 'playing') {
      onFrame?.(state());
      return;
    }

    if (mode === 'recording') {
      accumulator += dt;
      while (accumulator >= STEP_MS) {
        physics(STEP_MS);
        accumulator -= STEP_MS;
        clock += STEP_MS;
        // One sample per interval, even if several physics steps fit inside a
        // frame: the index is the timestamp, so a skipped or doubled sample
        // would shift everything after it.
        while (clock >= sampleDue) {
          pushSample(track, pos.x, pos.y, yaw);
          sampleDue += SAMPLE_MS;
        }
      }
    } else {
      clock += dt;
    }

    onFrame?.(state());
  }

  const loop = selfDriven ? createFrameLoop(tick) : null;

  function start() {
    if (!loop || loop.running()) return;
    lastFrameAt = performance.now();
    loop.start();
  }

  function stop() {
    loop?.stop();
  }

  function equipFromCode(code) {
    for (const [action, type] of Object.entries(UTIL_ACTION_TYPES)) {
      if (keyBinds[action] === code) {
        equipped = equipped === type ? '' : type;
        return true;
      }
    }
    return false;
  }

  // ---- API ----------------------------------------------------------------

  return {
    state,

    /**
     * Step the simulation by hand. The panel never calls this - the frame loop
     * does - but a test can drive an exact number of milliseconds and assert
     * where the body ended up.
     */
    advance(ms) {
      tick((lastFrameAt || 0) + ms);
      return state();
    },

    /** Begin the 3-2-1 into a recording for one spawn. */
    record({ id, side, name, spawn, t0 = 0 }) {
      track = emptyTrack({ id, side, name, spawnId: spawn?.id, t0 });
      pos.x = spawn?.x ?? 0;
      pos.y = spawn?.y ?? 0;
      vel.x = 0;
      vel.z = 0;
      yaw = Number.isFinite(spawn?.yaw) ? spawn.yaw : 0;
      equipped = '';
      clock = -COUNTDOWN_SECONDS * 1000;
      accumulator = 0;
      mode = 'countdown';
      start();
      return state();
    },

    /** Play the round back without recording anything. */
    play() {
      track = null;
      clock = 0;
      mode = 'playing';
      start();
      return state();
    },

    /** End the pass. Returns the finished track, or null when nothing was recorded. */
    finish() {
      const done = mode === 'recording' ? track : null;
      mode = 'idle';
      stop();
      track = null;
      if (done) onFinish?.(done);
      return done;
    },

    /** Abandon the pass, keeping nothing. */
    cancel() {
      mode = 'idle';
      stop();
      track = null;
      return state();
    },

    setCursorWorld(x, y) {
      cursor.x = x;
      cursor.y = y;
      if (mode === 'recording' || mode === 'countdown') {
        yaw = normalizeYaw((Math.atan2(y - pos.y, x - pos.x) * 180) / Math.PI);
      }
    },

    /** Replace the live key map (from settings). */
    setBinds(next) {
      keyBinds = { ...DEFAULT_BINDS, ...(next || {}) };
      noclip = held('noclip');
    },

    getBinds() {
      return { ...keyBinds };
    },

    keyDown(code) {
      keys.add(code);
      if (code === keyBinds.noclip) noclip = true;
      equipFromCode(code);
    },

    keyUp(code) {
      keys.delete(code);
      if (code === keyBinds.noclip) noclip = false;
    },

    /** Put the nade away without toggling a slot. */
    unequip() {
      equipped = '';
    },

    /** Left click / fire bind: throw what is in hand, or fire a single shot. */
    fire() {
      if (mode !== 'recording' || !track) return null;
      if (equipped) {
        const nade = makeNade({
          type: equipped,
          t: clock,
          from: { x: pos.x, y: pos.y },
          to: { x: cursor.x, y: cursor.y }
        });
        track.nades.push(nade);
        // A thrown grenade leaves the hand, exactly like the real thing.
        equipped = '';
        return { kind: 'nade', nade };
      }
      const shot = { t: Math.round(clock), yaw, x: Math.round(pos.x), y: Math.round(pos.y) };
      track.shots.push(shot);
      return { kind: 'shot', shot };
    },

    /** Drop every held key, for when the canvas loses focus mid-run. */
    releaseKeys() {
      keys.clear();
      noclip = false;
    },

    destroy() {
      stop();
      keys.clear();
    }
  };
}

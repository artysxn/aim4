// Run: node src/replays/creator/creatorEngine.test.js
//
// The recording engine is what a strat is actually made of, so its rules are
// asserted rather than eyeballed in a browser: the 220 u/s cap with Source
// ramp-up, the fixed 16 Hz sample spacing, walls that stop a body, space that
// lets it through, and grenades that leave when thrown and land where the
// cursor was.
//
// The engine is stepped by hand (`selfDriven: false`), so none of this depends
// on a display or on requestAnimationFrame.

import { COUNTDOWN_SECONDS, createCreatorEngine } from './creatorEngine.js';
import { MOVE_SPEED_UNITS, SAMPLE_HZ, SAMPLE_MS, sampleCount } from './recordingFormat.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const near = (a, b, tol, what) =>
  assert(Math.abs(a - b) <= tol, `${what}: expected ~${b}, got ${a.toFixed(2)}`);

/** Step in small slices, the way a frame loop would. */
function run(engine, ms, sliceMs = 16) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(sliceMs, left);
    engine.advance(step);
    left -= step;
  }
  return engine.state();
}

const spawn = { id: 'sp1', side: 'T', x: 0, y: 0 };

function fresh(opts = {}) {
  const engine = createCreatorEngine({ selfDriven: false, ...opts });
  engine.record({ id: 'b1', side: 'T', name: 'Body 1', spawn });
  // Burn the countdown; recording starts the moment it hits zero.
  run(engine, COUNTDOWN_SECONDS * 1000 + 20);
  return engine;
}

// ---- the countdown gates recording -----------------------------------------

{
  const engine = createCreatorEngine({ selfDriven: false });
  engine.record({ id: 'b1', side: 'T', name: 'Body 1', spawn });
  let state = engine.state();
  assert(state.mode === 'countdown', 'a pass opens on the countdown');
  assert(state.countdown === COUNTDOWN_SECONDS, `counts from ${COUNTDOWN_SECONDS}`);
  state = run(engine, 1000);
  assert(state.countdown === 2, `one second in it reads 2, got ${state.countdown}`);
  assert(state.mode === 'countdown', 'still counting at one second');
  state = run(engine, 2100);
  assert(state.mode === 'recording', 'recording begins when the countdown ends');
  console.log('  3-2-1 runs before anything is recorded');
}

// ---- movement: the cap, and the Source ramp to it ---------------------------

{
  const engine = fresh();
  // Screen-fixed: D is +x (east) regardless of aim.
  engine.setCursorWorld(0, 1000);
  engine.keyDown('KeyD');
  const after = run(engine, 1000);
  const travelled = after.pos.x;
  // A player accelerating from rest under sv_accelerate 5.5 covers less than a
  // full second at top speed; the cap is what it approaches, not what it averages.
  assert(travelled > 0, 'holding D moves the body right');
  assert(
    travelled < MOVE_SPEED_UNITS,
    `one second from rest stays under the ${MOVE_SPEED_UNITS} u/s cap, got ${travelled.toFixed(1)}`
  );
  near(travelled, 205, 25, 'distance covered in the first second');

  // Another second, now already at speed: this one should be very close to cap.
  const before = after.pos.x;
  const later = run(engine, 1000);
  near(later.pos.x - before, MOVE_SPEED_UNITS, 6, 'distance covered in the second second');
  console.log(
    `  first second covers ${travelled.toFixed(0)} u, second second covers ${(later.pos.x - before).toFixed(0)} u`
  );
}

// ---- movement is screen-fixed, not view-relative ----------------------------

{
  const engine = fresh();
  engine.setCursorWorld(1000, 0); // look east
  engine.keyDown('KeyW');
  const state = run(engine, 500);
  assert(state.pos.y > 40, 'W is screen-up (+y), not toward the cursor');
  assert(Math.abs(state.pos.x) < 1, `no sideways drift, got ${state.pos.x.toFixed(2)}`);
  console.log('  WASD is screen-fixed: W up, A left, S down, D right');
}

// ---- friction brings it to a stop ------------------------------------------

{
  const engine = fresh();
  engine.setCursorWorld(0, 1000);
  engine.keyDown('KeyD');
  run(engine, 800);
  engine.keyUp('KeyD');
  const releasedAt = engine.state().pos.x;
  const stopped = run(engine, 600);
  const slide = stopped.pos.x - releasedAt;
  assert(slide > 0, 'it carries a little momentum');
  // sv_friction 5.2 with sv_stopspeed 80 puts a full-speed stop at roughly a
  // third of a second, which is 30-40 units of slide.
  assert(slide < 45, `friction stops it quickly, slid ${slide.toFixed(1)} units`);
  const afterMore = run(engine, 400);
  near(afterMore.pos.x, stopped.pos.x, 0.01, 'fully stopped');
  console.log(`  releasing the key stops the body inside ${slide.toFixed(0)} units`);
}

// ---- samples are evenly spaced at SAMPLE_HZ --------------------------------

{
  const engine = fresh();
  engine.setCursorWorld(1000, 0);
  engine.keyDown('KeyD');
  run(engine, 1000);
  const track = engine.finish();
  const n = sampleCount(track);
  // One at t=0 plus one per interval for a second.
  near(n, SAMPLE_HZ + 1, 2, 'samples recorded in one second');
  assert(track.samples.length === n * 3, 'each sample is exactly x, y, yaw');
  console.log(`  one second of recording is ${n} samples at ${SAMPLE_HZ} Hz`);
}

// ---- walls stop a body, space lets it through -------------------------------

{
  // A wall across x = 100.
  const wall = (x) => x >= 100 && x <= 400;
  const engine = fresh({ blockedAt: (x) => wall(x) });
  engine.setCursorWorld(0, 1000);
  engine.keyDown('KeyD');
  const blocked = run(engine, 1500);
  assert(
    blocked.pos.x < 100,
    `a painted vision block stops the body, reached ${blocked.pos.x.toFixed(1)}`
  );

  // Space lifts the check, which is how a strat crosses paint that is not a wall.
  // From a standstill against the wall it needs a moment to cover the 300 units
  // of paint, so this runs long enough to come out the far side.
  engine.keyDown('Space');
  const through = run(engine, 2500);
  assert(through.pos.x > 400, `space carries it through, reached ${through.pos.x.toFixed(1)}`);
  engine.keyUp('Space');
  console.log('  vision blocks stop a body, and space walks through them');
}

// ---- a blocked diagonal slides instead of sticking --------------------------

{
  const engine = fresh({ blockedAt: (x) => x >= 100 });
  engine.setCursorWorld(0, 1000);
  // Into the wall (+x) and along it (+y).
  engine.keyDown('KeyD');
  engine.keyDown('KeyW');
  const state = run(engine, 1200);
  assert(state.pos.x < 100, 'the wall still holds on x');
  assert(state.pos.y > 100, `it slides along the wall instead of sticking, y = ${state.pos.y.toFixed(1)}`);
  console.log('  a body brushing a wall slides along it');
}

// ---- grenades ---------------------------------------------------------------

{
  const engine = fresh();
  engine.setCursorWorld(600, 0);
  run(engine, 200);

  // No grenade in hand: a click is a shot.
  const shot = engine.fire();
  assert(shot?.kind === 'shot', 'clicking with a gun out fires a shot');

  engine.keyDown('Digit2'); // smoke
  assert(engine.state().equipped === 'smokegrenade', 'number keys equip utility');
  engine.keyDown('Digit2');
  assert(engine.state().equipped === '', 'the same key puts it away again');

  engine.keyDown('Digit1'); // flash
  const thrown = engine.fire();
  assert(thrown?.kind === 'nade', 'clicking with utility out throws it');
  const nade = thrown.nade;
  assert(nade.type === 'flashbang', 'it throws what is in hand');
  assert(nade.to.x === 600 && nade.to.y === 0, 'it detonates exactly where the cursor was');
  // 600 units at 300 u/s is two seconds of flight.
  near(nade.detonateT - nade.t, 2000, 40, 'flight time at 300 u/s');
  assert(engine.state().equipped === '', 'throwing empties the hand');

  const track = engine.finish();
  assert(track.nades.length === 1, 'the throw is on the track');
  assert(track.shots.length === 1, 'the shot is on the track');
  console.log('  1-4 equip, click throws to the cursor at 300 u/s, and a bare click shoots');
}

// ---- rebinds swap physical keys without changing the actions ----------------

{
  const engine = fresh({
    binds: {
      moveUp: 'KeyI',
      moveDown: 'KeyK',
      moveLeft: 'KeyJ',
      moveRight: 'KeyL',
      noclip: 'KeyN',
      fire: 'KeyF',
      util1: 'Digit1',
      util2: 'Digit2',
      util3: 'Digit3',
      util4: 'Digit4'
    }
  });
  engine.keyDown('KeyW');
  const idle = run(engine, 400);
  assert(Math.abs(idle.pos.y) < 1 && Math.abs(idle.pos.x) < 1, 'unbound W does nothing');
  engine.keyUp('KeyW');
  engine.keyDown('KeyI');
  const moved = run(engine, 400);
  assert(moved.pos.y > 20, 'rebound move-up key still walks north');
  engine.keyDown('KeyN');
  assert(engine.state().noclip, 'rebound noclip key works');
  console.log('  setBinds remaps movement and noclip');
}

// ---- a discarded pass keeps nothing -----------------------------------------

{
  const engine = fresh();
  engine.keyDown('KeyW');
  run(engine, 500);
  engine.cancel();
  assert(engine.state().mode === 'idle', 'cancelling ends the pass');
  assert(engine.finish() === null, 'a cancelled pass produces no track');
  console.log('  discarding a pass throws the recording away');
}

// ---- a stalled tab does not fast-forward the round --------------------------

{
  const engine = fresh();
  engine.setCursorWorld(1000, 0);
  engine.keyDown('KeyD');
  // One huge advance mimics a tab that slept for a long time.
  engine.advance(5000);
  const pos = engine.state().pos.x;
  assert(pos < MOVE_SPEED_UNITS * 0.2, `a stalled frame is clamped, moved ${pos.toFixed(1)}`);
  console.log('  a stalled tab cannot skip the body across the map');
}

console.log('creatorEngine tests passed');

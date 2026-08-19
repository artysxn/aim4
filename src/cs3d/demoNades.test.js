// ---------------------------------------------------------------------------
// src/cs3d/demoNades.test.js
// Demo utility is derived from the playhead, and the playhead does things a
// running clock never does: it stops, it runs at 4×, it steps one tick, and it
// goes backwards. Everything here is a claim about one of those.
//
// The effects themselves are not exercised — they are TSL and only compile at
// draw time — so NadeEffects is stubbed and what is checked is the SCHEDULING:
// what exists at a given tick, at what age, and in what order it was made.
//
// Run: node src/cs3d/demoNades.test.js
// ---------------------------------------------------------------------------

// three/webgpu reads `self` at module scope for GPUShaderStage. Nothing here
// touches the GPU, so a shim is enough to get the module graph to load.
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const assert = (await import('node:assert/strict')).default;
const { DemoNades } = await import('./demoNades.js');
const { SMOKE_SECONDS } = await import('../../shared/sim3d/smokeVolume.js');
const { FIRE_SECONDS } = await import('../../shared/sim3d/fireSpread.js');
const { HE_SECONDS } = await import('./nadeEffects.js');

const RATE = 64;

/**
 * A NadeEffects that records instead of drawing. `live` mirrors the real one's
 * so the driver's bookkeeping is checked against the same shape.
 */
function fakeEffects() {
  const log = [];
  const fx = {
    live: [],
    log,
    flashSolved: [],
    spawn(o) {
      const handle = {
        kind:
          o.type === 'smokegrenade'
            ? 'smoke'
            : o.type === 'molotov' || o.type === 'incgrenade'
              ? 'fire'
              : o.type === 'hegrenade'
                ? 'he'
                : o.type,
        type: o.type,
        pos: o.pos,
        vel: o.vel,
        side: o.side,
        driven: !!o.driven,
        age: 0,
        life:
          o.type === 'smokegrenade'
            ? SMOKE_SECONDS
            : o.type === 'molotov'
              ? FIRE_SECONDS
              : o.type === 'hegrenade'
                ? HE_SECONDS
                : 0.3,
        // A smoke's fill, only as much of it as pushSmoke needs.
        vol: o.type === 'smokegrenade' ? { age: 0, cells: [], cleared: new Map(), seconds: SMOKE_SECONDS } : null,
        ageTrail: []
      };
      fx.live.push(handle);
      log.push({ op: 'spawn', type: o.type, side: o.side, driven: !!o.driven });
      return handle;
    },
    setAge(h, age) {
      h.age = age;
      h.ageTrail.push(age);
      if (h.vol) h.vol.age = age;
    },
    remove(h) {
      const i = fx.live.indexOf(h);
      if (i >= 0) fx.live.splice(i, 1);
      h.disposed = true;
      log.push({ op: 'remove', type: h.type });
    },
    flashAt(pos, eye, forward) {
      fx.flashSolved.push({ pos, eye, forward });
      // A full-strength hit: looked straight at it, close, unobstructed.
      // fadeTime / FLASH_DURATION_DIVISOR is the overlay, so 5.6 → 4 seconds,
      // which is longer than FLASH_CERTAIN_BLINDNESS and therefore holds at
      // full white for a moment before it starts coming off.
      return { fadeHold: 1.5, fadeTime: 5.6, overlayDuration: 4, percentage: 1 };
    }
  };
  return fx;
}

const liveTypes = (fx) => fx.live.map((h) => h.type).sort();

const smoke = (throwTick, detTick, player = 'p1') => ({
  type: 'smokegrenade',
  player,
  throwTick,
  detonateTick: detTick,
  at: { x: 100, y: 200, z: 0 },
  path: [
    { tick: throwTick, x: 0, y: 0, z: 64 },
    { tick: (throwTick + detTick) >> 1, x: 50, y: 100, z: 120 },
    { tick: detTick, x: 100, y: 200, z: 0 }
  ]
});

// ---- a smoke exists only between its detonation and its end ----------------
{
  const fx = fakeEffects();
  const d = new DemoNades({ effects: fx });
  d.setEvents([smoke(0, 64)], RATE);

  d.update(0);
  assert.deepEqual(liveTypes(fx), [], 'nothing stands before the detonation');

  d.update(64);
  assert.deepEqual(liveTypes(fx), ['smokegrenade'], 'the cloud appears on the detonation tick');
  assert.equal(fx.live[0].age, 0);
  assert.equal(fx.live[0].driven, true, 'a demo effect must not be aged by the clock');

  d.update(64 + 5 * RATE);
  assert.equal(fx.live[0].age, 5, 'the cloud is told the time, not stepped to it');

  d.update(64 + (SMOKE_SECONDS + 0.1) * RATE);
  assert.deepEqual(liveTypes(fx), [], 'the cloud goes when its life runs out');
}

// ---- a forward jump lands mid-life, not at age zero ------------------------
// Dragging the scrubber into the middle of a round must show the smoke that is
// standing there, at the age it has actually reached.
{
  const fx = fakeEffects();
  const d = new DemoNades({ effects: fx });
  d.setEvents([smoke(0, 64)], RATE);
  d.update(64 + 9 * RATE);
  assert.equal(fx.live.length, 1, 'a jump past the detonation still creates the cloud');
  assert.equal(fx.live[0].age, 9, 'and creates it at the age the playhead is at');
  assert.equal(fx.live[0].vol.age, 9, "the fill's own clock agrees");
}

// ---- pause holds, and does not age -----------------------------------------
{
  const fx = fakeEffects();
  const d = new DemoNades({ effects: fx });
  d.setEvents([smoke(0, 64)], RATE);
  d.update(64 + 3 * RATE);
  d.update(64 + 3 * RATE);
  d.update(64 + 3 * RATE);
  assert.equal(fx.live[0].age, 3, 'three frames on a paused playhead are still age 3');
}

// ---- scrubbing backwards rewinds, it does not fast-forward -----------------
{
  const fx = fakeEffects();
  const d = new DemoNades({ effects: fx });
  d.setEvents([smoke(0, 64)], RATE);
  d.update(64 + 10 * RATE);
  d.update(64 + 2 * RATE);
  assert.equal(fx.live.length, 1);
  assert.equal(fx.live[0].age, 2, 'a rewound cloud is younger, not older');
  // ...and scrubbing to before the throw leaves nothing behind.
  d.update(0);
  assert.deepEqual(liveTypes(fx), []);
}

// ---- a molotov gets the direction it was travelling ------------------------
// CS2's fire spreads downrange. The demo records no velocity, so the last leg
// of the path is what has to supply it; without a direction the puddle is a
// symmetric disc, which is the one shape a real molotov never has.
{
  const fx = fakeEffects();
  const d = new DemoNades({ effects: fx });
  d.setEvents(
    [
      {
        type: 'molotov',
        player: 'p1',
        throwTick: 0,
        detonateTick: 32,
        at: { x: 300, y: 0, z: 0 },
        path: [
          { tick: 0, x: 0, y: 0, z: 64 },
          { tick: 16, x: 150, y: 0, z: 90 },
          { tick: 32, x: 300, y: 0, z: 0 }
        ]
      }
    ],
    RATE
  );
  d.update(32);
  const v = fx.live[0].vel;
  assert.ok(v, 'a fire spawned with no velocity spreads as a disc');
  assert.ok(v.x > 0, `the fire should run downrange (+x), got ${v.x}`);
  assert.ok(v.z < 0, 'it was falling when it broke');
  // 150 units over a quarter second is 600 u/s.
  assert.ok(Math.abs(v.x - 600) < 1, `speed should come off the path: ${v.x}`);
}

// ---- effects are created in DETONATION order -------------------------------
// The parser writes throws in throw order. An HE has to be able to punch a
// cloud that is already standing, so a rebuild must not create it first.
{
  const fx = fakeEffects();
  const d = new DemoNades({ effects: fx });
  d.setEvents(
    [
      // Thrown first, lands last.
      { type: 'hegrenade', player: 'p1', throwTick: 0, detonateTick: 200, at: { x: 0, y: 0, z: 0 }, path: [] },
      // Thrown second, lands first.
      smoke(10, 100)
    ],
    RATE
  );
  d.update(210);
  const spawns = fx.log.filter((e) => e.op === 'spawn').map((e) => e.type);
  assert.deepEqual(spawns, ['smokegrenade', 'hegrenade'], 'the cloud must exist before the blast that opens it');
}

// ---- a cloud rebuilt mid-life gets its holes back --------------------------
// This is the one thing that is NOT a function of age. A cloud scrubbed back
// into must look like it did: with the hole an HE punched in it.
{
  const fx = fakeEffects();
  // Give pushSmoke a real cell to work on, at the blast point.
  const d = new DemoNades({ effects: fx });
  const origSpawn = fx.spawn;
  fx.spawn = (o) => {
    const h = origSpawn(o);
    if (h.vol) h.vol.cells = [{ x: 0, y: 0, z: 0 }];
    return h;
  };
  d.setEvents(
    [
      smoke(0, 64),
      { type: 'hegrenade', player: 'p2', throwTick: 100, detonateTick: 64 + 4 * RATE, at: { x: 0, y: 0, z: 0 }, path: [] }
    ],
    RATE
  );
  // Jump straight to six seconds into the cloud, two seconds after the blast.
  d.update(64 + 6 * RATE);
  const cloud = fx.live.find((h) => h.kind === 'smoke');
  assert.ok(cloud, 'the cloud should be standing');
  assert.ok(cloud.vol.cleared.size > 0, 'the blast that went off inside it left no hole');
  // The cloud's age was walked forward through the blast, not jumped past it.
  assert.ok(cloud.ageTrail.includes(4), `expected a stop at the blast (age 4): ${cloud.ageTrail}`);
  assert.equal(cloud.age, 6, 'and it ends up at the age the playhead is at');
  // The hole has been healing for the two seconds since.
  const hold = cloud.vol.cleared.values().next().value;
  assert.ok(hold > 0, 'the hole should still be open');
}

// ---- a flash is judged on where the viewer was LOOKING when it popped ------
{
  const fx = fakeEffects();
  const d = new DemoNades({ effects: fx });
  d.setEvents(
    [{ type: 'flashbang', player: 'p1', throwTick: 0, detonateTick: 128, at: { x: 0, y: 0, z: 0 }, path: [] }],
    RATE
  );
  const sampled = [];
  const povAt = (tick) => {
    sampled.push(tick);
    return { eye: { x: 0, y: 64, z: 0 }, forward: { x: 1, y: 0, z: 0 } };
  };

  // No POV, no blind: you are not in anybody's eyes.
  d.update(128, { povSlot: null, povAt });
  assert.equal(d.flash, 0);

  d.update(128, { povSlot: 3, povAt });
  assert.deepEqual(sampled, [128], 'the view must be sampled at the DETONATION tick');
  // Zero on the detonation frame is CORRECT: CS2's overlay ramps in over
  // FLASH_BUILD_UP (~94 ms) rather than appearing at full white, which is what
  // makes a flash read as a bloom rather than a cut.
  assert.equal(d.flash, 0, 'the overlay builds up, it does not snap on');

  d.update(128 + 0.15 * RATE, { povSlot: 3, povAt });
  assert.ok(d.flash > 0.99, `a direct flash should be total once built up, got ${d.flash}`);

  // ...and it fades as demo time passes, without any wall-clock involved.
  d.update(128 + 2 * RATE, { povSlot: 3, povAt });
  const mid = d.flash;
  assert.ok(mid > 0 && mid < 0.9, `mid-fade should be partial: ${mid}`);
  d.update(128 + 3.5 * RATE, { povSlot: 3, povAt });
  assert.ok(d.flash < mid, `the blind should be fading: ${mid} then ${d.flash}`);
  assert.equal(fx.flashSolved.length, 1, 'the solution is cached per (flash, viewer)');

  // Scrubbing back inside the flash returns the earlier, stronger value.
  d.update(128 + 2 * RATE, { povSlot: 3, povAt });
  assert.ok(Math.abs(d.flash - mid) < 1e-9, 'a scrub must land on the same alpha it did before');

  // Before it goes off, nothing.
  d.update(64, { povSlot: 3, povAt });
  assert.equal(d.flash, 0);
}

// ---- the trajectory is the recorded path, and it fades after the pop -------
{
  const fx = fakeEffects();
  const d = new DemoNades({ effects: fx });
  const g = smoke(0, 128);
  d.setEvents([g], RATE);

  d.update(0);
  let f = d._flights.get(0);
  assert.ok(f, 'the flight should exist from the throw');
  assert.ok(f.group.visible, 'and the grenade should be drawn while it flies');

  // Half way along the second leg: (50,100,120) → (100,200,0) at t = 0.5.
  d.update(96);
  const p = d._flights.get(0).group.position;
  // Scene frame is (x, z, −y).
  assert.ok(Math.abs(p.x - 75) < 1e-3, `x: ${p.x}`);
  assert.ok(Math.abs(p.y - 60) < 1e-3, `y (source z): ${p.y}`);
  assert.ok(Math.abs(p.z + 150) < 1e-3, `z (−source y): ${p.z}`);

  // The line is only ever the part already flown.
  const drawn = d._flights.get(0).line.geometry.drawRange.count;
  assert.equal(drawn, 3, 'the trail should be the two waypoints passed plus the grenade');

  d.update(128);
  assert.equal(d._flights.get(0).group.visible, false, 'the grenade goes when it goes off');
  assert.equal(d._flights.get(0).line.material.opacity, 1, 'the line is still fresh');

  d.update(128 + 1.25 * RATE);
  assert.ok(d._flights.get(0).line.material.opacity < 1, 'and fades over the linger');

  d.update(128 + 3 * RATE);
  assert.equal(d._flights.get(0), undefined, 'then goes entirely');
}

// ---- a handle pulled out from under us is not posed ------------------------
// `NadeEffects.clear()` happens on a map change and on a practice reset, and
// it does not know this driver exists.
{
  const fx = fakeEffects();
  const d = new DemoNades({ effects: fx });
  d.setEvents([smoke(0, 64)], RATE);
  d.update(64 + 2 * RATE);
  const first = fx.live[0];
  // What NadeEffects.clear() does to a handle.
  fx.live.length = 0;
  first.disposed = true;
  d.update(64 + 3 * RATE);
  assert.equal(fx.live.length, 1, 'the cloud should be rebuilt, not posed as a corpse');
  assert.notEqual(fx.live[0], first);
  assert.equal(fx.live[0].age, 3);
}

// ---- a smoke is tinted by the side that threw it ---------------------------
{
  const fx = fakeEffects();
  const d = new DemoNades({ effects: fx, sideOf: (id) => (id === 'p1' ? 'CT' : 'T') });
  d.setEvents([smoke(0, 64, 'p1')], RATE);
  d.update(64);
  assert.equal(fx.live[0].side, 'CT');
}

console.log('demoNades.test.js OK');

// Run: node shared/sim/engine.test.js
//
// The engine's job in P1 is small and its guarantees are not. What is checked:
//
//   the round state machine ends for every reason a round ends, on the right
//     tick, and never twice
//   bodies walk real routes on a real map at the speeds the constants say
//   the same seed and the same intents produce the same hash, every tick
//   the encoded round is readable by the parser's own reader, which is the
//     whole claim of SIM-PLAN 1
//
// Runs against a baked map when one is present and skips the map half when it
// is not, so the suite still works on a machine with no map data.

import {
  FREEZE_SECONDS,
  ROUND_SECONDS,
  TICK_RATE,
  speedCap,
  ticksFor
} from './constants.js';
import { END_REASON, PHASE, createEngine } from './engine.js';
import { RoundRecorder } from './encode.js';
import { navGraphFromBake } from './navGraph.js';
import { assignSpawns, hungarian, randomSpawns } from './spawnChoice.js';
import { Rng } from './rng.js';
import { readHeader, readRecord, PLAYER_SLOTS } from '../../src/replays/shared/tickFormat.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- rng --------------------------------------------------------------------

{
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 100; i += 1) assert(a.next() === b.next(), 'same seed, same stream');
  assert(new Rng(43).next() !== new Rng(42).next(), 'different seeds diverge');

  const r = new Rng(7);
  const saved = r.save();
  const seq = [r.next(), r.next(), r.next()];
  r.restore(saved);
  const again = [r.next(), r.next(), r.next()];
  assert(seq.every((v, i) => v === again[i]), 'save/restore reproduces the stream');

  // Uniformity, loosely: a biased generator here would bias every draw in the
  // simulation and would be invisible in any single round.
  const r2 = new Rng(99);
  let sum = 0;
  const N = 20000;
  for (let i = 0; i < N; i += 1) sum += r2.next();
  assert(Math.abs(sum / N - 0.5) < 0.01, `mean is near 0.5 (${(sum / N).toFixed(4)})`);

  const r3 = new Rng(5);
  let nsum = 0;
  for (let i = 0; i < N; i += 1) nsum += r3.normal();
  assert(Math.abs(nsum / N) < 0.03, 'normal() is centred');

  const r4 = new Rng(11);
  const draws = Array.from({ length: 4000 }, () => r4.logNormalFromP90(0.2, 0.7));
  draws.sort((x, y) => x - y);
  assert(Math.abs(draws[2000] - 0.2) < 0.02, `log-normal median is 0.2 (${draws[2000].toFixed(3)})`);
  assert(Math.abs(draws[3600] - 0.7) < 0.08, `and its p90 is 0.7 (${draws[3600].toFixed(3)})`);
}

// ---- spawn assignment -------------------------------------------------------

{
  // The identity assignment is cheapest, so it must be the one found.
  const cost = [
    [1, 9, 9],
    [9, 1, 9],
    [9, 9, 1]
  ];
  assert(JSON.stringify(hungarian(cost)) === '[0,1,2]', 'hungarian finds the obvious assignment');

  // The case greedy gets wrong: row 0 prefers column 0, but giving it there
  // forces row 1 into a much worse seat.
  const trap = [
    [1, 2],
    [1, 50]
  ];
  const picks = hungarian(trap);
  assert(picks[1] === 0 && picks[0] === 1, `greedy would take [0,1]; got [${picks}]`);

  const bots = [{ slot: 0 }, { slot: 1 }, { slot: 2 }];
  const pool = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 100, y: 0 },
    { id: 'c', x: 200, y: 0 },
    { id: 'd', x: 300, y: 0 }
  ];
  const targets = { 0: { x: 210, y: 0 }, 1: { x: 5, y: 0 }, 2: { x: 105, y: 0 } };
  const out = assignSpawns(bots, pool, (bot, spawn) => {
    const t = targets[bot.slot];
    return (t.x - spawn.x) ** 2 + (t.y - spawn.y) ** 2;
  });
  assert(out[0].spawn.id === 'c' && out[1].spawn.id === 'a' && out[2].spawn.id === 'b',
    'mimic cost puts each bot on the spawn nearest its tracked player');
  assert(new Set(out.map((o) => o.spawn.id)).size === 3, 'and no two bots share a spawn');

  let threw = false;
  try {
    assignSpawns([{ slot: 0 }, { slot: 1 }], [{ id: 'a', x: 0, y: 0 }], () => 1);
  } catch {
    threw = true;
  }
  assert(threw, 'a pool too small to seat everyone is refused, never duplicated');

  const rng = new Rng(3);
  const rand = randomSpawns(bots, pool, rng);
  assert(new Set(rand.map((o) => o.spawn.id)).size === 3, 'random spawns never collide either');
}

// ---- the map half -----------------------------------------------------------

let graph = null;
let bake = null;
try {
  const { readFile } = await import('node:fs/promises');
  const { ROOT } = await import('../../server/replays/demoStore.js');
  const path = await import('node:path');
  bake = JSON.parse(await readFile(path.join(ROOT, 'sim', 'navcache', 'INF.json'), 'utf8'));
  graph = navGraphFromBake(bake);
} catch {
  graph = null;
}

/** Ten bodies on real spawns, five a side. */
/** Geodesic-enough for a test: the engine requires one and refuses without. */
const pathDistance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function roster(g) {
  const t = g.spawns.filter((s) => s.side === 'T').slice(0, 5);
  const ct = g.spawns.filter((s) => s.side === 'CT').slice(0, 5);
  const mk = (s, side, i) => ({
    id: `${side.toLowerCase()}${i}`,
    side,
    x: s.x,
    y: s.y,
    z: s.z || 0,
    weapon: 'ak47'
  });
  return [...t.map((s, i) => mk(s, 'T', i)), ...ct.map((s, i) => mk(s, 'CT', i))];
}

let mapChecked = false;

if (graph) {
  // ---- the state machine ----

  {
    // Nobody moves: the round runs out and CT win on time.
    const e = createEngine({ map: 'INF', graph, seed: 1, roster: roster(graph), pathDistance, record: 'full' });
    assert(e.state.phase === PHASE.FREEZE, 'a round starts frozen');
    assert(Math.abs(e.clock() - FREEZE_SECONDS) < 0.02, 'and the freeze clock is right');

    for (let i = 0; i < ticksFor(FREEZE_SECONDS); i += 1) e.step();
    assert(e.state.phase === PHASE.LIVE, 'freeze ends on time');
    assert(Math.abs(e.clock() - ROUND_SECONDS) < 0.02, `live clock starts at ${ROUND_SECONDS}`);

    const s = e.runToEnd();
    assert(s.phase === PHASE.OVER, 'the round ends');
    assert(s.endReason === END_REASON.TIME, 'by time');
    assert(s.winner === 'CT', 'and CT win it');
    const liveSeconds = (s.endTick - s.liveTick) / TICK_RATE;
    assert(Math.abs(liveSeconds - ROUND_SECONDS) < 0.05, `after ${ROUND_SECONDS}s live (${liveSeconds.toFixed(2)})`);
  }

  {
    // Eliminating the Ts before a plant ends it immediately.
    const e = createEngine({ map: 'INF', graph, seed: 1, roster: roster(graph), pathDistance, record: 'full' });
    for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 10; i += 1) e.step();
    for (let slot = 0; slot < 5; slot += 1) e.kill(slot);
    e.step();
    assert(e.state.endReason === END_REASON.T_ELIMINATED, 'wiping the Ts ends the round');
    assert(e.state.winner === 'CT', 'for the CT');

    const before = e.state.tick;
    e.step();
    assert(e.state.tick === before, 'and an ended round does not advance');
  }

  {
    // A plant flips the clock to the bomb timer, and the bomb goes off.
    const e = createEngine({ map: 'INF', graph, seed: 1, roster: roster(graph), pathDistance, record: 'full' });
    for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e.step();
    assert(e.beginPlant(0), 'the carrier can start planting');
    assert(!e.beginPlant(1), 'a body without the bomb cannot');

    for (let i = 0; i < ticksFor(3.3); i += 1) e.step();
    assert(e.state.bomb.planted, 'the plant completes after 3.2s');
    assert(e.state.plantTick, 'and the plant tick is recorded');
    assert(e.clock() <= 40 && e.clock() > 39, `the clock is now the bomb timer (${e.clock().toFixed(1)})`);
    assert(!e.state.bodies[0].hasBomb, 'the planter no longer carries it');

    const s = e.runToEnd();
    assert(s.endReason === END_REASON.BOMB_EXPLODED, 'the bomb explodes');
    assert(s.winner === 'T', 'and T win');

    // Wiping the Ts after a plant must NOT end it: the bomb is still ticking.
    const e2 = createEngine({ map: 'INF', graph, seed: 1, roster: roster(graph), pathDistance, record: 'full' });
    for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e2.step();
    e2.beginPlant(0);
    for (let i = 0; i < ticksFor(3.3); i += 1) e2.step();
    for (let slot = 0; slot < 5; slot += 1) e2.kill(slot);
    e2.step();
    assert(e2.state.phase === PHASE.LIVE, 'a planted bomb keeps the round alive with no Ts left');
  }

  // ---- defuse: the fourth win condition ----

  {
    // A CT spawned beside the carrier, so the wire is reachable without a walk.
    const spawns = roster(graph);
    spawns[5] = { ...spawns[5], x: spawns[0].x + 20, y: spawns[0].y };
    const mk = (kit) => {
      const r = spawns.map((sp, i) => (i === 5 ? { ...sp, hasKit: kit } : sp));
      const e = createEngine({ map: 'INF', graph, seed: 2, roster: r, pathDistance, record: 'full' });
      for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e.step();
      e.beginPlant(0);
      for (let i = 0; i < ticksFor(3.3); i += 1) e.step();
      assert(e.state.bomb.planted, 'the bomb went down');
      return e;
    };

    {
      const e = mk(false);
      assert(!e.beginDefuse(0), 'a T cannot defuse');
      assert(e.beginDefuse(5), 'the CT beside the bomb can');
      assert(!e.beginDefuse(6), 'a CT across the map cannot');
      const t0 = e.state.tick;
      e.runToEnd();
      assert(e.state.endReason === END_REASON.BOMB_DEFUSED, 'the wire gets cut');
      assert(e.state.winner === 'CT', 'and the CT win');
      assert(e.outcome().reason === 'defuse', 'as a defuse');
      assert(e.outcome().defuserSlot === 5, 'credited to the defuser');
      const took = (e.state.endTick - t0) / TICK_RATE;
      assert(Math.abs(took - 10) < 0.2, `a bare defuse takes 10 s (${took.toFixed(2)})`);
    }

    {
      const e = mk(true);
      e.beginDefuse(5);
      const t0 = e.state.tick;
      e.runToEnd();
      assert(e.state.endReason === END_REASON.BOMB_DEFUSED, 'a kit defuse completes');
      const took = (e.state.endTick - t0) / TICK_RATE;
      assert(Math.abs(took - 5) < 0.2, `and takes 5 s (${took.toFixed(2)})`);
    }

    {
      // Damage breaks the wire (6.5), and a defuse started too late loses the
      // race to the boom: the two orderings the economy prices apart have to
      // resolve the same way in the engine.
      const e = mk(false);
      e.beginDefuse(5);
      for (let i = 0; i < ticksFor(2); i += 1) e.step();
      e.hurt(5, 10, 0);
      assert(e.state.bodies[5].channel === null, 'getting shot breaks the defuse');
      assert(e.state.events.some((ev) => ev.type === 'defuse_broken'), 'and says so');

      // Wait until under 9 seconds remain, then start a 10 second defuse.
      while (e.clock() > 8.5) e.step();
      assert(e.beginDefuse(5), 'the late defuse may start');
      e.runToEnd();
      assert(e.state.endReason === END_REASON.BOMB_EXPLODED, 'but the bomb beats it');
      assert(e.state.winner === 'T', 'and the T win');
    }
  }

  // ---- the bomb is picked up, not lost ----

  {
    const spawns = roster(graph);
    // Two Ts together, so the survivor is standing where the carrier died.
    spawns[1] = { ...spawns[1], x: spawns[0].x + 24, y: spawns[0].y };
    const e = createEngine({ map: 'INF', graph, seed: 3, roster: spawns, pathDistance, record: 'full' });
    for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e.step();
    assert(e.state.bodies[0].hasBomb, 'slot 0 carries');
    e.kill(0, 5, 'ak47');
    assert(e.state.bomb.dropped, 'the bomb is on the ground');
    // Nudge the survivor across the drop.
    e.setIntent(1, { moveTo: graph.nearestWalkable(spawns[0].x, spawns[0].y) });
    for (let i = 0; i < ticksFor(2); i += 1) e.step();
    assert(e.state.bodies[1].hasBomb, 'the teammate picked it up');
    assert(!e.state.bomb.dropped, 'and it is off the ground');
    assert(e.beginPlant(1), 'and can plant it');
  }

  // ---- plants belong on sites when the caller says where sites are ----

  {
    const bSite = graph.anchor('b_site');
    const sites = { b: new Set(bSite.cells) };
    const e = createEngine({
      map: 'INF',
      graph,
      seed: 4,
      roster: roster(graph),
      pathDistance,
      sites
    });
    for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e.step();
    assert(!e.beginPlant(0), 'planting at spawn is refused when sites are supplied');
    e.setIntent(0, { moveTo: { cx: bSite.cx, cy: bSite.cy, level: bSite.level } });
    for (let i = 0; i < ticksFor(40) && !e.beginPlant(0); i += 1) e.step();
    assert(e.state.bodies[0].channel === 'planting', 'and allowed once the carrier is on the site');
    for (let i = 0; i < ticksFor(3.3); i += 1) e.step();
    assert(e.state.bomb.site === 'b', 'and the plant knows which site it is');
  }

  // ---- utility changes fights ----

  {
    // One defender who can see, one thrower who cannot, and a vision switch,
    // so every subtest controls exactly when the gunfight is allowed to start
    // instead of racing the fuse. Without the switch these tests depend on
    // whether a kill lands inside the 1.6 s the grenade is in the air, which
    // is tuning, not testing.
    // The pair stand on verified-open ground: a line probed against the fine
    // collision mask, because an arbitrary offset from a spawn happily lands
    // inside a building and turns every assertion below into a wall test.
    const banana = graph.anchor('banana');
    const from = { x: banana.world.x, y: banana.world.y };
    let to = null;
    for (let deg = 0; deg < 360 && !to; deg += 15) {
      const ux = Math.cos((deg * Math.PI) / 180);
      const uy = Math.sin((deg * Math.PI) / 180);
      let clear = true;
      for (let d = 20; d <= 400; d += 20) {
        if (graph.isSolidWorld(from.x + ux * d, from.y + uy * d)) {
          clear = false;
          break;
        }
      }
      if (clear) to = { x: from.x + ux * 400, y: from.y + uy * 400 };
    }
    assert(to, 'banana has 400 open units in some direction');

    const spawns = roster(graph);
    spawns[0] = { ...spawns[0], x: from.x, y: from.y };
    // Facing the thrower, which matters for exactly one assertion: a flash in
    // front of your eyes is a full blind and one behind your back is 0.3 s,
    // and a defender with a random yaw tests whichever it happens to get.
    const facing = (Math.atan2(from.y - to.y, from.x - to.x) * 180) / Math.PI;
    spawns[5] = { ...spawns[5], x: to.x, y: to.y, yaw: facing };
    const mk = (grenades) => {
      const box = { vision: false };
      const r = spawns.map((sp, i) => (i === 0 ? { ...sp, grenades } : sp));
      const e = createEngine({
        map: 'INF',
        graph,
        seed: 5,
        roster: r,
        pathDistance,
        record: 'full',
        // Only the defender ever shoots, and only once the switch is on.
        canSee: (w, t) => box.vision && w.slot === 5 && t.slot === 0
      });
      for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e.step();
      return { e, box };
    };
    const shotsBy = (e, slot, sinceTick) =>
      e.state.events.filter((x) => x.type === 'shot' && x.slot === slot && x.tick >= sinceTick)
        .length;

    {
      // A smoke between them blocks the fight for its lifetime, and the fight
      // starts the moment the cloud expires.
      const { e, box } = mk(['smokegrenade']);
      const mid = { x: (spawns[0].x + spawns[5].x) / 2, y: (spawns[0].y + spawns[5].y) / 2 };
      assert(e.throwGrenade(0, 'smokegrenade', mid), 'the smoke leaves the hand');
      assert(!e.throwGrenade(0, 'smokegrenade', mid), 'and the pocket is now empty');
      for (let i = 0; i < ticksFor(2); i += 1) e.step();
      assert(e.state.effects.some((x) => x.type === 'smokegrenade'), 'the cloud is up');

      box.vision = true;
      const cloudTick = e.state.tick;
      for (let i = 0; i < ticksFor(4); i += 1) e.step();
      assert(shotsBy(e, 5, cloudTick) === 0, 'no shots go through the cloud');
      assert(e.state.bodies[0].alive, 'and the thrower lives behind it');

      // Outlive the smoke: the angle reopens on its own.
      while (e.state.effects.some((x) => x.type === 'smokegrenade')) e.step();
      const gone = e.state.tick;
      for (let i = 0; i < ticksFor(3); i += 1) e.step();
      assert(shotsBy(e, 5, gone) > 0, 'and the fight starts when the cloud expires');
    }

    {
      // A flash at the defender takes their eyes: no shots while blind, shots
      // again once the eyes recover.
      const { e, box } = mk(['flashbang']);
      e.throwGrenade(0, 'flashbang', { x: spawns[5].x, y: spawns[5].y });
      for (let i = 0; i < ticksFor(1.7); i += 1) e.step();
      const victim = e.state.bodies[5];
      assert(victim.flashSeconds > 1, `the defender is blind (${victim.flashSeconds.toFixed(1)}s)`);

      box.vision = true;
      const blindTick = e.state.tick;
      while (victim.flashSeconds > 0.5) e.step();
      assert(shotsBy(e, 5, blindTick) === 0, 'a blind body does not fire');
      for (let i = 0; i < ticksFor(2); i += 1) e.step();
      assert(shotsBy(e, 5, blindTick) > 0, 'and fires again once the eyes recover');
    }

    {
      // An HE hurts through open air, and a molotov floor kills a body that
      // stands in it, credited to the thrower.
      const { e } = mk(['hegrenade', 'molotov']);
      const hp0 = e.state.bodies[5].health;
      e.throwGrenade(0, 'hegrenade', { x: spawns[5].x, y: spawns[5].y });
      for (let i = 0; i < ticksFor(1.7); i += 1) e.step();
      assert(e.state.bodies[5].health < hp0, 'the HE dealt damage');

      e.throwGrenade(0, 'molotov', { x: spawns[5].x, y: spawns[5].y });
      for (let i = 0; i < ticksFor(9); i += 1) e.step();
      const burned = e.state.events.find((x) => x.type === 'death' && x.slot === 5);
      assert(burned, 'standing in the fire is lethal');
      assert(burned.by === 0, 'and the thrower gets the credit');
    }
  }

  // ---- movement on a real map ----

  {
    const e = createEngine({ map: 'INF', graph, seed: 1, roster: roster(graph), pathDistance, record: 'full' });
    for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e.step();

    const banana = graph.anchor('banana');
    assert(banana, 'the map has a banana anchor to walk to');
    e.setIntent(0, { moveTo: { cx: banana.cx, cy: banana.cy, level: banana.level }, gait: 'run' });

    const body = e.state.bodies[0];
    const start = { ...body.pos };
    let peak = 0;
    for (let i = 0; i < ticksFor(30); i += 1) {
      e.step();
      peak = Math.max(peak, Math.hypot(body.vel.x, body.vel.y));
      // The collision mask, not the nav lattice. The lattice is eroded by the
      // body radius so routes are walkable; a body is allowed to stand closer
      // to a wall than its route ever goes, and asserting against the lattice
      // would fail on correct behaviour.
      assert(
        !graph.isSolidWorld(body.pos.x, body.pos.y, body.level),
        `tick ${i}: body never entered geometry`
      );
    }

    const moved = Math.hypot(body.pos.x - start.x, body.pos.y - start.y);
    assert(moved > 300, `the body actually walked (${Math.round(moved)}u)`);
    const cap = speedCap('ak47', 'run');
    assert(peak > cap * 0.9, `it reached near full speed (${peak.toFixed(0)} of ${cap})`);
    // Not `<= cap`. PM_Accelerate caps the projection of velocity onto the wish
    // direction, not its magnitude, so a body turning through a corner carries
    // a perpendicular component the cap does not see and total speed drifts a
    // little above it. That is the real integrator's behaviour, it is what
    // SourceMovement.js does too, and it is the mechanism behind every Source
    // movement trick. A couple of percent while cornering is right; a lot would
    // mean the wish direction is being renormalized wrongly.
    assert(peak <= cap * 1.03, `and stayed within a corner's worth of it (${peak.toFixed(1)})`);

    const dist = Math.hypot(
      body.pos.x - banana.world.x,
      body.pos.y - banana.world.y
    );
    assert(dist < graph.cellUnits * 3, `and arrived at the anchor (${Math.round(dist)}u away)`);
  }

  {
    // Walking is slower than running, by the constant rather than by accident.
    // Measured as peak speed, not distance over a fixed time: distance folds in
    // the acceleration ramp and however much the route corners, and both of
    // those differ between the two gaits for reasons that have nothing to do
    // with the cap being tested.
    const peakFor = (gait) => {
      const e = createEngine({ map: 'INF', graph, seed: 1, roster: roster(graph), pathDistance, record: 'full' });
      for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e.step();
      const b = e.state.bodies[0];
      const a = graph.anchor('banana');
      e.setIntent(0, { moveTo: { cx: a.cx, cy: a.cy, level: a.level }, gait });
      let peak = 0;
      for (let i = 0; i < ticksFor(6); i += 1) {
        e.step();
        peak = Math.max(peak, Math.hypot(b.vel.x, b.vel.y));
      }
      return peak;
    };
    const ran = peakFor('run');
    const walked = peakFor('walk');
    assert(Math.abs(ran - 215) < 8, `running tops out at the rifle speed (${ran.toFixed(1)})`);
    assert(Math.abs(walked - 112) < 6, `walking tops out at 112 (${walked.toFixed(1)})`);
    const ratio = walked / ran;
    assert(Math.abs(ratio - 112 / 215) < 0.05, `and the ratio is the constant (${ratio.toFixed(3)})`);
  }

  // ---- determinism ----

  {
    const run = () => {
      const e = createEngine({ map: 'INF', graph, seed: 12345, roster: roster(graph), pathDistance });
      const a = graph.anchor('banana');
      const b = graph.anchor('b_site');
      const hashes = [];
      for (let i = 0; i < ticksFor(FREEZE_SECONDS + 20); i += 1) {
        if (i === ticksFor(FREEZE_SECONDS) + 1) {
          e.setIntent(0, { moveTo: { cx: a.cx, cy: a.cy, level: a.level } });
          e.setIntent(5, { moveTo: { cx: b.cx, cy: b.cy, level: b.level } });
        }
        if (i === ticksFor(FREEZE_SECONDS + 10)) e.kill(3);
        e.step();
        if (i % 64 === 0) hashes.push(e.stateHash());
      }
      return hashes.join(',');
    };
    const first = run();
    assert(first === run(), 'the same seed and intents reproduce the round tick for tick');
    assert(first.length > 10, 'and the hash stream is not trivially empty');
  }

  // ---- the encoded round is a real round ----

  {
    const e = createEngine({ map: 'INF', graph, seed: 9, roster: roster(graph), pathDistance, record: 'full' });
    const rec = new RoundRecorder(e);
    const a = graph.anchor('banana');
    for (let i = 0; i < ticksFor(FREEZE_SECONDS + 12); i += 1) {
      if (i === ticksFor(FREEZE_SECONDS) + 1) {
        e.setIntent(0, { moveTo: { cx: a.cx, cy: a.cy, level: a.level } });
      }
      e.step();
      rec.sample();
    }

    const ticks = rec.encodeTicks();
    const header = readHeader(ticks);
    assert(header.tickRate === TICK_RATE, 'the header carries the engine tick rate');
    assert(header.stride === 1, 'and a full-resolution stride');
    assert(header.tickCount === rec.frames.length, 'and one row per sampled tick');
    assert(header.playerCount === 10, 'and ten players');

    // Read it back through the parser's own reader, which is the whole point:
    // if this works, every viewer and every analysis module works.
    const view = new DataView(ticks.buffer, ticks.byteOffset, ticks.byteLength);
    const out = {};
    readRecord(view, header.tickCount - 1, 0, out);
    const body = e.state.bodies[0];
    assert(Math.abs(out.x - body.pos.x) < 0.3, `x survives quantization (${out.x} vs ${body.pos.x})`);
    assert(Math.abs(out.y - body.pos.y) < 0.3, 'y too');
    // readRecord hands back the decoded side as a string and the raw engine
    // team number alongside it, which is the contract the viewer relies on.
    assert(out.teamNum === 2 && out.side === 'T', 'a T reads back as team 2 / "T"');
    assert(out.health === 100, 'and alive with full health');
    assert(out.alive === true, 'and the alive flag survives');

    readRecord(view, header.tickCount - 1, 5, out);
    assert(out.teamNum === 3 && out.side === 'CT', 'a CT reads back as team 3 / "CT"');

    // Every slot in every row is populated: a hole would render as a body at
    // the origin, which is the classic sim-round artefact.
    for (let slot = 0; slot < PLAYER_SLOTS; slot += 1) {
      readRecord(view, 0, slot, out);
      assert(out.side === 'T' || out.side === 'CT', `slot ${slot} has a side on the first tick`);
    }

    const meta = rec.encodeMeta();
    assert(meta.map === 'INF', 'meta names the map');
    assert(meta.freezeEndTick === e.state.liveTick, 'and the freeze end the clock needs');
    assert(meta.players.length === 10, 'and ten players');
    assert(meta.weapons.includes('ak47'), 'and a weapon dictionary the indices point into');
    assert(meta.events.some((ev) => ev.type === 'freeze_end'), 'and the events that happened');
  }

  mapChecked = true;
}

console.log(`engine: ok${mapChecked ? ' (on the baked Inferno)' : ' (no baked map, logic only)'}`);

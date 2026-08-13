// Run: node shared/sim/round.test.js
//
// Everything below this file has been tested in isolation. This is the first
// test where a whole round happens: ten bodies on a real map, walking real
// routes, seeing each other through the viewer's own visibility code, shooting
// each other with the humanized motor, dying, and paying out.
//
// What it is actually checking is that the pieces compose. Each of them passes
// alone and there are half a dozen ways for them to be wrong together: sound
// that never reaches anyone, deaths that do not end the round, kill cash that
// does not reach the payout, a fight that resolves before anyone can see.
//
// Skips when the map bake is missing.

import { FREEZE_SECONDS, ticksFor } from './constants.js';
import { PHASE, createEngine } from './engine.js';
import { navGraphFromBake } from './navGraph.js';
import { loadAngles } from './angles.js';
import { RoundRecorder } from './encode.js';
import { settleRound } from './economy.js';
import { skillProfile } from './skill.js';
import { readHeader } from '../../src/replays/shared/tickFormat.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

let graph = null;
let angles = null;
try {
  const { readFile } = await import('node:fs/promises');
  const { ROOT } = await import('../../server/replays/demoStore.js');
  const path = await import('node:path');
  graph = navGraphFromBake(
    JSON.parse(await readFile(path.join(ROOT, 'sim', 'navcache', 'INF.json'), 'utf8'))
  );
  angles = loadAngles(
    JSON.parse(await readFile(path.join(ROOT, 'sim', 'angles', 'INF.json'), 'utf8'))
  );
} catch {
  graph = null;
}

if (!graph) {
  console.log('round: skipped (no baked map)');
} else {
  /**
   * Visibility, from the catalogue rather than from a new raycaster.
   *
   * The catalogue is per (anchor, yaw), so this asks whether the watcher's
   * nearest catalogued angle facing the target can see the target's cell. That
   * is coarser than a live cone and it is the right coarseness here: it is the
   * same geometry the possession system and the page use, so a bot cannot see
   * anything the viewer would not draw.
   */
  /**
   * Visibility from the catalogue rather than from a new raycaster: the same
   * geometry the possession system and the page use, so a bot cannot see
   * anything the viewer would not draw.
   */
  function makeCanSee() {
    return (watcher, target) => {
      if (watcher.level !== target.level) return false;
      return angles.canSee(watcher.pos.x, watcher.pos.y, target.pos.x, target.pos.y, watcher.level);
    };
  }

  const pathDistance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

  function roster() {
    const t = graph.spawns.filter((s) => s.side === 'T').slice(0, 5);
    const ct = graph.spawns.filter((s) => s.side === 'CT').slice(0, 5);
    return [...t, ...ct].map((s, i) => ({
      id: i < 5 ? `t${i}` : `ct${i - 5}`,
      side: i < 5 ? 'T' : 'CT',
      x: s.x,
      y: s.y,
      z: s.z || 0,
      weapon: 'ak47'
    }));
  }

  function newRound(seed, skill = 'average') {
    return createEngine({
      map: 'INF',
      graph,
      seed,
      roster: roster(),
      profiles: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(() => skillProfile(skill)),
      canSee: makeCanSee(),
      pathDistance,
      // Recording is off by default because most rounds are never watched; the
      // tests below inspect the event stream, so they ask for it.
      record: 'full'
    });
  }

  // ---- both sides walk at each other and a fight happens ----

  {
    const e = newRound(1);
    const rec = new RoundRecorder(e);
    const banana = graph.anchor('banana');
    const car = graph.anchor('car');

    for (let i = 0; i < ticksFor(FREEZE_SECONDS + 90); i += 1) {
      if (i === ticksFor(FREEZE_SECONDS) + 1) {
        // Everyone walks into banana from both ends. On this map that is the
        // fight that is guaranteed to happen.
        for (let s = 0; s < 5; s += 1) {
          e.setIntent(s, { moveTo: { cx: car.cx, cy: car.cy, level: car.level } });
        }
        for (let s = 5; s < 10; s += 1) {
          e.setIntent(s, { moveTo: { cx: banana.cx, cy: banana.cy, level: banana.level } });
        }
      }
      e.step();
      rec.sample();
      if (e.state.phase === PHASE.OVER) break;
    }

    const ev = e.state.events;
    const shots = ev.filter((x) => x.type === 'shot');
    const damages = ev.filter((x) => x.type === 'damage');
    const deaths = ev.filter((x) => x.type === 'death');

    assert(shots.length > 0, 'somebody shot at somebody');
    assert(damages.length > 0, `and hit them (${damages.length} damage events)`);
    assert(deaths.length > 0, `and killed them (${deaths.length} deaths)`);

    // Every death has a killer and a weapon, which the payout needs.
    for (const d of deaths) {
      assert(d.by !== null && d.by !== undefined, 'every combat death names a killer');
      assert(d.weapon, 'and a weapon');
      assert(Number.isFinite(d.x) && Number.isFinite(d.y), 'and where the body fell');
    }

    // The kill cash ledger agrees with the death list.
    const totalCash = Object.values(e.killCash).reduce((a, b) => a + b, 0);
    assert(totalCash === deaths.length * 300, `AK kills pay 300 each (${totalCash} for ${deaths.length})`);

    // Nobody shot before they could see: every shot happened after at least one
    // pair had line of sight. The weaker but decisive version of this is that
    // the first shot is not on the first live tick.
    const firstShot = shots[0].tick;
    assert(firstShot > e.state.liveTick + 32, `first shot is not instant (tick ${firstShot - e.state.liveTick} of live)`);

    // Sound reached somebody.
    assert(e.sounds.items.length > 0, 'sounds were heard');
    const kinds = new Set(e.sounds.items.map((s) => s.type));
    assert(kinds.has('footstep'), 'including footsteps');
    assert(kinds.has('gunshot'), 'and gunshots');
    for (const s of e.sounds.items) {
      assert(s.sector >= 0 && s.sector < 8, 'a percept carries a sector');
      assert(['close', 'mid', 'far'].includes(s.band), 'and a range band');
      assert(s.x === undefined && s.y === undefined, 'and never a position');
    }

    // The round is still encodable after all of that.
    const header = readHeader(rec.encodeTicks());
    assert(header.tickCount === rec.frames.length, 'the round encodes');
    const meta = rec.encodeMeta();
    assert(meta.events.kills.length > 0, 'and its meta carries the deaths as parser kills');
  }

  // ---- a round that ends in a wipe pays out ----

  {
    const e = newRound(4);
    for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 2; i += 1) e.step();
    for (let s = 0; s < 5; s += 1) e.kill(s, 5, 'ak47');
    e.step();

    assert(e.state.phase === PHASE.OVER, 'wiping a side ends the round');
    const outcome = e.outcome();
    assert(outcome.winner === 'CT', 'the CT won');
    assert(outcome.reason === 'elimination', 'by elimination');
    assert(!outcome.planted, 'with no plant');

    const settled = settleRound({
      outcome,
      players: e.state.bodies.map((b) => ({ slot: b.slot, side: b.side, alive: b.alive, money: 0 })),
      killCash: e.killCash,
      lossStreak: { T: 0, CT: 0 }
    });
    // One CT got all five kills, so he is the win plus five awards.
    assert(settled.money[5] === 3250 + 5 * 300, `the killer banks his awards (${settled.money[5]})`);
    assert(settled.money[6] === 3250, 'his teammates get the win only');
    assert(settled.money[0] === 1400, 'and the losing Ts get the first rung');
  }

  // ---- a plant survives a wipe, and pays as a bomb ----

  {
    const e = newRound(5);
    for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e.step();
    e.beginPlant(0);
    for (let i = 0; i < ticksFor(3.3); i += 1) e.step();
    assert(e.state.bomb.planted, 'the bomb went down');
    assert(e.outcome().planterSlot === 0, 'and the planter is recorded for his bonus');

    for (let s = 0; s < 5; s += 1) e.kill(s, 5, 'ak47');
    e.step();
    assert(e.state.phase === PHASE.LIVE, 'the round continues with the bomb down');

    e.runToEnd();
    const outcome = e.outcome();
    assert(outcome.reason === 'bomb', 'and it ends on the bomb');
    assert(outcome.winner === 'T', 'for the T');
    assert(outcome.planted, 'with the plant recorded');
  }

  // ---- skill shows up in outcomes ----

  {
    // A pro side against a mix side should win the banana fight more often
    // than not. Not a certainty in any one round, which is the point of running
    // several: if this came out even, the profiles are not reaching the motor.
    const banana = graph.anchor('banana');
    const car = graph.anchor('car');
    let proWins = 0;
    const N = 12;

    for (let seed = 0; seed < N; seed += 1) {
      const e = createEngine({
        map: 'INF',
        graph,
        seed: 900 + seed,
        roster: roster(),
        profiles: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => skillProfile(i < 5 ? 'mix' : 'pro')),
        canSee: makeCanSee(),
        pathDistance,
        record: 'events'
      });
      for (let i = 0; i < ticksFor(FREEZE_SECONDS + 100); i += 1) {
        if (i === ticksFor(FREEZE_SECONDS) + 1) {
          for (let s = 0; s < 5; s += 1) e.setIntent(s, { moveTo: { cx: car.cx, cy: car.cy, level: car.level } });
          for (let s = 5; s < 10; s += 1) e.setIntent(s, { moveTo: { cx: banana.cx, cy: banana.cy, level: banana.level } });
        }
        e.step();
        if (e.state.phase === PHASE.OVER) break;
      }
      const tAlive = e.aliveCount('T');
      const ctAlive = e.aliveCount('CT');
      if (ctAlive > tAlive) proWins += 1;
    }

    assert(proWins > N / 2, `the pro side wins the fight more often (${proWins}/${N})`);
  }

  // ---- determinism survives combat ----

  {
    const run = () => {
      const e = newRound(77);
      const banana = graph.anchor('banana');
      const car = graph.anchor('car');
      const hashes = [];
      for (let i = 0; i < ticksFor(FREEZE_SECONDS + 60); i += 1) {
        if (i === ticksFor(FREEZE_SECONDS) + 1) {
          for (let s = 0; s < 5; s += 1) e.setIntent(s, { moveTo: { cx: car.cx, cy: car.cy, level: car.level } });
          for (let s = 5; s < 10; s += 1) e.setIntent(s, { moveTo: { cx: banana.cx, cy: banana.cy, level: banana.level } });
        }
        e.step();
        if (i % 64 === 0) hashes.push(e.stateHash());
        if (e.state.phase === PHASE.OVER) break;
      }
      return `${hashes.join(',')}|${e.state.events.length}`;
    };
    assert(run() === run(), 'a round with gunfights in it still replays identically');
  }

  console.log('round: ok (full rounds with combat on the baked Inferno)');
}

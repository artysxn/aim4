// Run: node server/replays/spawnPoints.test.js
//
// The Strategy Creator paints whatever this returns, so the two rules that
// matter are asserted here: spawns closer than MIN_SEPARATION collapse into
// one, and each keeps the side that was actually standing on it.

import {
  FLAG_ALIVE,
  HEADER_BYTES,
  PLAYER_SLOTS,
  TICK_BYTES,
  writeHeader,
  writeRecord
} from '../../src/replays/shared/tickFormat.js';
import { MIN_SEPARATION, forgetSpawnCache, spawnsForMap } from './spawnPoints.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const TICK_RATE = 64;
const FREEZE_END = 640;

/** A one-row tick buffer with ten players parked on the given points. */
function tickBuffer(points) {
  const rows = 4;
  const buf = new ArrayBuffer(HEADER_BYTES + rows * TICK_BYTES);
  const view = new DataView(buf);
  writeHeader(view, {
    tickCount: rows,
    firstTick: 0,
    stride: 100,
    tickRate: TICK_RATE,
    playerCount: PLAYER_SLOTS
  });
  for (let row = 0; row < rows; row++) {
    points.forEach((p, slot) => {
      writeRecord(view, row, slot, {
        x: p.x,
        y: p.y,
        z: 0,
        yaw: 0,
        pitch: 0,
        health: 100,
        flags: FLAG_ALIVE,
        side: slot < 5 ? 'T' : 'CT'
      });
    });
  }
  return buf;
}

/** Team 1 is T, team 2 is CT, five each — the usual roster shape. */
const roster = Array.from({ length: 10 }, (_, slot) => ({
  id: `p${slot}`,
  name: `p${slot}`,
  slot,
  team: slot < 5 ? 1 : 2
}));

function fakeIo(byFile) {
  return {
    async readRoundMeta(_user, file) {
      return {
        map: 'ANC',
        players: roster,
        team1Side: 'T',
        team2Side: 'CT',
        tickRate: TICK_RATE,
        startTick: 0,
        freezeEndTick: FREEZE_END,
        endTick: FREEZE_END + TICK_RATE * 100
      };
    },
    async readRoundTicks(_user, file) {
      return byFile[file] || null;
    }
  };
}

const record = (id, files) => ({
  id,
  status: 'ready',
  map: 'ANC',
  rounds: files.map((f) => ({ file: f }))
});

// ---- distinct spawns are kept, near-duplicates collapse ---------------------

{
  forgetSpawnCache();
  // Five T spawns 100 units apart, five CT spawns far away.
  const base = Array.from({ length: 5 }, (_, i) => ({ x: i * 100, y: 0 }));
  const ct = Array.from({ length: 5 }, (_, i) => ({ x: i * 100, y: 2000 }));
  // A second round where everyone stands a few units off the same spots: that
  // is the same spawn, not ten more.
  const nudged = [...base, ...ct].map((p) => ({ x: p.x + 9, y: p.y - 7 }));

  const io = fakeIo({
    'r1.json': tickBuffer([...base, ...ct]),
    'r2.json': tickBuffer(nudged)
  });

  const spawns = await spawnsForMap(io, 'local', [record('d1', ['r1.json', 'r2.json'])], 'ANC');
  assert(spawns.length === 10, `ten distinct spawns, got ${spawns.length}`);
  assert(spawns.filter((s) => s.side === 'T').length === 5, 'five T spawns');
  assert(spawns.filter((s) => s.side === 'CT').length === 5, 'five CT spawns');
  assert(
    spawns.every((s) => s.seen === 2),
    'the second round is recognised as the same spawns rather than new ones'
  );
  console.log('  spawns within the separation collapse, and their use count grows');
}

// ---- separation is enforced in both directions -----------------------------

{
  forgetSpawnCache();
  const points = [
    { x: 0, y: 0 },
    // Just inside the threshold: same spawn.
    { x: MIN_SEPARATION - 2, y: 0 },
    // Just outside: its own spawn.
    { x: MIN_SEPARATION * 2 + 5, y: 0 },
    { x: 500, y: 500 },
    { x: 900, y: 900 },
    { x: 0, y: 3000 },
    { x: 200, y: 3000 },
    { x: 400, y: 3000 },
    { x: 600, y: 3000 },
    { x: 800, y: 3000 }
  ];
  const io = fakeIo({ 'r1.json': tickBuffer(points) });
  const spawns = await spawnsForMap(io, 'local', [record('d1', ['r1.json'])], 'ANC');
  const tSide = spawns.filter((s) => s.side === 'T');
  assert(tSide.length === 4, `two of the five T points merge into one, got ${tSide.length}`);
  console.log(`  ${MIN_SEPARATION} units is the line between one spawn and two`);
}

// ---- nothing to read -------------------------------------------------------

{
  forgetSpawnCache();
  const io = fakeIo({});
  assert((await spawnsForMap(io, 'local', [], 'ANC')).length === 0, 'no demos, no spawns');
  assert(
    (await spawnsForMap(io, 'local', [record('d1', ['missing.json'])], 'ANC')).length === 0,
    'a round with no tick file is skipped rather than throwing'
  );
  forgetSpawnCache();
  assert((await spawnsForMap(io, 'local', [record('d1', ['r1.json'])], '')).length === 0, 'no map, no spawns');
  console.log('  missing demos, missing ticks and a missing map all return nothing');
}

// ---- caching ---------------------------------------------------------------

{
  forgetSpawnCache();
  let reads = 0;
  const buf = tickBuffer(Array.from({ length: 10 }, (_, i) => ({ x: i * 200, y: 0 })));
  const io = {
    ...fakeIo({ 'r1.json': buf }),
    async readRoundTicks() {
      reads++;
      return buf;
    }
  };
  const records = [record('d1', ['r1.json'])];
  await spawnsForMap(io, 'local', records, 'ANC');
  const first = reads;
  await spawnsForMap(io, 'local', records, 'ANC');
  assert(reads === first, 'a second call for the same map is served from cache');
  forgetSpawnCache('ANC');
  await spawnsForMap(io, 'local', records, 'ANC');
  assert(reads > first, 'forgetting the cache reads again');
  console.log('  results are cached per map, and the cache can be dropped');
}

console.log('spawnPoints: all assertions passed');

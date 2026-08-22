// Run: node src/replays/analytics/zoneControl.test.js
//
// "Map control in" — the Pattern Finder feature that filters nothing.
//
// Every other selection answers yes or no about a round and the round is kept
// or dropped. This one keeps every round it is given and splits them by who
// held the ground, because the question behind it is not "which rounds" but
// "is holding this worth anything" — banana at 1:20, top mid at 1:10. The
// answer is two win rates, and the win rate of a side that never held it is
// not zero, it is absent, which is why the buckets carry their round counts.
//
// Control itself is the possession model the viewer already draws: a cell
// belongs to the last side that stood near it. Reusing it is the point — a
// number here and the shading in the viewer have to mean the same thing.

import assert from 'node:assert/strict';
import {
  MAP_CONTROL_MAX_SECONDS,
  cellsInShape,
  controlOfCells,
  controlShapes,
  controlTeamRows,
  controlWindow,
  controlWinrates,
  needsControlWindow,
  winningSide
} from './zoneControl.js';

const CELL = 32;
const COLS = 40;

/** A flat, wholly walkable lattice: world 0..1280 on both axes. */
function lattice() {
  const count = COLS * COLS;
  return {
    mapCode: 'TEST',
    cell: CELL,
    area: CELL * CELL,
    originX: 0,
    originY: 0,
    cols: COLS,
    rows: COLS,
    count,
    walkable: new Uint8Array(count).fill(1),
    walkableCount: count,
    walkableArea: count * CELL * CELL
  };
}

const geom = lattice();
const network = { _fieldGeom: geom };

const TICK_RATE = 64;
const BOX = { type: 'rect', x: 0, y: 0, w: 320, h: 320 };   // 10 x 10 cells
const FAR = { x: 1200, y: 1200 };

/**
 * A round where `inBox` names, per side, where that side's five players stand
 * for the whole round. `null` keeps a side out of the map entirely.
 */
function round({ t, ct, winner = 1, t1 = 'Vitality', t2 = 'Spirit' }) {
  const players = [];
  for (let i = 0; i < 5; i++) players.push({ id: `t${i}`, slot: i, team: 1 });
  for (let i = 0; i < 5; i++) players.push({ id: `c${i}`, slot: 5 + i, team: 2 });
  const meta = {
    tickRate: TICK_RATE,
    startTick: 0,
    freezeEndTick: 0,
    endTick: 115 * TICK_RATE,
    team1Side: 'T',
    team2Side: 'CT',
    players,
    events: { kills: [], grenades: [] }
  };
  const at = (slot) => (slot < 5 ? t : ct);
  const track = {
    sampleAll(tick, out = []) {
      for (let s = 0; s < 10; s++) {
        const p = at(s);
        out[s] = p ? { alive: true, x: p.x, y: p.y, yaw: 0 } : { alive: false, x: 0, y: 0 };
      }
      return out;
    }
  };
  const row = { f: 'f1', d: 'd1', m: 'TEST', n: 1, w: winner, s1: 'T', s2: 'CT' };
  const demo = { id: 'd1', name1: t1, name2: t2 };
  return { meta, track, row, demo };
}

const cells = cellsInShape(geom, BOX);
const win = { from: 10, to: 30 };

// ---- the cells a selection covers -------------------------------------------
{
  assert.equal(cells.length, 100, 'a 320-unit box over 32-unit cells is 10 x 10');
  // Unwalkable ground is nobody's: it cannot be stood on, so it cannot be held.
  const holed = { ...geom, walkable: new Uint8Array(geom.count) };
  holed.walkable.fill(1);
  for (let i = 0; i < 50; i++) holed.walkable[i] = 0;
  assert.ok(cellsInShape(holed, BOX).length < 100, 'unwalkable cells drop out');
  assert.equal(cellsInShape(geom, { type: 'rect', x: 5000, y: 5000, w: 10, h: 10 }).length, 0);
}

// ---- who held it ------------------------------------------------------------
{
  const ts = round({ t: { x: 160, y: 160 }, ct: FAR });
  const got = controlOfCells({ meta: ts.meta, track: ts.track, network, cells, window: win });
  assert.equal(got.side, 'T', 'the Ts stood in it and the CTs did not');
  assert.ok(got.t > 0 && got.ct === 0, 'and the tally says so');

  const cts = round({ t: FAR, ct: { x: 160, y: 160 } });
  assert.equal(
    controlOfCells({ meta: cts.meta, track: cts.track, network, cells, window: win }).side,
    'CT'
  );

  // Nobody near it: held by neither, which is an answer and not a default to T.
  const empty = round({ t: FAR, ct: FAR });
  assert.equal(
    controlOfCells({ meta: empty.meta, track: empty.track, network, cells, window: win }).side,
    ''
  );
}

// ---- both sides in it: the larger share takes it -----------------------------
{
  // One T at one end, one CT at the other — but the T side has more of its
  // players inside, so more of the ground is theirs.
  const meta = round({ t: null, ct: null }).meta;
  const spots = [
    { x: 60, y: 60 }, { x: 60, y: 160 }, { x: 60, y: 260 }, { x: 1200, y: 1200 }, { x: 1200, y: 1200 },
    { x: 300, y: 300 }, { x: 1200, y: 1200 }, { x: 1200, y: 1200 }, { x: 1200, y: 1200 }, { x: 1200, y: 1200 }
  ];
  const track = {
    sampleAll(tick, out = []) {
      for (let s = 0; s < 10; s++) out[s] = { alive: true, ...spots[s], yaw: 0 };
      return out;
    }
  };
  const got = controlOfCells({ meta, track, network, cells, window: win });
  assert.equal(got.side, 'T', 'three Ts across it outweigh one CT in the corner');
  assert.ok(got.ct > 0, 'and the CT presence is real, just smaller');
}

// ---- the window is a moment, and it is enforced ------------------------------
{
  assert.deepEqual(controlWindow({ window: { from: 35, to: 55 } }), { from: 35, to: 55 });
  assert.equal(controlWindow({ window: { from: 0, to: 115 } }), null, 'a whole round is not a moment');
  assert.equal(
    controlWindow({ window: { from: 0, to: MAP_CONTROL_MAX_SECONDS + 1 } }),
    null,
    'one second over is over'
  );
  assert.deepEqual(
    controlWindow({ window: { from: 0, to: MAP_CONTROL_MAX_SECONDS } }),
    { from: 0, to: MAP_CONTROL_MAX_SECONDS },
    'and exactly twenty is allowed'
  );
  assert.equal(controlWindow({}), null, 'no window at all is no window');
  assert.equal(needsControlWindow({ feature: 'map_control' }), true);
  assert.equal(needsControlWindow({ feature: 'map_control', window: { from: 10, to: 25 } }), false);
  assert.equal(needsControlWindow({ feature: 'player_in' }), false, 'other features are unaffected');

  // The window really does select a stretch: a side that only shows up late is
  // not the holder of an early window.
  const meta = round({ t: null, ct: null }).meta;
  const track = {
    sampleAll(tick, out = []) {
      const late = tick >= 60 * TICK_RATE;
      for (let s = 0; s < 10; s++) {
        const inBox = s < 5 ? late : false;
        out[s] = { alive: true, ...(inBox ? { x: 160, y: 160 } : FAR), yaw: 0 };
      }
      return out;
    }
  };
  assert.equal(
    controlOfCells({ meta, track, network, cells, window: { from: 5, to: 20 } }).side,
    '',
    'early: nobody there yet'
  );
  assert.equal(
    controlOfCells({ meta, track, network, cells, window: { from: 65, to: 80 } }).side,
    'T',
    'late: the Ts arrived'
  );
}

// ---- which selections are control selections --------------------------------
{
  const shapes = [
    { feature: 'map_control', geometry: BOX, enabled: true },
    { feature: 'map_control', geometry: BOX, enabled: false },
    { feature: 'grenade_in', geometry: BOX, enabled: true },
    { feature: 'map_control', enabled: true }
  ];
  assert.equal(controlShapes(shapes).length, 1, 'enabled, drawn, and control');
}

// ---- the read-out: win rate is the holding side's own ------------------------
{
  const rows = new Map([
    // T held it and won, twice; T held it and lost, once → 2/3.
    ['a', { w: 1, s1: 'T', s2: 'CT' }],
    ['b', { w: 1, s1: 'T', s2: 'CT' }],
    ['c', { w: 2, s1: 'T', s2: 'CT' }],
    // CT held it and won, once; CT held it and lost, once → 1/2.
    ['d', { w: 2, s1: 'T', s2: 'CT' }],
    ['e', { w: 1, s1: 'T', s2: 'CT' }],
    // Nobody held it.
    ['f', { w: 1, s1: 'T', s2: 'CT' }]
  ]);
  const control = new Map([
    ['a', 'T'], ['b', 'T'], ['c', 'T'],
    ['d', 'CT'], ['e', 'CT'],
    ['f', '']
  ]);
  const sum = controlWinrates(control, rows);
  assert.equal(sum.T.rounds, 3);
  assert.equal(sum.T.wins, 2);
  assert.ok(Math.abs(sum.T.winrate - 66.666) < 0.01, 'T win 2 of the 3 they held');
  assert.equal(sum.CT.rounds, 2);
  assert.equal(sum.CT.wins, 1);
  assert.equal(sum.CT.winrate, 50);
  assert.equal(sum.neither, 1, 'and one went to nobody');
  assert.equal(sum.total, 6);

  // Sides swap at the half, so the seat matters, not the team number.
  const swapped = new Map([['a', { w: 2, s1: 'CT', s2: 'T' }]]);
  const one = controlWinrates(new Map([['a', 'T']]), swapped);
  assert.equal(one.T.wins, 1, 'team 2 was the T side that round, and it won');
  assert.equal(winningSide({ w: 2, s1: 'CT', s2: 'T' }), 'T');

  // A file with no row is not a round in this search.
  assert.equal(controlWinrates(new Map([['zz', 'T']]), rows).total, 0);
}

// ---- and per team, inside one bucket ----------------------------------------
{
  const rows = new Map([
    ['a', { w: 1, s1: 'T', s2: 'CT' }],
    ['b', { w: 1, s1: 'T', s2: 'CT' }],
    ['c', { w: 2, s1: 'T', s2: 'CT' }],
    ['d', { w: 2, s1: 'CT', s2: 'T' }]
  ]);
  const demos = new Map([
    ['a', { name1: 'Vitality', name2: 'Spirit' }],
    ['b', { name1: 'Vitality', name2: 'Spirit' }],
    ['c', { name1: 'Vitality', name2: 'Spirit' }],
    ['d', { name1: 'Spirit', name2: 'Vitality' }]
  ]);
  const control = new Map([['a', 'T'], ['b', 'T'], ['c', 'T'], ['d', 'T']]);
  const teams = controlTeamRows(control, rows, demos, 'T');

  const vit = teams.find((t) => t.name === 'Vitality');
  // Vitality were the Ts in a, b, c (won a and b) and the Ts again in d (won).
  assert.equal(vit.rounds, 4, 'every round Vitality held it as T');
  assert.equal(vit.wins, 3);
  assert.equal(vit.winrate, 75);
  assert.equal(vit.files.length, 4, 'and it remembers which, for the rounds list');
  // Spirit were never the T side while it was held.
  assert.equal(teams.find((t) => t.name === 'Spirit'), undefined);

  // The other bucket is empty here — nobody held it as CT.
  assert.deepEqual(controlTeamRows(control, rows, demos, 'CT'), []);
  assert.deepEqual(controlTeamRows(control, rows, demos, ''), [], 'and a side is required');
}

console.log('zoneControl.test.js: ok');

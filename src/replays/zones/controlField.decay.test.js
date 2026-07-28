// ---------------------------------------------------------------------------
// Soft-control decay regressions (corridor tip + enclosed hole).
// Run: node src/replays/zones/controlField.decay.test.js
// ---------------------------------------------------------------------------

import {
  SIDE_CT,
  SIDE_NONE,
  SIDE_T,
  createControlField,
  decaySoftControl,
  fillNeutralPockets
} from './controlField.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/** Tiny walkable lattice: all cells walkable, CELL-sized world units. */
function fakeGeom(cols, rows, cell = 32) {
  const count = cols * rows;
  return {
    mapCode: 'TEST',
    cell,
    area: cell * cell,
    originX: 0,
    originY: 0,
    cols,
    rows,
    count,
    walkable: new Uint8Array(count).fill(1),
    walkableCount: count,
    walkableArea: count * cell * cell
  };
}

function cellCenter(geom, ix, iy) {
  return {
    x: geom.originX + (ix + 0.5) * geom.cell,
    y: geom.originY + (iy + 0.5) * geom.cell
  };
}

function idx(geom, ix, iy) {
  return iy * geom.cols + ix;
}

const tickRate = 64;
const holdTicks = 10 * tickRate;
const graceTicks = 2 * tickRate;
const graceRangeCells = 12;
const rules = {
  holdTicks,
  graceTicks,
  graceRangeCells,
  retreatCellsPerSecond: 1000 // spend freely so one call peels the budget
};

function testCorridorFarEndClearsFirst() {
  // Owned stretch 1..20 inside a longer row so tips touch SIDE_NONE.
  const geom = fakeGeom(22, 1);
  const field = createControlField(geom);
  const tick = 20 * tickRate;

  for (let ix = 1; ix <= 20; ix++) {
    const i = idx(geom, ix, 0);
    field.owner[i] = SIDE_T;
    field.tLast[i] = 0;
  }

  const p = cellCenter(geom, 1, 0);
  const anchors = [{ x: p.x, y: p.y, side: SIDE_T }];

  const geom2 = fakeGeom(22, 1);
  const field2 = createControlField(geom2);
  for (let ix = 1; ix <= 20; ix++) {
    const i = idx(geom2, ix, 0);
    field2.owner[i] = SIDE_T;
    field2.tLast[i] = 0;
  }
  // 0.002s * 1000 = 2 cells — only the far tip wavefront.
  decaySoftControl(field2, tick, 0.002, { ...rules, retreatCellsPerSecond: 1000 }, anchors);
  assert(field2.owner[idx(geom2, 20, 0)] === SIDE_NONE, 'budget peels farthest first');
  assert(field2.owner[idx(geom2, 19, 0)] === SIDE_NONE, 'budget peels second-farthest');
  assert(field2.owner[idx(geom2, 1, 0)] === SIDE_T, 'player cell must still be owned');
  assert(field2.owner[idx(geom2, 5, 0)] === SIDE_T, 'near mid must still be owned after tiny peel');

  // Full peel for smoke check.
  decaySoftControl(field, tick, 1, rules, anchors);
  assert(field.owner[idx(geom, 20, 0)] === SIDE_NONE, 'far tip should clear to neutral');
}

function testGraceKeepsNearAliveLonger() {
  // At exactly holdTicks, far cells are ready; near cells still in grace.
  const geom = fakeGeom(22, 1);
  const field = createControlField(geom);
  const last = 1000;
  const tick = last + holdTicks;

  for (let ix = 1; ix <= 20; ix++) {
    const i = idx(geom, ix, 0);
    field.owner[i] = SIDE_T;
    field.tLast[i] = last;
  }

  const p = cellCenter(geom, 1, 0);
  const anchors = [{ x: p.x, y: p.y, side: SIDE_T }];
  decaySoftControl(field, tick, 1, { ...rules, retreatCellsPerSecond: 1000 }, anchors);

  assert(field.owner[idx(geom, 20, 0)] === SIDE_NONE, 'far tip ready at 10s');
  assert(field.owner[idx(geom, 1, 0)] === SIDE_T, 'player cell still in grace at 10s');
  assert(field.owner[idx(geom, 2, 0)] === SIDE_T, 'near neighbor still in grace at 10s');
}

function testHoleAbsorbedBeforeDecay() {
  const geom = fakeGeom(5, 5);
  const field = createControlField(geom);

  for (let iy = 0; iy < 5; iy++) {
    for (let ix = 0; ix < 5; ix++) {
      field.owner[idx(geom, ix, iy)] = SIDE_T;
      field.tLast[idx(geom, ix, iy)] = 0;
    }
  }
  field.owner[idx(geom, 2, 2)] = SIDE_NONE;

  fillNeutralPockets(field, 12);
  assert(field.owner[idx(geom, 2, 2)] === SIDE_T, 'enclosed hole absorbed before decay');
}

function testHoleDoesNotErodeFromInsideExpanded() {
  const geom = fakeGeom(7, 7);
  const field = createControlField(geom);
  const tick = 30 * tickRate;

  for (let iy = 1; iy <= 5; iy++) {
    for (let ix = 1; ix <= 5; ix++) {
      const i = idx(geom, ix, iy);
      field.owner[i] = SIDE_T;
      field.tLast[i] = 0;
    }
  }
  field.owner[idx(geom, 3, 3)] = SIDE_NONE; // hole

  fillNeutralPockets(field, 12);
  assert(field.owner[idx(geom, 3, 3)] === SIDE_T, 'hole filled before decay');

  const p = cellCenter(geom, 3, 3);
  const anchors = [{ x: p.x, y: p.y, side: SIDE_T }];

  // Without fill, a hole would mark (3,2)/(2,3)/… as edges. After fill, only
  // the outer ring (touching the surrounding SIDE_NONE frame) is eligible.
  // Peel 2 cells — must be outer, not recreate the hole.
  decaySoftControl(field, tick, 0.002, { ...rules, retreatCellsPerSecond: 1000 }, anchors);

  assert(field.owner[idx(geom, 3, 3)] === SIDE_T, 'center must not reopen as a hole');
  // Cleared cells must be SIDE_NONE (neutral), never contested ownership.
  for (let i = 0; i < geom.count; i++) {
    assert(
      field.owner[i] === SIDE_NONE || field.owner[i] === SIDE_T || field.owner[i] === SIDE_CT,
      'owner must stay a side or neutral'
    );
  }
  let cleared = 0;
  for (let iy = 1; iy <= 5; iy++) {
    for (let ix = 1; ix <= 5; ix++) {
      if (field.owner[idx(geom, ix, iy)] === SIDE_NONE) cleared++;
    }
  }
  assert(cleared === 2, `expected 2 outer cells cleared, got ${cleared}`);
}

function testClearsToNeutralNotContested() {
  const geom = fakeGeom(10, 1);
  const field = createControlField(geom);
  const tick = 20 * tickRate;
  for (let ix = 1; ix <= 8; ix++) {
    field.owner[idx(geom, ix, 0)] = SIDE_CT;
    field.ctLast[idx(geom, ix, 0)] = 0;
  }
  const p = cellCenter(geom, 1, 0);
  decaySoftControl(field, tick, 1, { ...rules, retreatCellsPerSecond: 1000 }, [
    { x: p.x, y: p.y, side: SIDE_CT }
  ]);
  for (let ix = 1; ix <= 8; ix++) {
    const o = field.owner[idx(geom, ix, 0)];
    assert(o === SIDE_NONE || o === SIDE_CT, 'cleared cells are neutral, not a third state');
  }
  assert(field.owner[idx(geom, 8, 0)] === SIDE_NONE, 'far CT tip clears to SIDE_NONE');
}

const tests = [
  ['corridorFarEndClearsFirst', testCorridorFarEndClearsFirst],
  ['graceKeepsNearAliveLonger', testGraceKeepsNearAliveLonger],
  ['holeAbsorbedBeforeDecay', testHoleAbsorbedBeforeDecay],
  ['holeDoesNotErodeFromInsideExpanded', testHoleDoesNotErodeFromInsideExpanded],
  ['clearsToNeutralNotContested', testClearsToNeutralNotContested]
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`fail ${name}: ${err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log(`\n${tests.length} passed`);

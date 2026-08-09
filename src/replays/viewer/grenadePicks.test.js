// ---------------------------------------------------------------------------
// Picking grenades off the analyzer's grenade map.
//
// The three modifiers are the whole feature: a plain click takes the throw,
// Alt narrows it to where things land, Shift+Alt to where they come from. The
// helpers are pure over the frame's hit list, so they are lifted out of the
// viewer and exercised directly rather than through a canvas.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'analyzerViewer.js'), 'utf8');

// The pick helpers sit between these two markers. Slicing keeps the test on
// the real code; if either marker moves the test fails loudly rather than
// quietly checking a copy.
const START = '  /** How near a click has to land, in CSS pixels. */';
const END = '  function paintGrenades()';
assert.ok(src.includes(START) && src.includes(END), 'the pick helpers are where the test expects');
const body = src.slice(src.indexOf(START), src.indexOf(END)).replace(/\/\*\*[\s\S]*?\*\//g, '');

const ctx = {
  grenadeHits: [],
  grenadePicks: [],
  mapEl: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }
};
const { grenadeAt, groupFor, isPicked, distToSegment } = new Function(
  'ctx',
  `with (ctx) { ${body}; return { grenadeAt, groupFor, isPicked, distToSegment }; }`
)(ctx);

/** One drawn grenade: world positions for grouping, screen ones for clicking. */
const nade = (file, key, land, from) => ({
  file,
  key,
  label: key,
  hasOrigin: Boolean(from),
  whx: land[0],
  why: land[1],
  wox: from ? from[0] : NaN,
  woy: from ? from[1] : NaN,
  hx: land[0],
  hy: land[1],
  ox: from ? from[0] : land[0],
  oy: from ? from[1] : land[1]
});

// Two smokes landing together from opposite corners, one landing far away but
// thrown from the same corner as the first, and a molotov on top of the pile.
ctx.grenadeHits = [
  nade('r1', 'smoke', [100, 100], [0, 0]),
  nade('r2', 'smoke', [150, 120], [600, 600]),
  nade('r3', 'smoke', [400, 400], [5, 8]),
  nade('r4', 'molotov', [101, 101], [1, 1])
];
const seed = ctx.grenadeHits[0];

// ---------------------------------------------------------------------------
// What each modifier can click
// ---------------------------------------------------------------------------

{
  // Halfway along the first smoke's flight: on the line, near neither end.
  assert.ok(grenadeAt(50, 50, 'both'), 'a plain click takes the trajectory');
  assert.equal(grenadeAt(50, 50, 'landing'), null, 'Alt ignores the line');
  assert.equal(grenadeAt(50, 50, 'origin'), null, 'and so does Shift+Alt');

  assert.ok(grenadeAt(100, 100, 'landing'), 'Alt takes the landing');
  assert.equal(grenadeAt(150, 120, 'origin'), null, 'Shift+Alt does not');

  assert.ok(grenadeAt(0, 0, 'origin'), 'Shift+Alt takes the throw spot');
  assert.ok(grenadeAt(0, 0, 'both'), 'and a plain click takes it too');

  assert.equal(grenadeAt(9000, 9000, 'both'), null, 'empty map is empty');
}

// ---------------------------------------------------------------------------
// What a pick spreads to
// ---------------------------------------------------------------------------

{
  // One click is one instance; the pick is the call it belongs to.
  assert.deepEqual(
    groupFor(seed, 'landing').files,
    ['r1', 'r2'],
    'landing groups the smokes that end up in the same place'
  );
  assert.deepEqual(
    groupFor(seed, 'origin').files,
    ['r1', 'r3'],
    'origin groups the ones thrown out of the same corner'
  );
  assert.deepEqual(
    groupFor(seed, 'both').files,
    ['r1', 'r2'],
    'a whole-throw pick groups on where it lands'
  );

  // A molotov landing on the same tile is a different call.
  assert.equal(
    groupFor(seed, 'landing').files.includes('r4'),
    false,
    'grouping never crosses grenade types'
  );

  // Origin grouping cannot take a grenade with no recorded throw point.
  ctx.grenadeHits.push(nade('r5', 'smoke', [105, 105], null));
  assert.equal(
    groupFor(seed, 'origin').files.includes('r5'),
    false,
    'a throw with no origin is not in an origin group'
  );
  assert.ok(
    groupFor(seed, 'landing').files.includes('r5'),
    'though it still lands somewhere'
  );
  ctx.grenadeHits.pop();
}

// ---------------------------------------------------------------------------
// What counts as picked, once something is
// ---------------------------------------------------------------------------

{
  ctx.grenadePicks = [{ mode: 'landing', key: 'smoke', x: 100, y: 100, files: ['r1', 'r2'] }];
  assert.ok(isPicked(ctx.grenadeHits[1]), 'the neighbour is in the pick');
  assert.equal(isPicked(ctx.grenadeHits[2]), null, 'the far one is not');
  assert.equal(isPicked(ctx.grenadeHits[3]), null, 'and neither is the molotov');

  // Switching the pick to origins changes which grenades belong to it.
  ctx.grenadePicks = [{ mode: 'origin', key: 'smoke', x: 0, y: 0, files: ['r1', 'r3'] }];
  assert.ok(isPicked(ctx.grenadeHits[2]), 'the far landing is in an origin pick');
  assert.equal(isPicked(ctx.grenadeHits[1]), null, 'and the far origin is out of it');

  ctx.grenadePicks = [];
  assert.equal(isPicked(ctx.grenadeHits[0]), null, 'nothing is picked when nothing is picked');
}

// ---------------------------------------------------------------------------
// Point to segment
// ---------------------------------------------------------------------------

{
  assert.equal(distToSegment(5, 0, 0, 0, 10, 0), 0, 'on the line');
  assert.equal(distToSegment(5, 3, 0, 0, 10, 0), 3, 'beside it');
  assert.equal(distToSegment(-4, 0, 0, 0, 10, 0), 4, 'past the near end, not projected onto it');
  assert.equal(distToSegment(14, 0, 0, 0, 10, 0), 4, 'and past the far end');
  assert.equal(distToSegment(3, 4, 0, 0, 0, 0), 5, 'a zero-length throw is just its point');
}

console.log('grenadePicks.test.js ok');

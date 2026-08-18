// Run: node shared/sim3d/smokeVolume.test.js
//
// The two things that make a CS2 smoke a CS2 smoke, and neither is a look:
// the VOLUME is conserved, so a cloud squeezed into a corridor runs further
// down it; and an HE opens a hole that closes itself again.
//
// The fire spread lives here too, because it is the same shape of claim: it is
// deterministic (CS:GO's was not) and it runs downrange.

import {
  buildSmokeVolume,
  stepSmokeVolume,
  pushSmoke,
  cellOpacity,
  smokeBlocks,
  smokeBudget,
  SMOKE_RADIUS,
  SMOKE_CELL,
  SMOKE_SECONDS,
  SMOKE_REFILL,
  SMOKE_KNIT
} from './smokeVolume.js';
import {
  buildFireSpread,
  MAX_FLAMES,
  FIRE_RANGE,
  FIRE_RANGE_INC,
  FIRE_SECONDS,
  FIRE_DIEBACK_AT,
  FIRE_SPREAD_SECONDS,
  FLAME_SPACING
} from './fireSpread.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

/** Open air. */
const OPEN = null;
/** A world of axis-aligned solid boxes, Source frame. */
const boxWorld = (boxes) => ({
  solidAt(x, y, z, half) {
    for (const b of boxes) {
      if (x + half < b.min[0] || x - half > b.max[0]) continue;
      if (y + half < b.min[1] || y - half > b.max[1]) continue;
      if (z + half < b.min[2] || z - half > b.max[2]) continue;
      return true;
    }
    return false;
  }
});

// ---- the volume is what is conserved --------------------------------------
{
  const open = buildSmokeVolume({ origin: { x: 0, y: 0, z: 0 }, world: OPEN });
  close(open.cells.length, smokeBudget(), 0, 'an unobstructed smoke spends its whole budget');
  assert(open.budget > 200, `a 144-unit cloud is a few hundred cells, got ${open.budget}`);

  // In the open it settles wide rather than tall: the squat weighting.
  const ext = (axis) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of open.cells) {
      lo = Math.min(lo, c[axis]);
      hi = Math.max(hi, c[axis]);
    }
    return hi - lo;
  };
  assert(ext('x') > ext('z'), `a free cloud is wider than tall (${ext('x').toFixed(0)} vs ${ext('z').toFixed(0)})`);
  close(ext('x'), ext('y'), SMOKE_CELL * 1.5, 'and round in plan');
}

// ---- ...which is why a corridor makes it run -------------------------------
{
  // Two walls 96 units apart down the x axis: a smoke in it cannot spread
  // sideways, so it has to go somewhere else with the same budget.
  const corridor = boxWorld([
    { min: [-2000, 64, -400], max: [2000, 2000, 800] },
    { min: [-2000, -2000, -400], max: [2000, -64, 800] }
  ]);
  const vol = buildSmokeVolume({ origin: { x: 0, y: 0, z: 0 }, world: corridor });
  const open = buildSmokeVolume({ origin: { x: 0, y: 0, z: 0 }, world: OPEN });

  const reach = (v, axis) => Math.max(...v.cells.map((c) => Math.abs(c[axis])));
  assert(reach(vol, 'y') < reach(open, 'y'), 'the walls hold it in');
  assert(reach(vol, 'x') > reach(open, 'x'), `and it runs further down the corridor (${reach(vol, 'x').toFixed(0)} vs ${reach(open, 'x').toFixed(0)})`);
  // Nothing leaked through a wall.
  for (const c of vol.cells) assert(c.y > -64 - SMOKE_CELL && c.y < 64 + SMOKE_CELL, 'no cell is inside a wall');
}

// ---- it does not pour through a sealed box ---------------------------------
{
  // A closet: 192 x 192 x 160, which is about half the volume of a full smoke.
  const W = 96;
  const sealed = boxWorld([
    { min: [-2000, -2000, -2000], max: [2000, 2000, -16] },
    { min: [-2000, -2000, 144], max: [2000, 2000, 2000] },
    { min: [W, -2000, -2000], max: [2000, 2000, 2000] },
    { min: [-2000, -2000, -2000], max: [-W, 2000, 2000] },
    { min: [-2000, W, -2000], max: [2000, 2000, 2000] },
    { min: [-2000, -2000, -2000], max: [2000, -W, 2000] }
  ]);
  const vol = buildSmokeVolume({ origin: { x: 0, y: 0, z: 0 }, world: sealed });
  assert(vol.cells.length > 0, 'a smoke in a closet is still a smoke');
  assert(vol.cells.length < smokeBudget(), `but a closet cannot hold a whole one (${vol.cells.length} of ${smokeBudget()})`);
  for (const c of vol.cells) {
    assert(Math.abs(c.x) < W + SMOKE_CELL && Math.abs(c.y) < W + SMOKE_CELL, `${c.x},${c.y} stayed in the room`);
    assert(c.z > -16 - SMOKE_CELL && c.z < 144 + SMOKE_CELL, `${c.z} stayed between floor and ceiling`);
  }
}

// ---- the same throw makes the same cloud -----------------------------------
{
  const a = buildSmokeVolume({ origin: { x: 12, y: -34, z: 56 }, world: OPEN });
  const b = buildSmokeVolume({ origin: { x: 12, y: -34, z: 56 }, world: OPEN });
  assert(a.cells.length === b.cells.length, 'same cell count');
  for (let i = 0; i < a.cells.length; i++) {
    assert(a.cells[i].x === b.cells[i].x && a.cells[i].y === b.cells[i].y && a.cells[i].z === b.cells[i].z, `cell ${i} identical`);
  }
}

// ---- an HE opens a hole, and the hole closes -------------------------------
{
  const vol = buildSmokeVolume({ origin: { x: 0, y: 0, z: 0 }, world: OPEN });
  // Let it bloom in fully first.
  stepSmokeVolume(vol, 2);
  const solid = vol.cells.filter((_, i) => cellOpacity(vol, i) > 0.5).length;
  assert(solid > 100, 'the cloud is standing');
  assert(smokeBlocks(vol, vol.origin.x, vol.origin.y, vol.origin.z), 'and it blocks its own centre');

  const blown = pushSmoke(vol, vol.origin, 140);
  assert(blown > 0, 'the HE blew cells out');
  assert(!smokeBlocks(vol, vol.origin.x, vol.origin.y, vol.origin.z), 'the middle is open');
  const holed = vol.cells.filter((_, i) => cellOpacity(vol, i) > 0.5).length;
  assert(holed < solid, `fewer cells stand than before (${holed} vs ${solid})`);
  // The rim of the blast knits back almost at once; the middle takes longest.
  stepSmokeVolume(vol, SMOKE_REFILL * 0.5);
  const half = vol.cells.filter((_, i) => cellOpacity(vol, i) > 0.5).length;
  assert(half > holed, 'it is filling back in');
  assert(half < solid, '...but is not there yet');
  stepSmokeVolume(vol, SMOKE_REFILL);
  close(vol.cells.filter((_, i) => cellOpacity(vol, i) > 0.5).length, solid, 2, 'and closes completely');
  assert(smokeBlocks(vol, vol.origin.x, vol.origin.y, vol.origin.z), 'the hole is gone');

  // A blast nowhere near it does nothing.
  assert(pushSmoke(vol, { x: 4000, y: 0, z: 0 }, 140) === 0, 'a distant HE leaves it alone');
}

// ---- and it eventually goes ------------------------------------------------
{
  const vol = buildSmokeVolume({ origin: { x: 0, y: 0, z: 0 }, world: OPEN });
  assert(stepSmokeVolume(vol, SMOKE_SECONDS - 1), 'still up at 17 seconds');
  assert(!stepSmokeVolume(vol, 2), 'gone by 19');
}

// ---- fire: CS2's outward walk, laid down the same way every time -----------
{
  const origin = { x: 0, y: 0, z: 0 };
  const east = buildFireSpread({ origin, dir: { x: 900, y: 0, z: -200 }, type: 'molotov' });
  // The walk gives up after 200 rejected candidates, so it usually stops a
  // little short of the 16 seats it is allowed — which is CS2's behaviour, not
  // a shortfall in ours: the same cap is in the game's own walk spread.
  assert(east.length <= MAX_FLAMES.molotov, `a molotov lays at most ${MAX_FLAMES.molotov} seats`);
  assert(east.length >= 8, `and gets a decent puddle out of them (${east.length})`);

  // CS2's own walk spread draws its angles from Math.random(), so the same
  // throw makes a different puddle every time. Ours seeds off the impact.
  const again = buildFireSpread({ origin, dir: { x: 900, y: 0, z: -200 }, type: 'molotov' });
  for (let i = 0; i < east.length; i++) {
    assert(east[i].x === again[i].x && east[i].y === again[i].y, `seat ${i} lands in the same place every time`);
  }
  const elsewhere = buildFireSpread({ origin: { x: 512, y: -96, z: 0 }, type: 'molotov' });
  assert(
    elsewhere.length !== east.length ||
      elsewhere.some((f, i) => f.x - 512 !== east[i].x || f.y + 96 !== east[i].y),
    'and a throw somewhere else is a different puddle'
  );

  // No seat overlaps another, which is what stops the 16 doubling up.
  for (let a = 0; a < east.length; a++) {
    for (let b = a + 1; b < east.length; b++) {
      const d = Math.hypot(east[a].x - east[b].x, east[a].y - east[b].y);
      assert(d >= FLAME_SPACING * 0.9 - 1e-6, `seats ${a} and ${b} are not on top of each other (${d.toFixed(1)})`);
    }
  }

  // Nothing ever burns past the range.
  for (const f of east) {
    assert(Math.hypot(f.x - origin.x, f.y - origin.y) <= FIRE_RANGE + 1e-6, 'inside inferno_max_range');
  }

  // Every seat but the first grows off one already burning, so the puddle is
  // connected rather than a scatter.
  for (let i = 1; i < east.length; i++) {
    const near = east
      .slice(0, i)
      .some((p) => Math.hypot(p.x - east[i].x, p.y - east[i].y) <= FLAME_SPACING + 1e-6);
    assert(near, `seat ${i} grew off one that was already alight`);
  }

  // It lights one seat at a time over the spread, and goes out last-lit-first.
  assert(east[0].at === 0, 'the bottle lights where it broke, immediately');
  close(east[east.length - 1].at, FIRE_SPREAD_SECONDS, 1e-6, 'and the last seat catches at the end of the spread');
  for (let i = 1; i < east.length; i++) assert(east[i].at >= east[i - 1].at, 'seats light in order');
  for (let i = 1; i < east.length; i++) assert(east[i].out <= east[i - 1].out, 'and go out in reverse');
  assert(east[east.length - 1].out >= FIRE_SECONDS * FIRE_DIEBACK_AT, 'nothing goes out before the dieback');
  close(east[0].out, FIRE_SECONDS, 1e-6, 'and the last of it burns the full lifetime');

  // An incendiary packs the same seats into a smaller circle.
  const incFire = buildFireSpread({ origin, dir: { x: 900, y: 0, z: -200 }, type: 'incgrenade' });
  for (const f of incFire) {
    assert(Math.hypot(f.x, f.y) <= FIRE_RANGE_INC + 1e-6, 'an incendiary stays inside its own range');
  }
  const reach = (l) => Math.max(...l.map((f) => Math.hypot(f.x, f.y)));
  assert(reach(incFire) < reach(east), 'so it covers less ground than a molotov');
}

// ---- fire follows the floor and does not hang over a drop ------------------
{
  // Ground only on one side of x = 0.
  const world = { groundAt: (x, y, z) => (x < 0 ? null : { x, y, z: 0 }) };
  const flames = buildFireSpread({ origin: { x: 20, y: 0, z: 0 }, dir: { x: -900, y: 0, z: 0 }, type: 'molotov', world });
  for (const f of flames) assert(f.x >= 0, `no flame hangs over the drop (${f.x})`);
  assert(flames.length > 1, 'and it still burns on the side that has a floor');
}

// ---- the hole an HE opens is a HOLE ---------------------------------------
{
  // The knit-back used to run over the whole hold, which made the opacity come
  // out as exactly distance/radius: a soft cone with a gap only at the dead
  // centre. Standing in a smoke an HE had just gone off in, you could still not
  // see out of it.
  const vol = buildSmokeVolume({ origin: { x: 0, y: 0, z: 0 }, world: OPEN });
  stepSmokeVolume(vol, 2);
  const standing = vol.cells.filter((_, i) => cellOpacity(vol, i) > 0.5).length;
  pushSmoke(vol, vol.origin, 140);

  const inBlast = vol.cells
    .map((c, i) => ({ i, d: Math.hypot(c.x - vol.origin.x, c.y - vol.origin.y, c.z - vol.origin.z) }))
    .filter((c) => c.d < 100);
  assert(inBlast.length > 10, 'the blast covers a good few cells');
  for (const { i, d } of inBlast) {
    assert(cellOpacity(vol, i) === 0, `a cell ${d.toFixed(0)} units from the blast is gone, not dimmed`);
  }

  // ...and it closes, rim first.
  stepSmokeVolume(vol, SMOKE_REFILL + SMOKE_KNIT);
  const back = vol.cells.filter((_, i) => cellOpacity(vol, i) > 0.5).length;
  assert(back > standing * 0.9, `the hole knits shut again (${back} of ${standing})`);
}

// ---- a canister that lands against a wall still blooms ---------------------
{
  // `solidAt` is asked about a box nearly a cell wide, so a pop within about
  // half a cell of a wall reports its own origin solid. That used to end the
  // fill on its first step and leave a one-cell smoke; measured on Nuke, every
  // smoke inside 25 units of a wall came out that way.
  const wall = (X) => ({ solidAt: (x, _y, _z, half) => x + half * 0.9 > X });
  const open = buildSmokeVolume({ origin: { x: -400, y: 0, z: 0 }, world: wall(0) });
  for (const back of [4, 10, 16, 25]) {
    const vol = buildSmokeVolume({ origin: { x: -back, y: 0, z: 0 }, world: wall(0) });
    assert(
      vol.cells.length > open.cells.length * 0.9,
      `a smoke ${back} units off a wall still fills (${vol.cells.length} of ${open.cells.length})`
    );
    for (const c of vol.cells) assert(c.x < SMOKE_CELL, `and none of it is inside the wall (${c.x})`);
  }
  // Genuinely buried is still allowed to give up, with something to draw.
  const buried = buildSmokeVolume({ origin: { x: 0, y: 0, z: 0 }, world: { solidAt: () => true } });
  assert(buried.cells.length === 1, 'a smoke inside geometry keeps one cell');
}

console.log('smokeVolume.test: ok');

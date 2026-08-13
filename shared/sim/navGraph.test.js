// Run: node shared/sim/navGraph.test.js
//
// Two halves. The synthetic half pins the behaviour that matters and can fail
// loudly: corners are not cut, walls are not crossed, the cost functor actually
// reroutes, world and cell coordinates round-trip, and an unreachable target
// answers null rather than hanging.
//
// The real half runs against Inferno's actual radar mask when it is present,
// because a graph that passes on a chessboard and fails on a map is worth
// nothing. It skips rather than fails when the mask is missing, so the suite
// still runs on a machine without the map data.

import {
  CELL_PIXELS,
  GRID,
  NavGraph,
  RADAR_SIZE,
  anchorId,
  buildNavGraph,
  coarsenMask,
  findPath,
  navGraphFromBake
} from './navGraph.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const CAL = { posX: -2087, posY: 3870, scale: 4.9 }; // Inferno

/** A lattice with everything walkable, then callers carve walls into it. */
function openGrid() {
  return new Uint8Array(GRID * GRID).fill(1);
}
function graphFrom(grid) {
  return new NavGraph('TEST', grid, CAL);
}
const cell = (g, cx, cy) => {
  g[cy * GRID + cx] = 0;
};

// ---- coarsening -------------------------------------------------------------

{
  const mask = new Uint8Array(RADAR_SIZE * RADAR_SIZE);
  // Fill exactly one lattice cell's block, fully.
  for (let py = 0; py < CELL_PIXELS; py += 1) {
    for (let px = 0; px < CELL_PIXELS; px += 1) {
      mask[(10 * CELL_PIXELS + py) * RADAR_SIZE + (7 * CELL_PIXELS + px)] = 1;
    }
  }
  const grid = coarsenMask(mask);
  assert(grid[10 * GRID + 7] === 1, 'a fully walkable block becomes a walkable cell');
  assert(grid[10 * GRID + 8] === 0, 'and its neighbour does not');

  // Three pixels is below the quarter-block threshold.
  const sparse = new Uint8Array(RADAR_SIZE * RADAR_SIZE);
  for (let i = 0; i < 3; i += 1) sparse[20 * CELL_PIXELS * RADAR_SIZE + 20 * CELL_PIXELS + i] = 1;
  assert(coarsenMask(sparse)[20 * GRID + 20] === 0, 'three walkable pixels is not a cell');
}

{
  let threw = false;
  try {
    coarsenMask(new Uint8Array(16));
  } catch {
    threw = true;
  }
  assert(threw, 'a wrong-sized mask is rejected rather than silently coarsened');
}

// ---- coordinates round-trip -------------------------------------------------

{
  const g = graphFrom(openGrid());
  for (const [cx, cy] of [[0, 0], [128, 128], [255, 255], [12, 200]]) {
    const w = g.worldAt(cx, cy);
    const back = g.cellAt(w.x, w.y);
    assert(back.cx === cx && back.cy === cy, `cell ${cx},${cy} round-trips through world`);
  }
  // Cell size in units follows the map's scale.
  assert(Math.abs(g.cellUnits - 4.9 * 4) < 1e-9, 'cell is scale * CELL_PIXELS units across');
}

// ---- nearestWalkable --------------------------------------------------------

{
  const grid = openGrid();
  // Carve a solid block and drop a point in the middle of it.
  for (let y = 100; y < 110; y += 1) for (let x = 100; x < 110; x += 1) cell(grid, x, y);
  const g = graphFrom(grid);

  const inside = g.worldAt(105, 105);
  const found = g.nearestWalkable(inside.x, inside.y);
  assert(found, 'a point inside geometry still resolves to a cell');
  assert(!g.isWalkableCell(105, 105), 'the original cell really was solid');
  assert(g.isWalkableCell(found.cx, found.cy), 'and the answer is walkable');
  assert(Math.max(Math.abs(found.cx - 105), Math.abs(found.cy - 105)) <= 6, 'and it is nearby');

  // A point in a sealed void does not resolve, and says so.
  const sealed = new Uint8Array(GRID * GRID);
  const g2 = graphFrom(sealed);
  const w = g2.worldAt(50, 50);
  assert(g2.nearestWalkable(w.x, w.y) === null, 'an unreachable point answers null');
}

// ---- pathing ----------------------------------------------------------------

{
  const g = graphFrom(openGrid());
  const p = findPath(g, { cx: 10, cy: 10 }, { cx: 20, cy: 10 });
  assert(p, 'a straight open path is found');
  assert(p.cells.length === 11, `and is 11 cells long (was ${p.cells.length})`);
  assert(Math.abs(p.units - 10 * g.cellUnits) < 1e-6, 'and its length in units is right');
  assert(p.cells[0].cx === 10 && p.cells[p.cells.length - 1].cx === 20, 'endpoints are correct');
}

{
  // A wall with one gap: the path must go through the gap.
  const grid = openGrid();
  for (let y = 0; y < GRID; y += 1) if (y !== 128) cell(grid, 60, y);
  const g = graphFrom(grid);
  const p = findPath(g, { cx: 40, cy: 10 }, { cx: 80, cy: 10 });
  assert(p, 'a path exists through the gap');
  assert(p.cells.some((c) => c.cx === 60 && c.cy === 128), 'and it goes through the gap');
  assert(!p.cells.some((c) => c.cx === 60 && c.cy !== 128), 'and never through the wall');
}

{
  // A sealed room: null, not a hang and not a wrong answer.
  const grid = openGrid();
  for (let y = 50; y <= 60; y += 1) {
    for (let x = 50; x <= 60; x += 1) {
      if (y === 50 || y === 60 || x === 50 || x === 60) cell(grid, x, y);
    }
  }
  const g = graphFrom(grid);
  const p = findPath(g, { cx: 55, cy: 55 }, { cx: 100, cy: 100 });
  assert(p === null, 'a sealed target is unreachable');
}

{
  // Corners are not cut. A diagonal gap between two walls is not a doorway.
  const grid = openGrid();
  cell(grid, 100, 101);
  cell(grid, 101, 100);
  const g = graphFrom(grid);
  assert(!g.canStep(100, 100, 1, 1), 'a diagonal between two blocked orthogonals is illegal');
  cell(grid, 101, 100); // still blocked
  const grid2 = openGrid();
  cell(grid2, 100, 101); // only one side blocked
  const g2 = graphFrom(grid2);
  assert(g2.canStep(100, 100, 1, 1), 'a diagonal past one blocked orthogonal is legal');
}

{
  // The cost functor reroutes without touching the graph, which is what the
  // safest/retreat route types are built on.
  const g = graphFrom(openGrid());
  const straight = findPath(g, { cx: 10, cy: 128 }, { cx: 40, cy: 128 });
  const danger = (cx, cy) => (cy === 128 && cx > 10 && cx < 40 ? 50 : 1);
  const around = findPath(g, { cx: 10, cy: 128 }, { cx: 40, cy: 128 }, { cost: danger });
  assert(straight && around, 'both routes exist');
  assert(
    around.cells.filter((c) => c.cy === 128).length < straight.cells.length,
    'the costed route avoids the expensive corridor'
  );
  assert(around.units >= straight.units, 'and it is not shorter in real distance');
}

{
  // Infinity in the cost functor is impassable, and only for this query.
  const g = graphFrom(openGrid());

  // A barrier with a gap at the bottom: the route must detour through it.
  const withGap = (cx, cy) => (cx === 60 && cy < 200 ? Infinity : 1);
  const around = findPath(g, { cx: 40, cy: 10 }, { cx: 80, cy: 10 }, { cost: withGap });
  assert(around, 'a route exists around an infinite-cost barrier that has a gap');
  assert(
    !around.cells.some((c) => c.cx === 60 && c.cy < 200),
    'and it never enters an infinite-cost cell'
  );
  assert(around.cells.some((c) => c.cx === 60 && c.cy >= 200), 'it uses the gap');

  // A barrier with no gap is genuinely unreachable, and says so rather than
  // returning a route that walks through it.
  const sealed = (cx) => (cx === 60 ? Infinity : 1);
  assert(
    findPath(g, { cx: 40, cy: 10 }, { cx: 80, cy: 10 }, { cost: sealed }) === null,
    'a sealed infinite-cost barrier makes the target unreachable'
  );

  // The graph itself was never modified by either query.
  const plain = findPath(g, { cx: 40, cy: 10 }, { cx: 80, cy: 10 });
  assert(plain && plain.cells.length === 41, 'the uncosted route is unchanged and direct');
}

// ---- anchors ----------------------------------------------------------------

assert(anchorId('Banana Car') === 'banana_car', 'anchor ids are snake case');
assert(anchorId('  2nd Mid  ') === '2nd_mid', 'and are trimmed');
assert(anchorId('B-Site!') === 'b_site', 'and drop punctuation');

{
  // Painted positions are regions, not points: {name, pieces:[{type,x,y,w,h}]}.
  const { pointInPiece } = await import('../../src/replays/zones/zoneGeom.js');

  const grid = openGrid();
  for (let y = 100; y < 110; y += 1) for (let x = 100; x < 110; x += 1) cell(grid, x, y);
  const g = graphFrom(grid);

  // A rect covering cells 20..24 in both axes. World Y grows north while cell
  // Y grows south, so the rect's y is taken from the lower-numbered cell row.
  // Padded by half a cell so the boundary convention of pointInRect (which
  // edges count as inside) does not decide how many cells this covers.
  const pad = g.cellUnits / 2;
  const a = g.worldAt(20, 24);
  const b = g.worldAt(24, 20);
  const region = {
    type: 'rect',
    x: a.x - pad,
    y: a.y - pad,
    w: b.x - a.x + 2 * pad,
    h: b.y - a.y + 2 * pad
  };

  const solidCentre = g.worldAt(105, 105);
  const inWall = {
    type: 'rect',
    x: solidCentre.x - 10,
    y: solidCentre.y - 10,
    w: 20,
    h: 20
  };

  const report = g.attachPositions(
    [
      { id: 'p1', name: 'Banana Car', pieces: [region] },
      { id: 'p2', name: 'In A Wall', pieces: [inWall] },
      { id: 'p3', name: 'No Pieces', pieces: [] }
    ],
    pointInPiece
  );

  assert(report.attached === 2, `two positions attach (got ${report.attached})`);
  assert(report.skipped.length === 1 && report.skipped[0] === 'No Pieces', 'a pieceless position is skipped');
  assert(report.empty.length === 1 && report.empty[0] === 'In A Wall', 'a position over solid ground is reported');

  const car = g.anchor('banana_car');
  assert(car, 'the anchor resolves');
  assert(car.cells.length >= 20, `it covers its cells (${car.cells.length})`);
  assert(g.isWalkableCell(car.cx, car.cy), 'its anchor cell is walkable');
  assert(car.cells.includes(car.cy * GRID + car.cx), 'and lies inside the region, not merely near it');
  assert(g.anchor('Banana Car'), 'addressable by display name too');
  assert(g.anchor('nope') === null, 'an unknown anchor is null, not a throw');
  assert(g.positionAt(car.cx, car.cy)?.id === 'banana_car', 'and a covered cell maps back to it');
}

{
  // Stacked maps: two floor plans over the same world x/y, split by z. On Nuke
  // "Ramp" (lower) and "Heaven" (default) are the same radar pixels, so a
  // graph that is not level-aware answers one of them at random, rasterizes
  // lower positions against the upper floor plan, and cannot path between them.
  const { pointInPiece } = await import('../../src/replays/zones/zoneGeom.js');

  // Upper occupies the west of the map, lower the east, and they overlap in a
  // three-column ramp at cx 40..42 which is the only place a body changes floor.
  const upper = openGrid();
  const lower = openGrid();
  for (let cy = 0; cy < GRID; cy += 1) {
    for (let cx = 0; cx < GRID; cx += 1) {
      if (cx > 42) upper[cy * GRID + cx] = 0;
      if (cx < 40) lower[cy * GRID + cx] = 0;
    }
  }

  const g = new NavGraph('NUKE_LIKE', { default: upper, lower }, { ...CAL, lowerZ: -495 });
  assert(g.levels.length === 2, 'the graph carries both levels');
  assert(g.levelFor(0) === 'default', 'a body above the split is on the default level');
  assert(g.levelFor(-800) === 'lower', 'and below it is on the lower one');
  assert(g.levelFor(undefined) === 'default', 'an unknown z does not crash');

  const stairs = g.transitionCells();
  assert(stairs.length === 3 * GRID, `only the ramp is walkable on both (${stairs.length})`);
  assert(
    stairs.every((i) => i % GRID >= 40 && i % GRID <= 42),
    'and the overlap is exactly the ramp columns'
  );

  // A position painted on the lower level rasterizes against the lower floor
  // plan, not the upper one.
  const a = g.worldAt(200, 60);
  const b = g.worldAt(204, 56);
  const pad = g.cellUnits / 2;
  const region = {
    type: 'rect',
    x: a.x - pad,
    y: a.y - pad,
    w: b.x - a.x + 2 * pad,
    h: b.y - a.y + 2 * pad
  };
  const report = g.attachPositions(
    [
      { id: 'l', name: 'B Site', level: 'lower', pieces: [region] },
      { id: 'u', name: 'Heaven', level: 'default', pieces: [region] }
    ],
    pointInPiece
  );

  const bSite = g.anchor('b_site');
  assert(bSite && bSite.cells.length > 0, 'the lower position covers lower-level ground');
  assert(g.positionAt(bSite.cx, bSite.cy, 'lower')?.id === 'b_site', 'lookups are per level');
  // The identical rect declared on the upper level covers nothing there and is
  // nowhere near upper-level ground, so it is skipped and reported rather than
  // silently snapped onto the wrong floor.
  assert(!g.anchor('heaven'), 'a position painted off its own level is not attached');
  assert(report.skipped.includes('Heaven'), 'and it is reported as skipped');

  // The route between floors exists and uses the stairwell exactly once.
  const route = findPath(g, { cx: 10, cy: 10, level: 'default' }, { cx: 200, cy: 60, level: 'lower' });
  assert(route, 'a body can walk from the upper floor to the lower one');
  const changes = route.cells.filter((c, i) => i && c.level !== route.cells[i - 1].level);
  assert(changes.length === 1, `crossing floors happens once (${changes.length})`);
  const at = route.cells.find((c, i) => i && c.level !== route.cells[i - 1].level);
  assert(at.cx >= 40 && at.cx <= 42, 'and it happens on the ramp');

  // A floor change is not lateral travel, so it must not inflate the distance.
  const lateral = route.cells.filter(
    (c, i) => i && (c.cx !== route.cells[i - 1].cx || c.cy !== route.cells[i - 1].cy)
  ).length;
  assert(lateral === route.cells.length - 2, 'exactly one step of the route is a floor change');
}

// ---- against the real map, when it is there ---------------------------------

// Only the load is allowed to fail quietly (a machine without map data still
// runs the suite). Once a mask is in hand, its assertions throw like any other:
// a catch around them would turn a real regression into a silent skip.
let mask = null;
try {
  const { loadRadarMask } = await import('../../scripts/lib/radarMask.mjs');
  mask = await loadRadarMask('INF');
} catch {
  mask = null;
}

let realChecked = false;
let anchorsChecked = 0;
let bakeChecked = false;
{
  if (mask) {
    const g = buildNavGraph('INF', mask, CAL);
    assert(g.walkableCells > 2000, `Inferno has real walkable area (${g.walkableCells} cells)`);
    assert(g.walkableCells < GRID * GRID * 0.6, 'and is mostly not walkable, as a map should be');

    // Endpoints are taken from the mask rather than hard-coded, because this
    // machine has no demo library and therefore no spawn points to borrow. The
    // two furthest-apart walkable cells on a sampled subset are far enough
    // apart to be a real cross-map route on any of these maps.
    const walkable = [];
    for (let cy = 0; cy < GRID; cy += 3) {
      for (let cx = 0; cx < GRID; cx += 3) if (g.isWalkableCell(cx, cy)) walkable.push({ cx, cy });
    }
    assert(walkable.length > 500, 'the sampled lattice has plenty of walkable cells');

    let a = walkable[0];
    let b = walkable[0];
    let far = -1;
    for (const c of walkable) {
      const d = (c.cx - a.cx) ** 2 + (c.cy - a.cy) ** 2;
      if (d > far) {
        far = d;
        b = c;
      }
    }
    // One more pass from b gives a genuinely long pair (the standard two-sweep
    // diameter trick), not just "far from whatever cell happened to be first".
    far = -1;
    for (const c of walkable) {
      const d = (c.cx - b.cx) ** 2 + (c.cy - b.cy) ** 2;
      if (d > far) {
        far = d;
        a = c;
      }
    }

    const p = findPath(g, a, b);
    assert(p, 'a route exists between the two most distant walkable cells');

    const wa = g.worldAt(a.cx, a.cy);
    const wb = g.worldAt(b.cx, b.cy);
    const straight = Math.hypot(wa.x - wb.x, wa.y - wb.y);
    assert(straight > 2000, `the endpoints really are far apart (${Math.round(straight)}u)`);
    // The whole reason this project uses geodesic distance: the walk is longer
    // than the line, on a real map, every time.
    assert(
      p.units >= straight,
      `the walk (${Math.round(p.units)}u) is at least the line (${Math.round(straight)}u)`
    );
    assert(p.units < straight * 4, 'but not absurdly longer, which would mean the mask is broken');

    // Every cell on the returned route is walkable. A path through a wall is
    // the failure this whole file exists to catch.
    assert(
      p.cells.every((c) => g.isWalkableCell(c.cx, c.cy)),
      'every cell on a real route is walkable'
    );

    // The real painted vocabulary, if the zone data has been pulled. This is
    // the check that matters for everything downstream: a movement intent says
    // "advance to banana", and that has to resolve to somewhere stand-able.
    const { getZones } = await import('../../server/zonesStore.js');
    const { pointInPiece } = await import('../../src/replays/zones/zoneGeom.js');
    const net = await getZones('INF');
    if (net?.positions?.length) {
      const report = g.attachPositions(net.positions, pointInPiece);
      assert(report.attached > 40, `most of Inferno's positions attach (${report.attached})`);
      assert(
        report.empty.length <= net.positions.length * 0.15,
        `few positions cover no walkable ground (${report.empty.length}/${net.positions.length}: ${report.empty.join(', ')})`
      );

      // Named routing works end to end, which is the whole point of anchors.
      const banana = g.anchor('banana');
      const bSite = g.anchor('b_site');
      assert(banana && bSite, 'the callouts a T side actually uses are addressable');
      const route = findPath(g, banana, bSite);
      assert(route, 'and a route exists from banana to B site');
      assert(route.units > 200, `which is a real walk (${Math.round(route.units)}u)`);

      // Every anchor is stand-able. An anchor in a wall is a movement intent
      // that can never be satisfied, and it would show up as a stuck bot.
      for (const anchor of g.anchors.values()) {
        assert(g.isWalkableCell(anchor.cx, anchor.cy), `anchor "${anchor.name}" is stand-able`);
      }
      anchorsChecked = g.anchors.size;
    }

    realChecked = true;
  }
}

// ---- the bake round-trips ---------------------------------------------------
// A bake that does not reproduce the graph it was made from is worse than no
// bake, because everything downstream would run on geometry that silently
// differs from what the bake script checked.

{
  const { readFile } = await import('node:fs/promises');
  const { ROOT } = await import('../../server/replays/demoStore.js');
  const pathMod = await import('node:path');
  let bake = null;
  try {
    bake = JSON.parse(
      await readFile(pathMod.join(ROOT, 'sim', 'navcache', 'INF.json'), 'utf8')
    );
  } catch {
    bake = null;
  }

  if (bake) {
    const g = navGraphFromBake(bake);
    assert(g.map === 'INF', 'the bake knows its map');
    assert(g.walkableCells > 2000, 'the lattice survives the round trip');
    assert(g.anchors.size === bake.anchors.length, 'every anchor survives');
    assert(g.spawns.length > 0, 'and the spawns come with it');

    const banana = g.anchor('banana');
    assert(banana && g.isWalkableCell(banana.cx, banana.cy), 'anchors are usable straight off disk');
    assert(g.positionAt(banana.cx, banana.cy), 'and the reverse index was rebuilt');

    // Every spawn resolves. This is the check that decides whether a round can
    // start at all, so it belongs in the suite rather than only in the bake.
    for (const s of g.spawns) {
      assert(g.nearestWalkable(s.x, s.y), `spawn ${s.id} resolves onto the lattice`);
    }

    let threw = false;
    try {
      navGraphFromBake({ ...bake, v: 99 });
    } catch {
      threw = true;
    }
    assert(threw, 'a bake from a different version is refused, not read anyway');
    bakeChecked = true;
  }
}

console.log(
  `navGraph: ok${realChecked ? ' (real Inferno mask' : ' (synthetic only, no radar data'}` +
    `${anchorsChecked ? `, ${anchorsChecked} painted anchors` : ''}` +
    `${bakeChecked ? ', bake round-trip' : ''})`
);

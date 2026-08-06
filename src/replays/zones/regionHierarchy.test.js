// Quick checks for Positions → Zones → Areas hierarchy.
import {
  carvePieceUnderPositions,
  carvePositionsUnder,
  createArea,
  createPosition,
  createZone,
  findPositionByName,
  mergePositions,
  piecesOverlap,
  positionOverlapsOthers,
  positionsOverlapping,
  sanitizeRegionHierarchy
} from './regionHierarchy.js';
import { pieceToRing, ringSignedArea, subtractPieceFromPiece } from './zoneGeom.js';
import { emptyNetwork } from './zoneModel.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const areaOf = (pieces) =>
  pieces.reduce((sum, p) => sum + Math.abs(ringSignedArea(pieceToRing(p))), 0);

{
  const a = { type: 'rect', x: 0, y: 0, w: 100, h: 100 };
  const b = { type: 'rect', x: 50, y: 50, w: 100, h: 100 };
  const c = { type: 'rect', x: 200, y: 200, w: 10, h: 10 };
  assert(piecesOverlap(a, b), 'overlapping rects');
  assert(!piecesOverlap(a, c), 'separate rects');
}

{
  const net = emptyNetwork('NUK');
  const p1 = createPosition(net, {
    name: 'Ramp',
    level: 'default',
    pieces: [{ type: 'rect', x: 0, y: 0, w: 100, h: 100 }]
  });
  assert(p1?.id, 'position id');
  let threw = false;
  try {
    createPosition(net, {
      name: 'Other',
      level: 'default',
      pieces: [{ type: 'rect', x: 40, y: 40, w: 20, h: 20 }]
    });
  } catch (err) {
    threw = err.code === 'OVERLAP';
  }
  assert(threw, 'same-level overlap rejected');

  const p2 = createPosition(net, {
    name: 'Ramp',
    level: 'lower',
    pieces: [{ type: 'rect', x: 40, y: 40, w: 20, h: 20 }]
  });
  assert(p2?.name === 'Ramp', 'same name allowed on other floor');
  assert(p2.level === 'lower', 'lower level stored');

  const zone = createZone(net, { name: 'Yard', positionIds: [p1.id, p2.id] });
  assert(zone?.positionIds.length === 2, 'zone members');
  const area = createArea(net, { name: 'Outside', zoneIds: [zone.id] });
  assert(area?.zoneIds[0] === zone.id, 'area members');
}

{
  const cleaned = sanitizeRegionHierarchy({
    positions: [
      {
        id: 'p_a',
        name: ' Mid ',
        level: 'lower',
        pieces: [{ type: 'poly', ring: [[0, 0], [10, 0], [10, 10]] }]
      }
    ],
    zones: [{ id: 'z_a', name: 'Z', positionIds: ['p_a', 'missing'] }],
    areas: [{ id: 'a_a', name: 'A', zoneIds: ['z_a'] }]
  });
  assert(cleaned.positions[0].name === 'Mid', 'name trimmed');
  assert(cleaned.positions[0].level === 'lower', 'level kept');
  assert(cleaned.zones[0].positionIds.length === 1, 'dangling member dropped');
  assert(cleaned.areas[0].zoneIds[0] === 'z_a', 'area kept');
}

{
  const net = emptyNetwork('INF');
  createPosition(net, {
    name: 'A',
    pieces: [{ type: 'rect', x: 0, y: 0, w: 50, h: 50 }]
  });
  assert(
    !positionOverlapsOthers(net, { type: 'rect', x: 100, y: 100, w: 10, h: 10 }, 'default'),
    'no hit far away'
  );
}

// Carving: rect − rect stays rectangular, a concave cutter takes only its own area.
{
  const parts = subtractPieceFromPiece(
    { type: 'rect', x: 0, y: 0, w: 100, h: 100 },
    { type: 'rect', x: 50, y: 50, w: 100, h: 100 }
  );
  assert(parts.every((p) => p.type === 'rect'), 'rect difference stays rects');
  assert(Math.abs(areaOf(parts) - 7500) < 1e-6, 'rect difference area');

  const lShape = {
    type: 'poly',
    ring: [[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]]
  };
  const left = subtractPieceFromPiece({ type: 'rect', x: 0, y: 0, w: 100, h: 100 }, lShape);
  assert(Math.abs(areaOf(left) - 3600) < 1, 'concave cutter removes only its own area');
}

// New shape on top: the old position gives up the shared ground.
{
  const net = emptyNetwork('INF');
  createPosition(net, { name: 'A', pieces: [{ type: 'rect', x: 0, y: 0, w: 100, h: 100 }] });
  const piece = { type: 'rect', x: 50, y: 0, w: 100, h: 100 };
  assert(positionsOverlapping(net, piece, 'default').length === 1, 'overlap listed');
  const { carved, removed } = carvePositionsUnder(net, piece, 'default');
  assert(carved.length === 1 && !removed.length, 'existing position carved');
  assert(Math.abs(areaOf(net.positions[0].pieces) - 5000) < 1e-6, 'half of A left');
  const b = createPosition(net, { name: 'B', pieces: [piece], allowOverlap: true });
  assert(!positionsOverlapping(net, piece, 'default', b.id).length, 'no overlap remains');
}

// A position swallowed whole is dropped.
{
  const net = emptyNetwork('INF');
  createPosition(net, { name: 'Small', pieces: [{ type: 'rect', x: 10, y: 10, w: 10, h: 10 }] });
  const res = carvePositionsUnder(net, { type: 'rect', x: 0, y: 0, w: 100, h: 100 }, 'default');
  assert(res.removed.length === 1 && !net.positions.length, 'covered position removed');
}

// Existing on top: the new shape is the one that loses the overlap.
{
  const net = emptyNetwork('INF');
  createPosition(net, { name: 'A', pieces: [{ type: 'rect', x: 0, y: 0, w: 100, h: 100 }] });
  const parts = carvePieceUnderPositions(
    net,
    { type: 'rect', x: 50, y: 0, w: 100, h: 100 },
    'default'
  );
  assert(Math.abs(areaOf(parts) - 5000) < 1e-6, 'new piece carved');
  assert(net.positions[0].pieces.length === 1, 'existing position untouched');
}

// Rename onto an existing name merges: pieces join, zone membership follows.
{
  const net = emptyNetwork('INF');
  const a = createPosition(net, { name: 'Ramp', pieces: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10 }] });
  const b = createPosition(net, {
    name: 'Pos 2',
    pieces: [{ type: 'rect', x: 50, y: 50, w: 10, h: 10 }]
  });
  const zone = createZone(net, { name: 'Zone', positionIds: [b.id] });
  assert(findPositionByName(net, 'ramp', 'default', b.id)?.id === a.id, 'name match ignores case');
  const merged = mergePositions(net, a.id, b.id);
  assert(merged.pieces.length === 2 && net.positions.length === 1, 'merged into one position');
  assert(net.zones[0].positionIds[0] === a.id, 'zone follows the merge');
  assert(zone.positionIds.length === 1, 'no dangling member');
}

console.log('regionHierarchy: all assertions passed');

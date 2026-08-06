// Quick checks for Positions → Zones → Areas hierarchy.
import {
  createArea,
  createPosition,
  createZone,
  piecesOverlap,
  positionOverlapsOthers,
  sanitizeRegionHierarchy
} from './regionHierarchy.js';
import { emptyNetwork } from './zoneModel.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

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

console.log('regionHierarchy: all assertions passed');

// Run: node src/replays/eye/roundTypes.test.js
//
// classifyRound on hand-made rounds: a one-lane hit with utility is an execute,
// two lanes at once is a split, mid players who never step on the site do not
// make it a split, a late lurker is a joiner, and utility on the other bombsite
// first is a fake.

import assert from 'node:assert/strict';
import { classifyRound } from './roundTypes.js';

const rect = (x, y, w, h) => ({ type: 'rect', x, y, w, h });
// B site at x 0..100; lanes: "Main" west of it, "Short" north of it, "Mid" far off, "T Spawn" behind main.
const network = {
  positions: [
    { id: 'p1', name: 'Main', pieces: [rect(-300, 0, 300, 100)] },
    { id: 'p2', name: 'Short', pieces: [rect(0, 100, 100, 300)] },
    { id: 'p3', name: 'Mid', pieces: [rect(500, 500, 200, 200)] },
    { id: 'p4', name: 'Site', pieces: [rect(0, 0, 100, 100)] },
    { id: 'p5', name: 'Spawn', pieces: [rect(-900, 0, 300, 100)] }
  ],
  zones: [
    { id: 'z1', name: 'B Main', positionIds: ['p1'] },
    { id: 'z2', name: 'B Short', positionIds: ['p2'] },
    { id: 'z3', name: 'Mid', positionIds: ['p3'] },
    { id: 'z4', name: 'B Site', positionIds: ['p4'] },
    { id: 'z5', name: 'T Spawn', positionIds: ['p5'] }
  ]
};
const SPOT = { Main: [-150, 50], Short: [50, 250], Mid: [600, 600], Site: [50, 50], Spawn: [-750, 50], 'A Ramp': [-150, 50], 'A Palace': [50, 250] };

/** A T round from paths: id -> [[second, place], ...]; each player stays at a place until the next. */
function round(paths, { nades = [], plantAt = null, won = true } = {}) {
  const series = [];
  for (let t = 0; t <= 115; t++) {
    const pts = [];
    for (const [id, steps] of Object.entries(paths)) {
      const at = [...steps].reverse().find(([s]) => s <= t);
      if (!at) continue;
      const [x, y] = SPOT[at[1]];
      pts.push({ id, x, y, pos: at[1] });
    }
    series.push({ tick: t * 64, elapsed: t, pts, opp: [] });
  }
  const sitePieces = { a: [rect(5000, 5000, 10, 10)], b: [rect(0, 0, 100, 100)] };
  const r = {
    side: 'T',
    won,
    ownEcon: 4,
    oppEcon: 4,
    ourIds: Object.keys(paths),
    series,
    sitePieces,
    kills: [],
    nades: nades.map(([t, site, onSite]) => ({ type: 'smokegrenade', throwAt: t, near: site, onSite: onSite ?? site, player: 'p1' })),
    plantClock: plantAt != null ? 115 - plantAt : null,
    plantSite: plantAt != null ? 'b' : null,
    t0: 0,
    tickRate: 64,
    sampleAt: (tick) => series[Math.min(series.length - 1, Math.round(tick / 64))],
    towardCount: () => 0,
    siteEntry: (count) => {
      for (const s of series) if (s.pts.filter((p) => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100).length >= count) return { clock: 115 - s.elapsed, site: 'b', tick: s.tick };
      return null;
    }
  };
  return r;
}

const walk = (...steps) => steps;

// Execute: five through main at 60s with three grenades just before.
let c = classifyRound(
  round(
    { a: walk([0, 'Spawn'], [40, 'Main'], [60, 'Site']), b: walk([0, 'Spawn'], [40, 'Main'], [61, 'Site']), c: walk([0, 'Spawn'], [40, 'Main'], [62, 'Site']), d: walk([0, 'Mid']), e: walk([0, 'Mid']) },
    { nades: [[52, 'b'], [54, 'b'], [56, 'b']], plantAt: 70 }
  ),
  network
);
assert.equal(c.kind, 'execute');
assert.match(c.label, /^B execute/);
assert.deepEqual(c.lanes.map((l) => l.from), ['B Main'], 'mid players who never step on the site are not a lane');

// Split: two through main and one through short inside 12 s.
c = classifyRound(
  round({ a: walk([0, 'Spawn'], [40, 'Main'], [60, 'Site']), b: walk([0, 'Spawn'], [40, 'Main'], [62, 'Site']), c: walk([0, 'Mid'], [40, 'Short'], [64, 'Site']) }, { nades: [[55, 'b'], [56, 'b'], [57, 'b']], plantAt: 72 }),
  network
);
assert.equal(c.kind, 'split');
assert.match(c.label, /^B split \(B Main \+ B Short\)/);

// A lurker who arrives 30 s after the hit is a joiner, not a second lane.
c = classifyRound(
  round({ a: walk([0, 'Spawn'], [40, 'Main'], [60, 'Site']), b: walk([0, 'Spawn'], [40, 'Main'], [61, 'Site']), c: walk([0, 'Spawn'], [40, 'Main'], [62, 'Site']), d: walk([0, 'Mid'], [80, 'Short'], [92, 'Site']) }, { nades: [[55, 'b'], [56, 'b'], [57, 'b']], plantAt: 70 }),
  network
);
assert.equal(c.kind, 'execute');
assert.equal(c.joiners.length, 1);
assert.equal(c.joiners[0].from, 'B Short');

// A player sprinting from spawn straight onto the site has no readable lane: he joins main, no split.
c = classifyRound(
  round({ a: walk([0, 'Spawn'], [40, 'Main'], [60, 'Site']), b: walk([0, 'Spawn'], [40, 'Main'], [61, 'Site']), c: walk([0, 'Spawn'], [62, 'Site']) }, { nades: [[55, 'b'], [56, 'b'], [57, 'b']], plantAt: 70 }),
  network
);
assert.equal(c.kind, 'execute', 'a spawn is never a lane');

// Little utility: a contact play. Utility on the other bombsite first: a fake.
c = classifyRound(round({ a: walk([0, 'Spawn'], [40, 'Main'], [60, 'Site']), b: walk([0, 'Spawn'], [40, 'Main'], [61, 'Site']) }, { nades: [[30, 'a'], [31, 'a']], plantAt: 70 }), network);
assert.equal(c.kind, 'contact');
assert.equal(c.fake, true);
assert.match(c.label, /after a fake A/);

// Nobody reaches a site: no hit.
c = classifyRound(round({ a: walk([0, 'Mid']), b: walk([0, 'Mid']) }, { won: false }), network);
assert.equal(c.kind, 'no-hit');

// CT rounds are not classified.
assert.equal(classifyRound({ ...round({ a: walk([0, 'Mid']) }), side: 'CT' }, network), null);

// Mirage palace and ramp share a zone but are two doors.
c = classifyRound(
  round({ a: walk([0, 'Spawn'], [40, 'A Ramp'], [60, 'Site']), b: walk([0, 'Spawn'], [40, 'A Ramp'], [61, 'Site']), c: walk([0, 'Spawn'], [40, 'A Palace'], [62, 'Site']) }, { nades: [[55, 'b'], [56, 'b'], [57, 'b']], plantAt: 70 }),
  { ...network, positions: network.positions.map((p) => (p.name === 'Main' ? { ...p, name: 'A Ramp' } : p.name === 'Short' ? { ...p, name: 'A Palace' } : p)), zones: [...network.zones.filter((z) => !['z1', 'z2'].includes(z.id)), { id: 'zt', name: 'T A', positionIds: ['p1', 'p2'] }] },
  { mapCode: 'MIR' }
);
assert.equal(c.kind, 'split');
assert.match(c.label, /Ramp \+ Palace/);

console.log('roundTypes.test.js ok');

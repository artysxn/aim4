// Run: node src/replays/eye/roundDescribe.test.js
//
// A coach's line for hand-made rounds: the T side's opening, kind of hit, lane,
// the utility of the hit and who was away from it; the CT side's setup, stack,
// forward moves, rotations and what they did after the plant. What every line
// leaves out matters as much: no kills, no results, no grenade from a minute ago.

import assert from 'node:assert/strict';
import { describeRound, utilityWords } from './roundDescribe.js';

// ---- utility in a coach's words ----
const nade = (type, label, extra = {}) => ({ type, label, zone: label, ...extra });
assert.equal(utilityWords([nade('smokegrenade', 'Doors'), nade('molotov', 'Window'), nade('flashbang', 'Long'), nade('flashbang', 'CT')]), 'smoke Doors, molotov Window, 2 flashes');
assert.equal(utilityWords([nade('smokegrenade', 'Doors'), nade('smokegrenade', 'CT'), nade('smokegrenade', 'Mid')]), 'smokes Doors + CT +1', 'two named, the rest counted');
assert.equal(utilityWords([nade('smokegrenade', 'Doors'), nade('smokegrenade', 'Doors')]), 'smokes 2 Doors');
assert.equal(utilityWords([nade('smokegrenade', '')]), '1 smoke', 'nowhere named: a count');
assert.equal(utilityWords([nade('hegrenade', 'Mid'), nade('hegrenade', 'B')]), '2 HEs', 'an HE only when nothing else went out');
assert.equal(utilityWords([nade('smokegrenade', 'Doors'), nade('hegrenade', 'Mid')]), 'smoke Doors');
assert.equal(utilityWords([nade('smokegrenade', 'Doors'), nade('flashbang', 'Mid')], { flashes: false }), 'smoke Doors');
assert.equal(utilityWords([nade('flashbang', 'Mid')], { flashes: false }), '1 flash', 'unless it is all there is');
assert.equal(utilityWords([]), '');

// ---- hand-made rounds ----
const rect = (x, y, w, h) => ({ type: 'rect', x, y, w, h });
const network = {
  positions: [
    { id: 'p1', name: 'Tunnels', pieces: [rect(-300, 0, 300, 100)] },
    { id: 'p2', name: 'Site', pieces: [rect(0, 0, 100, 100)] },
    { id: 'p3', name: 'Mid', pieces: [rect(500, 500, 200, 200)] },
    { id: 'p4', name: 'Spawn', pieces: [rect(-1500, 0, 300, 100)] },
    { id: 'p5', name: 'Long', pieces: [rect(2000, 2000, 200, 200)] },
    { id: 'p6', name: 'A', pieces: [rect(3000, 3000, 100, 100)] }
  ],
  zones: [
    { id: 'z1', name: 'B Tunnels', positionIds: ['p1'] },
    { id: 'z2', name: 'B Site', positionIds: ['p2'] },
    { id: 'z3', name: 'Mid', positionIds: ['p3'] },
    { id: 'z4', name: 'T Spawn', positionIds: ['p4'] },
    { id: 'z5', name: 'A Long', positionIds: ['p5'] },
    { id: 'z6', name: 'A Site', positionIds: ['p6'] }
  ]
};
const SPOT = { Tunnels: [-150, 50], Site: [50, 50], Mid: [600, 600], Spawn: [-1350, 50], Long: [2100, 2100], A: [3050, 3050], CT: [400, 400] };
const GROUND = { Tunnels: 'b', Site: 'b', Long: 'a', A: 'a' };
const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const nearOf = (x, y) => {
  for (const [name, [sx, sy]] of Object.entries(SPOT)) if (GROUND[name] && Math.hypot(x - sx, y - sy) < 200) return GROUND[name];
  return null;
};

/** A round from paths: id -> [[second, place], ...]; each player stays at a place until the next, or dies. */
function round(paths, { side = 'T', nades = [], plantAt = null, won = true, deaths = {}, opp = {} } = {}) {
  const series = [];
  const read = (table) => (t) =>
    Object.entries(table).flatMap(([id, steps]) => {
      if (deaths[id] != null && t >= deaths[id]) return [];
      const at = [...steps].reverse().find(([s]) => s <= t);
      if (!at) return [];
      const [x, y] = SPOT[at[1]];
      return [{ id, x, y, pos: at[1] === 'CT' ? '' : at[1] }];
    });
  const ours = read(paths);
  const theirs = read(opp);
  for (let t = 0; t <= 115; t++) series.push({ tick: t * 64, elapsed: t, pts: ours(t), opp: theirs(t) });
  const sitePieces = { a: [rect(3000, 3000, 100, 100)], b: [rect(0, 0, 100, 100)] };
  return {
    side,
    won,
    ownEcon: 4,
    oppEcon: 4,
    ourIds: Object.keys(paths),
    series,
    sitePieces,
    kills: Object.entries(deaths).map(([id, t]) => ({ victim: id, victimOurs: true, attackerOurs: false, clock: 115 - t })).sort((a, b) => b.clock - a.clock),
    nades: nades.map(([t, type, label]) => ({ type, label, zone: label, throwAt: t, clock: 115 - t, near: 'b', onSite: label === 'Site' ? 'b' : null, player: 'a' })),
    plantClock: plantAt != null ? 115 - plantAt : null,
    plantSite: plantAt != null ? 'b' : null,
    hitSite: plantAt != null ? 'b' : null,
    t0: 0,
    tickRate: 64,
    sampleAt: (tick) => series[Math.min(series.length - 1, Math.round(tick / 64))],
    towardCount: () => 0,
    siteEntry: (n) => {
      for (const s of series) {
        for (const site of ['a', 'b']) {
          if (s.pts.filter((p) => sitePieces[site].some((piece) => inRect(p, piece))).length >= n) return { clock: 115 - s.elapsed, site };
        }
      }
      return null;
    },
    siteNear: (x, y) => nearOf(x, y)
  };
}
const nameOf = new Map([...'abcde'].map((id) => [id, id.toUpperCase()]));
const five = (steps) => Object.fromEntries([...'abcde'].map((id) => [id, steps]));

// T: a slow default into a full execute. The map control smoke a minute before is not the hit's.
let r = round(five([[0, 'Spawn'], [70, 'Tunnels'], [85, 'Site']]), { nades: [[10, 'smokegrenade', 'Long'], [72, 'smokegrenade', 'Doors'], [74, 'smokegrenade', 'Site'], [76, 'molotov', 'Site'], [77, 'molotov', 'Site'], [80, 'flashbang', 'Site']], plantAt: 92 });
let d = describeRound(r, network, { nameOf });
assert.equal(d.kind, 'execute');
assert.equal(d.site, 'B');
assert.equal(d.on_site, '0:30');
assert.match(d.note, /^(Slow default|Default) into late full 5B execute from Tunnels: smokes Doors \+ Site, molotovs 2 Site, 1 flash$/);
assert.equal(d.utility_before_the_hit, 1);
assert.doesNotMatch(d.note, /Long/, 'map control is not the hit');

// T: one player away from the hit is a lurk; he is not one of the five.
const paths = five([[0, 'Spawn'], [70, 'Tunnels'], [85, 'Site']]);
paths.e = [[0, 'Spawn'], [30, 'Long']];
r = round(paths, { plantAt: 92 });
d = describeRound(r, network, { nameOf });
assert.match(d.note, /4B take through Tunnels, no utility; 1 Long lurk$/);
assert.equal(d.lurk, '1 Long lurk');

// T: a rush says so, with nothing before it.
r = round(five([[0, 'Spawn'], [8, 'Tunnels'], [12, 'Site']]), { plantAt: 20, nades: [[9, 'flashbang', 'Site'], [10, 'flashbang', 'Site']] });
d = describeRound(r, network, { nameOf });
assert.match(d.note, /^Full 5B (rush|pop) through Tunnels: 2 flashes$/);

// T: stopped on the way in: three on the ground, two of them dead at once. Not "no hit", and no kill in the words.
r = round(five([[0, 'Spawn'], [60, 'Tunnels']]), { deaths: { a: 64, b: 66 }, won: false });
d = describeRound(r, network, { nameOf });
assert.equal(d.kind, 'stopped');
assert.match(d.note, /5B take, stopped before the site/);
assert.doesNotMatch(d.note, /kill|died|dead/);

// T: never near a site.
r = round(five([[0, 'Spawn'], [30, 'Mid']]), { won: false, nades: [[35, 'smokegrenade', 'Mid']] });
d = describeRound(r, network, { nameOf });
assert.equal(d.kind, 'no-hit');
assert.match(d.note, /\(5 Mid\), no site hit: smoke Mid$/);

// CT: the setup, A-mid-B. No result, no kills.
const ctSetup = { a: [[0, 'CT'], [15, 'Long']], b: [[0, 'CT'], [15, 'Long']], c: [[0, 'CT'], [15, 'Mid']], d: [[0, 'CT'], [15, 'Site']], e: [[0, 'CT'], [15, 'Site']] };
r = round(ctSetup, { side: 'CT', nades: [[20, 'smokegrenade', 'Tunnels'], [22, 'molotov', 'Site']], opp: five([[0, 'Spawn']]) });
d = describeRound(r, network, { nameOf });
assert.equal(d.kind, 'setup');
assert.equal(d.setup, '2 A, 1 mid, 2 B');
assert.equal(d.note, '2 A, 1 mid, 2 B: smoke Tunnels, molotov Site');

// CT: a stack names itself and does not repeat the site.
r = round({ ...five([[0, 'CT'], [15, 'Site']]), e: [[0, 'CT'], [15, 'Long']] }, { side: 'CT', opp: five([[0, 'Spawn']]) });
d = describeRound(r, network, { nameOf });
assert.equal(d.kind, 'stack');
assert.equal(d.stack, 'B');
assert.match(d.note, /^4B stack, 1 A, no utility$/);

// CT: rotate to the hit, then retake it. Before the plant two leave A for B.
r = round(
  { a: [[0, 'CT'], [15, 'Long'], [60, 'Tunnels']], b: [[0, 'CT'], [15, 'Long'], [62, 'Tunnels']], c: [[0, 'CT'], [15, 'Mid'], [80, 'Site']], d: [[0, 'CT'], [15, 'Tunnels']], e: [[0, 'CT'], [15, 'Tunnels']] },
  { side: 'CT', plantAt: 70, nades: [[75, 'smokegrenade', 'Late']], opp: five([[0, 'Spawn']]) }
);
d = describeRound(r, network, { nameOf });
assert.equal(d.rotate, 'rotate 2 to B');
assert.equal(d.after_plant, 'retake B');
assert.match(d.note, /; rotate 2 to B, retake B$/);
assert.doesNotMatch(d.note, /Late/, 'the utility of the setup: what went out before the plant');

// CT: forward means well into the T side's half, and staying there.
r = round({ a: [[0, 'CT'], [15, 'Spawn']], b: [[0, 'CT'], [15, 'Long']], c: [[0, 'CT'], [15, 'Mid']], d: [[0, 'CT'], [15, 'Site']], e: [[0, 'CT'], [15, 'Site']] }, { side: 'CT', opp: five([[0, 'Spawn']]) });
d = describeRound(r, network, { nameOf });
assert.equal(d.push, '1 push Spawn');

// CT: lost with the bomb down and still alive, nobody went back.
r = round(five([[0, 'CT'], [15, 'Long']]), { side: 'CT', plantAt: 70, won: false, opp: five([[0, 'Spawn']]) });
d = describeRound(r, network, { nameOf });
assert.equal(d.after_plant, 'save');

// No positions: nothing made up.
assert.equal(describeRound({ side: 'T', series: [], nades: [nade('smokegrenade', 'Doors')] }, network).note, '');

console.log('roundDescribe.test.js ok');

// Run: node src/replays/analytics/antistratCoachReads.test.js
//
// Reads taken from the coach's manual sheets (tools/eye/GENERATOR_GAPS.md):
// where the rounds came from, sticking to the call after kills elsewhere,
// players who move as a pair.

import assert from 'node:assert/strict';
import { pairLinesFor, sourcesFor, stubbornReads } from './antistratSummary.js';

// A map with A on the left (x < -1000) and B on the right (x > 1000).
const siteNear = (x) => (x < -1000 ? 'a' : x > 1000 ? 'b' : null);
const at = (id, x, y = 0) => ({ id, x, y, pos: '' });
const enemies = Array.from({ length: 5 }, (_, i) => at(`e${i}`, 0, 5000 + i));

function round(i, { pts, kills = [], site = 'b' }) {
  return {
    file: `r${i}`,
    demoId: `d${i % 3}`,
    side: 'T',
    ownEcon: 4,
    oppEcon: 4,
    hasTicks: true,
    won: false,
    plantSite: site,
    siteEntry: () => ({ site, clock: 40 }),
    kills,
    t0: 0,
    tickRate: 1,
    sampleAt: () => ({ pts, opp: enemies }),
    siteNear
  };
}
const ctx = (rounds, extra = {}) => ({ rounds, mapCode: 'MIR', mains: [], nameOf: new Map(), ...extra });

// Three of them stand B, a kill on A at 1:35, and they still hit B.
const threeB = [at('p1', 2000), at('p2', 2100), at('p3', 2200), at('p4', -2000), at('p5', -2100)];
const killOnA = { attackerOurs: true, clock: 95, x: -2000, y: 0, victimZone: '' };
const stuck = Array.from({ length: 5 }, (_, i) => round(i, { pts: threeB, kills: [killOnA], site: 'b' }));
const [l] = stubbornReads(ctx(stuck), stuck);
assert.ok(l.text.includes('5 of 5'), l.text);
assert.equal(l.tone, 'note');
assert.match(l.after, /stick to the call/);
// The same kill when they then go A is following it.
const follow = stuck.map((r, i) => round(i, { pts: threeB, kills: [killOnA], site: 'a' }));
assert.match(stubbornReads(ctx(follow), follow)[0].after, /rotate to their kills/);
// A kill the main group makes on its own way in says nothing.
const ownWay = stuck.map((r, i) => round(i, { pts: threeB, kills: [{ ...killOnA, x: 2000 }], site: 'b' }));
assert.deepEqual(stubbornReads(ctx(ownWay), ownWay), []);

// p1 and p2 stand together on B at 1:30 in every round; the rest apart.
const pairPts = [at('p1', 2000), at('p2', 2100), at('p3', -2000), at('p4', 0), at('p5', -2000, 3000)];
const pairRounds = Array.from({ length: 12 }, (_, i) => round(i, { pts: pairPts }));
const mains = ['One', 'Two', 'Three', 'Four', 'Five'].map((name, i) => ({ id: `p${i + 1}`, name }));
const pairs = pairLinesFor(ctx(pairRounds, { mains }), 'T');
assert.equal(pairs.size, 1);
assert.equal(pairs.get('p1')[0].text, 'With Two at 1:30 in 12 of 12 rounds, mostly B; then B in 12 of 12.');

// Demos in the order uploaded, a team met twice counted once.
const demo = (id, name2, uploadedAt) => ({ demo: { id, name1: 'Us', name2, uploadedAt }, teamIdx: 1 });
const src = sourcesFor(ctx(stuck, { includedDemos: [demo('d2', 'Other', 3), demo('d0', 'Foe', 1), demo('d1', 'Foe', 2), demo('dX', 'Unused', 0)] }));
assert.equal(src.text, '3 demos, against Foe (2) and Other.');

console.log('antistratCoachReads ok');

// Run: node src/replays/eye/eyeSkills.test.js
//
// aim4 eye's measured skills: weaknesses from rounds, reviewing and rewriting
// an antistrat document.

import assert from 'node:assert/strict';
import { buildRewrite, numbersIn, reviewOutline, similarity } from './docReview.js';
import { findWeaknesses } from './weaknesses.js';

const network = { positions: [{ id: 'p1', name: 'Ramp', pieces: [{}] }, { id: 'p2', name: 'Silo', pieces: [{}] }], zones: [], areas: [] };

function round(file, { side = 'T', own = 4, opp = 4, site = null, won = false, plant = false, kills = [] }) {
  return {
    file, side, ownEcon: own, oppEcon: opp, hasTicks: true, won,
    series: [{ elapsed: 0, pts: [], opp: [] }],
    plantTick: plant ? 1 : null, plantSite: site?.toLowerCase() || null, hitSite: site?.toLowerCase() || null,
    siteEntry: () => null, nades: [], enemyNades: [], kills, firstKill: kills[0] || null, sampleAt: () => null
  };
}
const death = (zone) => ({ attackerOurs: false, victimZone: zone, attackerZone: '', clock: 90 });
const kill = (zone) => ({ attackerOurs: true, attackerZone: zone, victimZone: '', clock: 90 });

// CT side: A holds (8 of 10), B falls (1 of 6); Ramp is where they die first.
const rounds = [];
for (let i = 0; i < 10; i++) rounds.push(round(`a${i}`, { side: 'CT', site: 'A', won: i < 8, kills: [kill('Silo')] }));
for (let i = 0; i < 6; i++) rounds.push(round(`b${i}`, { side: 'CT', site: 'B', won: i < 1, plant: true, kills: [death('Ramp'), death('Ramp')] }));

const w = findWeaknesses(rounds, network, { side: 'CT' });
assert.equal(w.baseline.rounds, 16);
assert.equal(w.baseline.won, 9);
const kinds = w.weaknesses.map((x) => x.kind);
assert.ok(kinds.includes('site'), 'B falls');
assert.ok(w.weaknesses.find((x) => x.kind === 'site').text.startsWith('When B is hit: won 1 of 6'));
assert.ok(kinds.includes('fights'), 'they lose their fights at Ramp');
assert.ok(kinds.includes('opening'), 'opening deaths pile up at Ramp');
assert.ok(!w.weaknesses.some((x) => x.text.includes('When A')), 'A is above their baseline');
assert.ok(w.situations.some((s) => s.text.startsWith('Retakes (the bomb was planted): won 1 of 6')));
// Ranked: every score at least the next one's.
w.weaknesses.forEach((x, i) => i && assert.ok(w.weaknesses[i - 1].score >= x.score));

// Too few rounds is not a weakness.
assert.equal(findWeaknesses(rounds.slice(0, 13), network, { side: 'CT' }).weaknesses.filter((x) => x.kind === 'site').length, 0);

// ---- documents -----------------------------------------------------------
assert.equal(similarity('They smoke Heaven 7 of 10', 'they smoke heaven 9 of 12'), 1);
assert.deepEqual(numbersIn('At 1:30, 7 of 10 (70%)'), ['1:30', '7', '10', '70']);

const fresh = [
  { side: 'T', section: 'Default', text: 'They smoke Heaven early in 9 of 12 rounds (75%).', files: Array.from({ length: 12 }, (_, i) => `r${i}`) },
  { side: 'T', section: 'Pace', text: 'They rush B through Ramp in 8 of 20 rounds (40%).', files: Array.from({ length: 8 }, (_, i) => `p${i}`) }
];
const doc = [
  { side: 'T', section: 'Default', text: '', files: [], heading: true },
  { side: 'T', section: 'Default', text: 'They smoke Heaven early in 7 of 10 rounds (60%).', files: ['r1'] },
  { side: 'T', section: 'Default', text: 'They smoke heaven early in 7 of 10 rounds.', files: [] },
  { side: 'T', section: 'Default', text: 'Their AWP peeks Mid on 12 of 10 rounds.', files: [] },
  { side: 'T', section: 'Default', text: 'They fake A in 2 of 3 rounds.', files: [] },
  { side: 'T', section: 'Retakes', text: '', files: [], heading: true }
];
const review = reviewOutline(doc, fresh);
for (const kind of ['arithmetic', 'impossible', 'duplicate', 'changed', 'unbacked', 'missing', 'empty', 'thin']) {
  assert.ok(review.counts[kind], `finds ${kind}`);
}
assert.ok(review.issues.find((x) => x.kind === 'changed').text.includes('9 of 12'));
assert.ok(review.issues.find((x) => x.kind === 'missing').text.includes('Ramp'));

// The rewrite may only use numbers it was shown, and carries the rounds over.
const known = [...doc.filter((p) => !p.heading), ...fresh];
assert.throws(() => buildRewrite({ title: 'X', sections: [{ heading: 'Default', points: ['They smoke Heaven in 11 of 12 rounds.'] }] }, known, String), /11/);
const out = buildRewrite(
  { title: 'Navi on Nuke', sections: [{ side: 'T side', heading: 'Default', points: ['They smoke Heaven early in 9 of 12 rounds (75%).', 'Their 2 lurkers stay.'] }] },
  known,
  String
);
assert.equal(out.points, 2);
assert.ok(out.html.includes('<h2>T side</h2><h3>Default</h3>'));
assert.ok(out.html.includes('rounds=r0,r1'), 'the matching point keeps its rounds');

console.log('eyeSkills.test.js ok');

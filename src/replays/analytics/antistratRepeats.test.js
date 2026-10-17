import assert from 'node:assert/strict';
import { repeatSmokesFor } from './antistratSummary.js';

const smoke = (label, at, player = 'p1') => ({ type: 'smokegrenade', label, throwAt: at, at, player });
const round = (i, nades) => ({ file: `r${i}`, side: 'T', ownEcon: 4, oppEcon: 4, hasTicks: true, nades });
const ctx = (rounds) => ({ rounds, mains: [], nameOf: new Map() });

// Window thrown twice in every round, 20s apart.
const twice = ctx(Array.from({ length: 5 }, (_, i) => round(i, [smoke('Window', 10 + i * 0.2), smoke('Window', 30)])));
const a = repeatSmokesFor(twice, 'T');
assert.ok(a.lines.some((l) => l.fact.kind === 'repeat' && l.fact.twice === 5), 'twice every round');

// Navi 1 first thrown at 1:40 (20s in) most rounds, at 1:20 (35s in) in some.
const timing = ctx([20, 21, 20, 19, 20, 33, 34].map((t, i) => round(i, [smoke('Navi 1', t)])));
const tl = repeatSmokesFor(timing, 'T').lines.find((l) => l.fact.kind === 'repeat-timing');
assert.ok(tl, 'two timings');
assert.equal(tl.fact.timings.length, 2);
assert.equal(tl.fact.timings[0].n, 5);

// One timing and one throw per round: nothing to say.
const plain = ctx(Array.from({ length: 6 }, (_, i) => round(i, [smoke('Palace', 20)])));
assert.equal(repeatSmokesFor(plain, 'T'), null);
console.log('antistratRepeats ok');

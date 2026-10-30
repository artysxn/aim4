// Run: node src/replays/eye/roundScout.test.js
//
// The scout's question and the answers about one record: words become buckets,
// an argument it does not know is refused instead of ignored, a record fits or
// it does not, and a note that says kills, results or the other team goes back.

import assert from 'node:assert/strict';
import { askedWords, endingOf, noteProblem, parseBuys, parseRange, parseScout, recordFacts, recordFits, ScoutError, subjectSeat, needsPositions, needsRecord, needsSides } from './roundScout.js';

// ---- buys ----
assert.deepEqual([...parseBuys('low')], [1, 2, 3]);
assert.deepEqual([...parseBuys('bought')], [2, 3, 4]);
assert.deepEqual([...parseBuys('eco, force')], [1, 3], 'several words');
assert.deepEqual([...parseBuys(['eco', 'force'])], [1, 3], 'a list');
assert.deepEqual([...parseBuys('full buy')], [4], 'said in full');
assert.equal(parseBuys('any'), null);
assert.equal(parseBuys(undefined), null);
assert.throws(() => parseBuys('expensive'), /Unknown buy "expensive"/);

// ---- ranges ----
assert.deepEqual(parseRange(90), { min: 90, max: 100 });
assert.deepEqual(parseRange('90+'), { min: 90, max: 100 });
assert.deepEqual(parseRange('0-40'), { min: 0, max: 40 });
assert.deepEqual(parseRange({ max: 40 }), { min: 0, max: 40 });
assert.equal(parseRange(undefined), null);
assert.throws(() => parseRange('clean'), ScoutError);
assert.throws(() => parseRange({ min: 50, max: 10 }), ScoutError);

// ---- the question ----
assert.throws(() => parseScout({ map: 'Dust2', enemy: 'HAVU' }), /scout_rounds has no "enemy"/, 'not ignored: left out, every round looks as if it fits');
assert.throws(() => parseScout({ gap: { side: 'T' } }), /gap needs never_below or reaches/);
assert.throws(() => parseScout({ result: 'clean' }), /result is/);
assert.throws(() => parseScout({ first_kill: 'me' }), /first_kill is/);
assert.throws(() => parseScout({ hit: 'fake' }), /hit is/);
assert.throws(() => parseScout({ where: { zone: 'Mid' } }), /where is a list/);
let a = parseScout({ map: 'Dust2', winner: 'team', count: 99 });
assert.equal(a.result, 'won', 'the team won, said the other way round');
assert.equal(a.winner, '');
assert.equal(a.count, 30, 'at most 30');
a = parseScout({ map: 'Dust2', plant: 'b', side: 'ct', first_kill_by: '1:30' });
assert.equal(a.plant, 'B');
assert.equal(a.side, 'CT');
assert.equal(a.firstKillBy, 90);
assert.equal(parseScout({ plant: 'false' }).plant, false);
assert.equal(parseScout({}).count, 8);

// How deep a question reads.
assert.ok(!needsSides(parseScout({ team: 'x', buy: 'full', result: 'won' })), 'a team, a buy and a result are all in the file name');
assert.ok(needsSides(parseScout({ side: 'T' })));
assert.ok(needsSides(parseScout({ dominance: 90 })));
assert.ok(needsSides(parseScout({ sort: 'dominance' })));
assert.ok(!needsRecord(parseScout({ dominance: 90 })));
assert.ok(needsRecord(parseScout({ gap: { reaches: 2 } })));
assert.ok(needsRecord(parseScout({ plant: true })));
assert.ok(!needsPositions(parseScout({ plant: true })));
assert.ok(needsPositions(parseScout({ hit: 'execute' })));
assert.ok(needsPositions(parseScout({ where: [{ site: 'B' }] })));
assert.match(askedWords(parseScout({ team: 'HAVU', side: 'T', buy: 'low', dominance: { min: 90 } })), /HAVU, T side, buy eco or half or force, dominance 90 to 100/);

// ---- who a round is read for ----
const row = { team1: 'AA', team2: 'BB', winner: 2 };
assert.equal(subjectSeat(row, { mine: new Set(['BB']) }), 2);
assert.equal(subjectSeat(row, { mine: new Set(['CC']) }), 0);
assert.equal(subjectSeat(row, { theirs: new Set(['AA']) }), 2, 'the team facing the one named');
assert.equal(subjectSeat(row, { side: 'T', seat1Side: 'T' }), 1);
assert.equal(subjectSeat(row, { side: 'T', seat1Side: 'CT' }), 2);
assert.equal(subjectSeat(row, { side: 'T' }), 0, 'not known until the sides are read');
assert.equal(subjectSeat(row, {}), 2, 'nobody named: the winner');

// ---- a record ----
const players = [...'abcde'].map((id) => ({ id, team: 1, name: `T${id}` })).concat([...'vwxyz'].map((id) => ({ id, team: 2, name: `C${id}` })));
const meta = (over = {}) => ({
  team1Side: 'T',
  winner: 1,
  winnerSide: 'T',
  players,
  tickRate: 64,
  freezeEndTick: 1000,
  startTick: 0,
  events: { kills: [], bomb: [] },
  ...over
});
const kill = (t, attacker, victim) => ({ tick: 1000 + t * 64, attacker, victim });

// T won: the first kill theirs at 1:45, up to 5v3, a player with 3 kills, the bomb down at 1:00.
let m = meta({ events: { kills: [kill(10, 'a', 'v'), kill(20, 'a', 'w'), kill(40, 'a', 'x'), kill(60, 'y', 'b'), kill(65, 'c', 'y'), kill(70, 'c', 'z')], bomb: [{ type: 'planted', tick: 1000 + 55 * 64, x: 5, y: 6 }] } });
let f = recordFacts(m, 'T');
assert.equal(f.won, true);
assert.equal(f.firstKillBy, 'team');
assert.equal(f.firstKillClock, 105);
assert.equal(f.planted, true);
assert.equal(f.plantClock, 60);
assert.equal(f.ending, 'elimination');
assert.equal(f.killsOf('Ta'), 3);
assert.equal(f.killsOf(''), 3, 'anyone on the side');
assert.equal(f.killsOf('nobody'), -1);
assert.equal(f.gaps.max, 3);
assert.equal(recordFacts(m, 'CT').firstKillBy, 'opponent');
const fit = (args, facts = f, site = null) => recordFits(facts, parseScout(args), site).fits;
assert.ok(fit({ first_kill: 'team' }));
assert.ok(!fit({ first_kill: 'opponent' }));
// The clock counts down: a first kill at 1:45 came by 1:40, and not by 1:50.
assert.ok(fit({ first_kill_by: '1:40' }));
assert.ok(!fit({ first_kill_by: '1:50' }));
assert.ok(fit({ plant: true }));
assert.ok(!fit({ plant: false }));
assert.ok(fit({ plant: 'A' }, f, 'A'));
assert.ok(!fit({ plant: 'B' }, f, 'A'));
assert.ok(fit({ plant_by: '0:50' }), 'down at 1:00, so by 0:50');
assert.ok(!fit({ plant_by: '1:10' }));
assert.ok(fit({ ended_by: 'elimination' }));
assert.ok(!fit({ ended_by: 'bomb' }));
assert.ok(fit({ kills: { player: 'Ta', min: 3 } }));
assert.ok(!fit({ kills: { player: 'Ta', min: 4 } }));
assert.ok(fit({ kills: { min: 3 } }));
assert.ok(fit({ gap: { never_below: 0, reaches: 2 } }));
assert.ok(!fit({ gap: { reaches: 4 } }));
// prefer reads this: everything else passed, only the gap did not.
const partly = recordFits(f, parseScout({ first_kill: 'team', gap: { reaches: 4 } }));
assert.deepEqual([partly.fits, partly.rest, partly.gapFits], [false, true, false]);

// How a round ended.
assert.equal(endingOf(meta({ events: { kills: [], bomb: [{ type: 'planted', tick: 2000 }, { type: 'exploded', tick: 3000 }] } })), 'bomb');
assert.equal(endingOf(meta({ winner: 2, winnerSide: 'CT', events: { kills: [], bomb: [{ type: 'planted', tick: 2000 }, { type: 'defused', tick: 3000 }] } })), 'defuse');
assert.equal(endingOf(meta({ winner: 2, winnerSide: 'CT', events: { kills: [kill(10, 'v', 'a')], bomb: [] } })), 'time', 'both sides alive, no bomb, CT won');

// ---- a note ----
assert.equal(noteProblem('Full 5B execute with smoke door + molotov backsite'), '');
assert.equal(noteProblem('Slow default into short pop with 2 smokes & 1 late long lurk'), '');
assert.match(noteProblem('3 B, 1 A, 1 Long: hold B, win the B fights'), /says "win"/);
assert.match(noteProblem('Default, 3 kills in 4 seconds'), /says "kills"/);
assert.match(noteProblem('peku traded fast from mid'), /says "traded"/);
assert.match(noteProblem('x'.repeat(161)), /161 characters/);
assert.match(noteProblem('Fake A, smoke Heaven, then HAVU rotate', { otherNames: ['HAVU', 'aragorn'] }), /names HAVU from the other team/);
assert.equal(noteProblem('Smoke Heaven, walk A', { otherNames: ['HAVU', 'Heave'] }), '', 'a whole name, not part of a word');
assert.equal(noteProblem('Lost B plan', { otherNames: [] }) !== '', true, 'a result is a result');
// "Winning team" words are about the result; a place with such a word in it is not. Win is a whole word only.
assert.equal(noteProblem('Window smoke + Twin molotov'), '');

console.log('roundScout.test.js ok');

// Run: node src/replays/eye/mapRegions.test.js
//
// Regions drawn on a map, from the pixel a pointer was on to the rounds a query
// keeps: the calibration, the inside of a lasso, the floors of Nuke, what the model
// is told, and "Ts smoke here(1) and here(2)" against a fake library.

import assert from 'node:assert/strict';
import { chatRegions, inRegion, nextRegionId, noteRegions, placesIn, pointInPolygon, regionLines, regionRefs, regionWhere, resetRegions, ruleCondition, ruleWords, simplifyLasso } from './mapRegions.js';
import { grenadeOnly, QueryError, regionMap, regionsNamed, runRoundQuery } from './roundQuery.js';
import { grenadesOf, needsPositions, parseScout, regionHits } from './roundScout.js';
import { radarToWorld, worldToRadar } from '../viewer/mapCalibration.js';
import { encodeRoundPacks } from '../shared/roundPackWire.js';
import { runTool } from './eyeTools.js';

// ---- the calibration a drawn point goes through ----
// A pixel and back, and world Y growing north while pixels grow down: Mirage's top-left corner is posX, posY.
let w = radarToWorld('MIR', 0, 0);
assert.deepEqual([w.x, w.y], [-3230, 1713]);
w = radarToWorld('MIR', 100, 200);
assert.deepEqual([w.x, w.y], [-3230 + 500, 1713 - 1000]);
const px = worldToRadar('MIR', w.x, w.y);
assert.deepEqual([px.x, px.y], [100, 200]);

// ---- inside ----
const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
assert.ok(pointInPolygon(5, 5, square));
assert.ok(!pointInPolygon(15, 5, square));
assert.ok(!pointInPolygon(-1, 5, square));
// A lasso with a bite out of it: the bite is outside.
const horseshoe = [[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10]];
assert.ok(pointInPolygon(1, 8, horseshoe));
assert.ok(pointInPolygon(9, 8, horseshoe));
assert.ok(!pointInPolygon(5, 8, horseshoe), 'in the bend');
// One that crosses itself still has an inside.
const bow = [[0, 0], [10, 10], [10, 0], [0, 10]];
assert.ok(pointInPolygon(2, 5, bow));
assert.ok(!pointInPolygon(5, 8, bow));
assert.ok(!inRegion({ map: 'MIR', points: square }, NaN, 5), 'a grenade with no landing');
assert.ok(!inRegion({ map: 'MIR', points: [] }, 5, 5));

// Nuke's floors: the line is z -495; a point with no height still counts.
const lower = { map: 'NUK', floor: 'lower', points: square };
const upper = { map: 'NUK', floor: 'upper', points: square };
assert.ok(inRegion(lower, 5, 5, -600));
assert.ok(!inRegion(lower, 5, 5, -300));
assert.ok(inRegion(upper, 5, 5, -300));
assert.ok(!inRegion(upper, 5, 5, -600));
assert.ok(inRegion(upper, 5, 5, null));

// ---- a freehand path ----
const wobble = Array.from({ length: 500 }, (_, i) => [i * 2 + Math.sin(i) * 3, Math.round(Math.sin(i / 40) * 400) + 0.4]);
const kept = simplifyLasso(wobble);
assert.ok(kept.length <= 40, `kept ${kept.length}`);
assert.ok(kept.length >= 5, 'the curve survives');
assert.ok(kept.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y)), 'whole units');
assert.deepEqual(simplifyLasso([[0, 0], [5, 0.1], [10, 0]]), [[0, 0], [10, 0]], 'a straight line is its ends');
// Even a path nothing can shorten by the first tolerance ends up within the limit.
const zigzag = Array.from({ length: 300 }, (_, i) => [i * 10, i % 2 ? 500 : 0]);
assert.ok(simplifyLasso(zigzag).length <= 40);

// ---- what is said about one ----
const r1 = { id: 1, map: 'MIR', shape: 'rect', points: [[-1000, -1000], [0, -1000], [0, 0], [-1000, 0]], rule: { who: 'T', what: 'smoke' }, match: 'all', place: 'Top Mid, Window' };
const r2 = { id: 2, map: 'MIR', shape: 'lasso', points: [[500, 500], [900, 500], [900, 900], [500, 900]], rule: { who: 'T', what: 'smoke' }, match: 'all', place: '' };
const r3 = { id: 3, map: 'MIR', shape: 'rect', points: square, rule: { who: '', what: '' }, match: 'all', place: '' };
assert.equal(ruleWords(r1.rule), 'T smoke');
assert.equal(ruleWords({ who: 'CT', what: 'utility' }), 'CT any utility');
assert.equal(ruleWords(r3.rule), '');
assert.deepEqual(ruleCondition(r1), { utility: { region: 1, type: 'smoke', who: 'T' } });
assert.deepEqual(ruleCondition({ id: 4, rule: { who: 'CT', what: 'kills' } }), { kill: { region: 4, by: 'CT' } });
assert.deepEqual(ruleCondition({ id: 4, rule: { who: '', what: 'players' } }), { players_in: { region: 4 } });
assert.equal(ruleCondition(r3), null, 'no rule, no condition: the words of the message decide');
assert.deepEqual(regionWhere([r1, r2]), [ruleCondition(r1), ruleCondition(r2)], 'all: the list itself');
assert.deepEqual(regionWhere([{ ...r1, match: 'any' }, { ...r2, match: 'any' }]), [{ any: [ruleCondition(r1), ruleCondition(r2)] }]);
assert.deepEqual(regionWhere([{ ...r1, match: 'any' }]), [ruleCondition(r1)], 'any of one is that one');
const lines = regionLines([r1, r2]).join('\n');
assert.match(lines, /on Mirage/);
assert.match(lines, /Region 1: around Top Mid, Window, rule: T smoke/);
assert.match(lines, /Region 2: rule: T smoke/);
assert.ok(lines.includes('The rules as where: [{"utility":{"region":1,"type":"smoke","who":"T"}},{"utility":{"region":2,"type":"smoke","who":"T"}}]'));
assert.ok(!lines.includes('-1000'), 'no coordinates: a number is all the model needs');
assert.ok(!regionLines([r3]).join('\n').includes('The rules as where'));
assert.deepEqual(regionRefs('Ts smoke here(1) and HERE (2), and here(1) again, not there(3)'), [1, 2]);
assert.equal(nextRegionId([]), 1);
assert.equal(nextRegionId([r1, r3]), 4, 'a number is never used twice in a chat');
assert.equal(placesIn({ points: [[0, 0], [100, 0], [100, 100], [0, 100]] }, (x) => (x < 80 ? ['Mid'] : ['Window'])), 'Mid, Window');
assert.equal(placesIn({ points: [[0, 0], [100, 0], [100, 100], [0, 100]] }, () => []), '');

// ---- conditions with a region ----
const nade = (type, x, y, throwAt = 20, z = 0) => ({ type, x, y, z, throwAt, at: throwAt + 2, zone: '', label: '' });
const round = (file, over = {}) => ({ file, side: 'T', ownEcon: 4, oppEcon: 4, hasTicks: true, series: [], nades: [], enemyNades: [], kills: [], firstKill: null, won: true, ...over });
const inside1 = [-500, -500];
const inside2 = [700, 700];
const both = round('both', { nades: [nade('smokegrenade', ...inside1), nade('smokegrenade', ...inside2)] });
const justOne = round('one', { nades: [nade('smokegrenade', ...inside1), nade('flashbang', ...inside2)] });
const theirs = round('theirs', { enemyNades: [nade('smokegrenade', ...inside1), nade('smokegrenade', ...inside2)] });
const regions = [r1, r2];
const files = (where, list = [both, justOne, theirs]) => runRoundQuery(list, null, { where, regions }).files;
const smokeIn = (region, extra = {}) => ({ utility: { region, type: 'smoke', ...extra } });
assert.deepEqual(files([smokeIn(1), smokeIn(2)]), ['both'], 'a smoke in each');
assert.deepEqual(files([smokeIn(1)]), ['both', 'one']);
assert.deepEqual(files([{ any: [smokeIn(2), { utility: { region: 2, type: 'flash' } }] }]), ['both', 'one'], 'any of them');
assert.deepEqual(files([{ not: smokeIn(2) }]), ['one', 'theirs']);
// Who threw it, by the side or as the team read.
assert.deepEqual(files([smokeIn(1, { who: 'CT' })]), ['theirs']);
assert.deepEqual(files([smokeIn(1, { who: 'opponent' })]), ['theirs']);
assert.deepEqual(files([smokeIn(1, { who: 'T' })]), ['both', 'one']);
const asCt = round('ct', { side: 'CT', enemyNades: [nade('smokegrenade', ...inside1)] });
assert.deepEqual(files([smokeIn(1, { who: 'T' })], [asCt]), ['ct'], 'T is the other side when the team read was CT');
// The window is the clock; a smoke after a late plant still counts when no end was named.
const late = round('late', { nades: [nade('smokegrenade', ...inside1, 125)] });
assert.deepEqual(files([smokeIn(1)], [late]), ['late']);
assert.deepEqual(files([smokeIn(1, { to: '0:00' })], [late]), [], 'a named end holds');
assert.deepEqual(files([smokeIn(1, { from: '1:55', to: '1:00' })], [both]), ['both']);
assert.deepEqual(files([smokeIn(1, { from: '0:30', to: '0:00' })], [both]), []);
assert.deepEqual(files([smokeIn(1, { min: 2 })], [both]), []);
// Players standing there, and kills at either end.
const stood = round('stood', { series: [{ elapsed: 10, pts: [{ x: -500, y: -500 }, { x: -400, y: -400 }, { x: 5000, y: 0 }], opp: [{ x: 700, y: 700 }] }] });
assert.deepEqual(files([{ players_in: { region: 1, min: 2 } }], [stood]), ['stood']);
assert.deepEqual(files([{ players_in: { region: 1, min: 3 } }], [stood]), []);
assert.deepEqual(files([{ players_in: { region: 2, who: 'CT' } }], [stood]), ['stood']);
assert.deepEqual(files([{ region: 2, who: 'CT' }], [stood]), ['stood'], 'the wrapper left out reads as players_in');
const killed = round('killed', { kills: [{ clock: 90, attackerOurs: true, x: 700, y: 700, ax: -500, ay: -500 }] });
killed.firstKill = killed.kills[0];
assert.deepEqual(files([{ kill: { region: 2, by: 'T' } }], [killed]), ['killed'], 'the victim dropped there');
assert.deepEqual(files([{ kill: { region: 1, by: 'T' } }], [killed]), ['killed'], 'the shooter stood there');
assert.deepEqual(files([{ kill: { region: 1, by: 'CT' } }], [killed]), []);
assert.deepEqual(files([{ first_kill: { region: 1, by: 'T' } }], [killed]), ['killed']);
// A number nobody drew is said, not matched against nothing.
assert.throws(() => files([smokeIn(9)]), (e) => e instanceof QueryError && /no region 9\. The user drew 1, 2/.test(e.message));
assert.throws(() => files([{ any: 'x' }]), /"any" is a list/);

// ---- which read a condition needs ----
assert.ok(grenadeOnly(smokeIn(1)));
assert.ok(grenadeOnly({ type: 'smoke', region: 1 }), 'the wrapper left out');
assert.ok(grenadeOnly({ any: [smokeIn(1), smokeIn(2)] }));
assert.ok(grenadeOnly({ not: smokeIn(1) }));
assert.ok(!grenadeOnly({ utility: { type: 'smoke', zone: 'Heaven' } }), 'a zone name needs the map');
assert.ok(!grenadeOnly({ utility: { region: 1, around: 'entry' } }), 'around the entry needs where they stood');
assert.ok(!grenadeOnly({ players_in: { region: 1 } }));
assert.ok(!grenadeOnly({ any: [smokeIn(1), { site: 'A' }] }));
assert.ok(!needsPositions(parseScout({ where: [smokeIn(1), smokeIn(2)] })), 'no movement read for grenades in a region');
assert.ok(needsPositions(parseScout({ where: [smokeIn(1), { site: 'A' }] })));
assert.deepEqual(parseScout({ where: [smokeIn(1), { site: 'A' }] }).grenadeWhere, [smokeIn(1)]);
assert.deepEqual(regionsNamed([smokeIn(1), { not: smokeIn(2) }, { any: [{ kill: { region: 3 } }] }, { site: 'A' }]).sort(), [1, 2, 3]);
assert.equal(regionMap([smokeIn(1)], regions), 'MIR');
assert.equal(regionMap([{ site: 'A' }], regions), '');
assert.throws(() => regionMap([smokeIn(1)], regions, 'NUK'), /drawn on MIR, not NUK/);
assert.throws(() => regionMap([smokeIn(1), smokeIn(5)], [...regions, { ...r1, id: 5, map: 'NUK' }]), /different maps/);
assert.throws(() => regionMap([smokeIn(7)], []), /has drawn none/);

// ---- the same read as a full one, from the grenades alone ----
const metaOf = ({ team1Side = 'T', winner = 1, grenades = [] } = {}) => ({
  team1Side,
  winner,
  freezeEndTick: 1000,
  tickRate: 64,
  players: [{ id: 'a', team: 1 }, { id: 'v', team: 2 }],
  events: { grenades }
});
const thrown = (player, type, x, y, atSeconds) => ({ player, type, throwTick: 1000 + atSeconds * 64, detonateTick: 1000 + (atSeconds + 2) * 64, at: { x, y, z: -50 }, path: [] });
let read = grenadesOf(metaOf({ grenades: [thrown('a', 'smokegrenade', 1, 2, 10), thrown('v', 'inferno', 3, 4, 30), thrown('nobody', 'smokegrenade', 5, 6, 30), thrown('a', 'decoy', 7, 8, 30)] }), 'T');
assert.deepEqual(read.nades.map((g) => [g.type, g.x, g.y, g.z, g.throwAt, g.at]), [['smokegrenade', 1, 2, -50, 10, 12]]);
assert.deepEqual(read.enemyNades.map((g) => g.type), ['molotov'], 'the demo\'s word for a molotov; a decoy and a coach are left out');
assert.equal(read.won, true);
assert.equal(grenadesOf(metaOf({ team1Side: 'CT', grenades: [thrown('a', 'smokegrenade', 1, 2, 10)] }), 'T').enemyNades.length, 1, 'team 1 on CT');
assert.equal(grenadesOf(metaOf({ team1Side: 'CT' }), 'T').won, false);
assert.equal(regionHits({ side: 'T', nades: [nade('smokegrenade', ...inside1, 43), nade('flashbang', ...inside1), nade('smokegrenade', ...inside2, 45)], enemyNades: [] }, [smokeIn(1), { any: [smokeIn(2)] }], regions), '1: smoke 1:12; 2: smoke 1:10');

// ---- the chat's regions ----
resetRegions();
assert.deepEqual(chatRegions(), []);
noteRegions([r1]);
noteRegions([r1, r2]);
assert.deepEqual(chatRegions().map((r) => r.id), [1, 2], 'a retried message does not add them twice');
resetRegions([r2]);
assert.deepEqual(chatRegions().map((r) => r.id), [2]);

// ---- "find me rounds where Ts throw smokes here(1) and here(2) and win with higher dominance" ----
const demos = [{ id: 'm1', m: 'MIR', t1: 'AA', t2: 'BB', n1: 'Alpha', n2: 'Bravo', u: Date.UTC(2026, 9, 18) }];
/** Team 1 is T in rounds 1 to 12. */
const library = new Map();
const add = (n, { winner = 1, dom = 80, grenades = [] }) => {
  const file = `AA-BB-1${winner}0-MIR-${String(n).padStart(2, '0')}_x~m1`;
  library.set(file, {
    dom,
    row: { file, round: n, team1: 'AA', team2: 'BB', winner, econ1: 4, econ2: 4, map: 'MIR', mapName: 'Mirage' },
    meta: { ...metaOf({ winner, grenades }), id: file, map: 'MIR', round: n, team1: { id: 'AA', name: 'Alpha' }, team2: { id: 'BB', name: 'Bravo' }, team2Side: 'CT', econ1: 4, econ2: 4, notes: [] }
  });
};
const smokes = [thrown('a', 'smokegrenade', ...inside1, 20), thrown('a', 'smokegrenade', ...inside2, 22)];
add(1, { dom: 60, grenades: smokes });
add(2, { dom: 95, grenades: smokes }); // the cleanest
add(3, { dom: 99, grenades: [smokes[0]] }); // cleaner, but only one of the two
add(4, { dom: 99, winner: 2, grenades: smokes }); // the Ts lost
add(5, { dom: 99, grenades: [thrown('v', 'smokegrenade', ...inside1, 20), thrown('v', 'smokegrenade', ...inside2, 22)] }); // the CTs threw them
add(6, { dom: 99, grenades: [thrown('a', 'flashbang', ...inside1, 20), thrown('a', 'flashbang', ...inside2, 22)] }); // not smokes
const asked = { dominance: 0, packs: 0, meta: 0, ticks: 0, packFiles: 0 };
const roster = { players: [{ i: 'p1', n: 'x' }], demos: demos.map((d) => ({ ...d, p: [0, 0, 0, 0] })) };
let packsAnswer = 'ok';
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url), 'http://x');
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/api/replays/roster') return json(roster);
  if (u.pathname === '/api/replays/rounds/dominance') {
    asked.dominance++;
    const rounds = {};
    for (const file of JSON.parse(init.body).files) {
      const hit = library.get(file);
      const won = hit.meta.winner === 1 ? 'T' : 'CT';
      rounds[file] = { T: hit.dom, CT: hit.dom, winner: won, teams: { T: 'AA', CT: 'BB' } };
    }
    return json({ rounds });
  }
  if (u.pathname === '/api/replays/rounds/packs') {
    asked.packs++;
    const body = JSON.parse(init.body);
    asked.packFiles += body.files.length;
    assert.equal(body.ticks, false, 'no ticks for a question about grenades');
    assert.equal(body.meta, 'nades');
    if (packsAnswer === 'down') return new Response('{}', { status: 500 });
    return new Response(encodeRoundPacks(body.files.map((file) => ({ file, meta: library.get(file)?.meta ?? null }))), { status: 200 });
  }
  if (u.pathname.endsWith('/ticks')) {
    asked.ticks++;
    return new Response('{}', { status: 404 });
  }
  if (u.pathname.startsWith('/api/replays/rounds/')) {
    asked.meta++;
    const hit = library.get(decodeURIComponent(u.pathname.slice('/api/replays/rounds/'.length)));
    return hit ? json({ round: hit.meta }) : new Response('{}', { status: 404 });
  }
  if (u.pathname === '/api/replays/rounds') return json({ rounds: [...library.values()].map((x) => x.row), noted: [] });
  return new Response('{}', { status: 404 });
};
resetRegions([r1, r2]);
const scout = async (args) => JSON.parse((await runTool('scout_rounds', { describe: false, ...args })).content);
const ask = { side: 'T', result: 'won', sort: 'dominance', where: [smokeIn(1), smokeIn(2)] };
let out = await scout(ask);
assert.deepEqual(out.rounds.map((x) => [x.number, x.dominance]), [[2, 95], [1, 60]], 'both smokes, Ts won, the cleaner first; the map comes from the region');
assert.equal(out.rounds[0].in_regions, '1: smoke 1:35; 2: smoke 1:33');
assert.ok(out.rounds.every((x) => x.won && x.side === 'T'));
assert.match(out.filters_left, /2 of the 5 whose grenades were read have them there/);
assert.equal(asked.packs, 1, 'one request for the grenades of every round');
assert.equal(asked.packFiles, 5, 'only the Ts\' wins are read for grenades');
assert.equal(asked.meta, 2, 'the record only of the rounds picked');
assert.equal(asked.ticks, 0, 'no movement read');
// Sorted, every candidate's landings are read, so the count stands even when fewer rounds are asked for.
out = await scout({ ...ask, count: 1 });
assert.deepEqual(out.rounds.map((x) => x.number), [2]);
assert.match(out.filters_left, /2 of the 5 whose grenades were read have them there$/);
// A search that stops once enough fit has not counted the pool, and says so.
const wide = new Map(library);
for (let n = 7; n < 500; n++) add(n, { dom: 90, grenades: smokes });
out = await scout({ side: 'T', result: 'won', where: [smokeIn(1)], count: 1 });
assert.equal(out.rounds.length, 1);
assert.match(out.filters_left, /of the first \d+ whose grenades were read have them there, not a total/);
library.clear();
for (const [k, v] of wide) library.set(k, v);
// With who T and no side named, the same smokes are asked of the winner's rounds.
out = await scout({ result: 'won', where: [smokeIn(1, { who: 'T' }), smokeIn(2, { who: 'T' })], count: 8 });
assert.deepEqual(out.rounds.map((x) => x.number).sort(), [1, 2, 4], 'round 4 is a CT win where the Ts threw them');
// Any of the regions.
out = await scout({ side: 'T', result: 'won', where: [{ any: [smokeIn(1), smokeIn(2)] }], count: 8 });
assert.deepEqual(out.rounds.map((x) => x.number).sort(), [1, 2, 3]);
// Nothing fits: said, from the whole pool.
out = await scout({ side: 'T', result: 'won', where: [smokeIn(1, { min: 3 })] });
assert.equal(out.rounds.length, 0);
assert.match(out.note, /Only 0 fit everything in the whole pool/);
// Wrong region, wrong map: an answer to fix, not an empty list.
assert.match((await runTool('scout_rounds', { side: 'T', where: [smokeIn(9)] })).content, /^Error: There is no region 9/);
assert.match((await runTool('scout_rounds', { map: 'Nuke', side: 'T', where: [smokeIn(1)] })).content, /^Error: Region 1 was drawn on MIR, not NUK/);
// A server that cannot answer in a batch: the record of each round says the same.
packsAnswer = 'down';
asked.meta = 0;
out = await scout(ask);
assert.deepEqual(out.rounds.map((x) => x.number), [2, 1]);
assert.equal(asked.meta, 2, 'a request per round instead, for the two of the five not already read');
packsAnswer = 'ok';

console.log('mapRegions.test.js ok');

// Run: node src/replays/eye/eyeMatches.test.js
//
// Match-level questions against a fake library with two Phantom vs fnatic games
// on Ancient, the case the 17 Oct chat got wrong: rounds of both were mixed into
// one "3-2", and the opponent filter let in every other Phantom match.

import assert from 'node:assert/strict';
import { matchComplete, matchOfFile, runTool } from './eyeTools.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 17, 12);
// Two matches between the same teams, plus one against another team. Ids differ per demo.
const demos = [
  { id: 'm1', m: 'ANC', t1: 'AVg', t2: 'CNh', n1: 'Phantom', n2: 'fnatic', u: NOW - 3 * DAY },
  { id: 'm2', m: 'ANC', t1: 'AVg', t2: 'CNh', n1: 'Phantom', n2: 'fnatic', u: NOW - DAY },
  { id: 'm3', m: 'ANC', t1: 'AVg', t2: 'qm3', n1: 'Phantom', n2: 'Voca', u: NOW }
];
/** Round rows the way /api/replays/rounds returns them; `w` is who won each round (1 or 2), in order. */
const roundsOf = (d, w, flip = false) =>
  [...w].map((x, i) => ({
    file: `${flip ? d.t2 : d.t1}-${flip ? d.t1 : d.t2}-1${x}0-${d.m}-${String(i + 1).padStart(2, '0')}_x~${d.id}`,
    round: i + 1,
    team1: flip ? d.t2 : d.t1,
    team2: flip ? d.t1 : d.t2,
    // In a flipped file, team 1 of the round is the demo's team 2.
    winner: flip ? 3 - Number(x) : Number(x),
    econ1: 4,
    econ2: 4,
    mapName: 'Ancient'
  }));
// m1: Phantom 13-8 (finished). m2: only 7 rounds in the library. m3: another opponent.
const rounds = [
  ...roundsOf(demos[0], `${'12'.repeat(8)}${'1'.repeat(5)}`),
  ...roundsOf(demos[1], '2212221', true),
  ...roundsOf(demos[2], '1111')
];
const aggregateCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url), 'http://x');
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  // p: [player index, team, ...]. A team needs a player to be listed.
  if (u.pathname === '/api/replays/roster') {
    return json({ players: [{ i: 'p1', n: 'Kylar' }, { i: 'p2', n: 'fEAR' }, { i: 'p3', n: 'Voca1' }], demos: demos.map((d) => ({ ...d, p: [0, 1, d.n2 === 'fnatic' ? 1 : 2, 2] })) });
  }
  // One round's record, for round_details.
  if (u.pathname.startsWith('/api/replays/rounds/')) {
    const file = decodeURIComponent(u.pathname.slice('/api/replays/rounds/'.length));
    const row = rounds.find((r) => r.file === file);
    if (!row) return new Response(JSON.stringify({ error: 'Round not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return json({ round: { mapName: 'Ancient', round: row.round, team1: { name: 'Phantom' }, team2: { name: 'fnatic' }, team1Side: 'T', team2Side: 'CT', winner: row.winner, econ1: 4, econ2: 4, players: [], events: {}, freezeEndTick: 0 } });
  }
  if (u.pathname === '/api/replays/rounds') {
    // The server's teams filter keeps a round when EITHER side is listed.
    const teams = (u.searchParams.get('teams') || '').split(',').filter(Boolean);
    const maps = (u.searchParams.get('maps') || '').split(',').filter(Boolean);
    const list = rounds.filter((r) => (!teams.length || teams.includes(r.team1) || teams.includes(r.team2)) && (!maps.length || maps.includes(r.file.split('-')[3])));
    return json({ rounds: list, total: list.length });
  }
  if (u.pathname === '/api/replays/aggregate') {
    const body = JSON.parse(init.body);
    aggregateCalls.push(body);
    return json({
      players: [
        { name: 'KEi', teamLabel: 'Phantom', rating: 1.05, kills: 15, deaths: 14, adr: 80.4, kast: 70, rounds: body.files.length },
        { name: 'Kylar', teamLabel: 'Phantom', rating: 1.31, kills: 22, deaths: 12, adr: 95.21, kast: 78, rounds: body.files.length }
      ]
    });
  }
  return new Response('{}', { status: 404 });
};

// ---- the score rules ----
assert.equal(matchComplete(13, 8), true);
assert.equal(matchComplete(12, 11), false, 'nobody has 13');
assert.equal(matchComplete(13, 12), false, '12-12 goes to overtime, so 13-12 is not an end');
assert.equal(matchComplete(16, 14), true, 'first overtime');
assert.equal(matchComplete(15, 15), false);
assert.equal(matchComplete(19, 17), true, 'second overtime');
assert.equal(matchOfFile('AVg-CNh-100-ANC-01_x~m1'), 'm1');
assert.equal(matchOfFile('AVg-CNh-100-ANC-01_x'), '');

// ---- list_matches ----
let r = JSON.parse((await runTool('list_matches', { team: 'Phantom', opponent: 'fnatic', map: 'Ancient' })).content);
assert.equal(r.total, 2, 'only the games against fnatic');
assert.deepEqual(r.matches.map((m) => m.match), ['m2', 'm1'], 'newest first');
assert.match(r.matches[0].label, /^Phantom vs fnatic, Ancient, \d+ Oct$/);
r = JSON.parse((await runTool('list_matches', { random: true, limit: 1 })).content);
assert.equal(r.shown, 1);
assert.equal(r.picked, 'at random');
assert.ok(['m1', 'm2', 'm3'].includes(r.matches[0].match));
assert.match((await runTool('list_matches', { opponent: 'fnatic' })).content, /^Error: opponent needs team/);

// ---- match_summary ----
r = JSON.parse((await runTool('match_summary', { match: 'm1' })).content);
assert.equal(r.score, 'Phantom 13 - 8 fnatic');
assert.equal(r.winner, 'Phantom');
assert.equal(r.rounds_in_library, 21);
assert.equal(r.complete, true);
assert.match(r.first_half, /^Phantom \d+ - \d+ fnatic$/);
assert.equal(r.players[0].name, 'Kylar', 'best rating first');
assert.equal(r.players[0].adr, 95.21);
assert.match(r.top_performer, /^Kylar \(Phantom\), rating 1\.31$/);
assert.equal(aggregateCalls.at(-1).files.length, 21, 'stats over this match only');
assert.ok(aggregateCalls.at(-1).files.every((f) => f.endsWith('~m1')));
assert.deepEqual(aggregateCalls.at(-1).demos, ['m1']);

// A match the library only partly has, with the round files written fnatic-first.
r = JSON.parse((await runTool('match_summary', { match: 'm2' })).content);
assert.equal(r.rounds_in_library, 7);
assert.equal(r.complete, false);
assert.match(r.complete_note, /may not have the whole match/);
assert.equal(r.score, 'Phantom 2 - 5 fnatic', 'winners read through the flipped seats');

assert.match((await runTool('match_summary', { match: 'nope' })).content, /^Error: No match with id "nope"/);

// ---- find_rounds ----
// The opponent narrows: no Voca rounds. Every row says which match it is from.
r = JSON.parse((await runTool('find_rounds', { team: 'Phantom', opponent: 'fnatic', map: 'Ancient', limit: 30 })).content);
assert.equal(r.total_matching, 28);
assert.equal(r.from_matches, 2);
assert.ok(r.rounds.every((x) => x.team1 !== 'Voca' && x.team2 !== 'Voca'));
assert.ok(r.rounds.every((x) => x.match === 'm1' || x.match === 'm2'));
assert.match(r.rounds[0].label, /^Phantom vs fnatic, Ancient, \d+ Oct, round 1$/);
// One match's rounds: all of them by default (the 17 Oct chat saw 12 of 20 and decided
// round 15 did not exist), each with its half and the score going in.
r = JSON.parse((await runTool('find_rounds', { match: 'm1' })).content);
assert.equal(r.total_matching, 21);
assert.equal(r.shown, 21);
assert.equal(r.more, undefined);
assert.deepEqual(r.rounds.map((x) => x.number), Array.from({ length: 21 }, (_, i) => i + 1));
assert.equal(r.rounds[12].half, 'second half', 'round 13 starts the second half, not overtime');
assert.equal(r.rounds[0].score_before, 'Phantom 0 - 0 fnatic');
assert.equal(r.rounds[14].score_before, 'Phantom 7 - 7 fnatic');
r = JSON.parse((await runTool('find_rounds', { match: 'm2', limit: 3 })).content);
assert.equal(r.shown, 3);
assert.match(r.more, /^4 more rounds/);

// Round tools take match and number: no file to guess.
r = JSON.parse((await runTool('round_details', { match: 'm1', number: 15 })).content);
assert.equal(r.round, 15);
assert.equal(r.half, 'second half');
assert.equal(r.score_before, 'Phantom 7 - 7 fnatic');
assert.match((await runTool('round_details', { match: 'm1', number: 40 })).content, /^Error: Phantom vs fnatic, Ancient, \d+ Oct has no round 40 in the library\. It has 21 rounds: 1 to 21\./);
// A made-up file: told not to write one.
assert.match((await runTool('round_details', { round: 'AVg-CNh-155-ANC-15_x~m1' })).content, /^Error: No round with that file\. Never write a round file yourself/);
// The tool definitions take match and number, and no longer require a file.
const { toolsFor } = await import('./eyeTools.js');
for (const name of ['round_details', 'round_timeline', 'round_value', 'moment_value', 'screenshot_round']) {
  const t = toolsFor({ vision: true }).find((x) => x.function.name === name);
  assert.ok(t, name);
  assert.ok(t.function.parameters.properties.match && t.function.parameters.properties.number, `${name} takes match and number`);
  assert.ok(!(t.function.parameters.required || []).includes('round'), `${name} does not require a file`);
}

// ---- showing a round in the chat ----
let shown = await runTool('show_round', { match: 'm1', number: 4, from: '1:40', to: '1:00', caption: 'The 1-3-1' });
assert.equal(shown.widget.file, 'AVg-CNh-120-ANC-04_x~m1');
assert.match(shown.widget.label, /^Phantom vs fnatic, Ancient, \d+ Oct, round 4$/);
assert.equal(shown.widget.from, '1:40');
assert.equal(shown.widget.to, '1:00');
assert.equal(shown.widget.caption, 'The 1-3-1');
assert.match(shown.content, /^Shown to the user: .*1:40 to 1:00/);
shown = await runTool('show_round', { match: 'm1', number: 4, at: '1:20' });
assert.equal(shown.widget.at, '1:20');
assert.match((await runTool('show_round', { match: 'm1', number: 99 })).content, /^Error: .*has no round 99/);

// ---- strategy notes: tags become archive ids; unknown tags become plain words ----
const { linkStrategyTags, STRAT_CATEGORY_T, STRAT_ECONOMY } = await import('./eyeTools.js');
// A player's own grenade named in plain words is linked; another player's, or one inside a link, is not.
const { autoLinkGrenades } = await import('./eyeTools.js');
const mine = [{ tag: 't1', what: 'B CT Smoke' }, { tag: 't3', what: 'B coffins Molo' }];
assert.equal(
  autoLinkGrenades('Wait at Banana top. At 0:24 throw the b ct smoke, then <B coffins Molo><!t3> at 0:22 and enter.', mine),
  'Wait at Banana top. At 0:24 throw the <b ct smoke><!t1>, then <B coffins Molo><!t3> at 0:22 and enter.'
);
assert.equal(autoLinkGrenades('Hold Car for the B CT Flash.', [{ tag: 't6', what: 'Hut Flash' }]), 'Hold Car for the B CT Flash.');
const linkedNote = linkStrategyTags('Go mid, throw <Window smoke><!t1> at 1:45, then <Short flash><!t9> and swing.', new Map([['t1', 'ab12']]));
assert.equal(linkedNote.text, 'Go mid, throw <Window smoke><!ab12> at 1:45, then Short flash and swing.');
assert.equal(linkedNote.linked, 1);
assert.ok(STRAT_CATEGORY_T.includes('Default') && STRAT_ECONOMY.includes('Full buy + AWP'));
const t = toolsFor({ vision: false });
for (const name of ['show_round', 'strategy_draft', 'save_strategy']) assert.ok(t.find((x) => x.function.name === name), `${name} is offered without vision`);
assert.ok(t.find((x) => x.function.name === 'strategy_draft').function.parameters.properties.number, 'strategy_draft takes match and number');

console.log('eyeMatches.test.js ok');

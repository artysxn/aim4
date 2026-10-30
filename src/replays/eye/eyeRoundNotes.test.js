// Run: node src/replays/eye/eyeRoundNotes.test.js
//
// "8 random pistol vs pistol rounds on Ancient where the T side wins clean", made
// a playlist, then a note written on each: against a fake library of pistol
// rounds with known kill orders. Then the other questions scout_rounds answers,
// what it reads to answer them, and the notes it will not write.

import assert from 'node:assert/strict';
import { aliveGaps, gapFits, gapWords, winnerSide } from './roundSample.js';
import { notesLeft, resetTurnFacts, runTool } from './eyeTools.js';
import { claimsNotesWritten, notesLeftAsk, runAgentTurn } from './eyeAgent.js';

// ---- the man advantage, pure ----
const players = [...'abcde'].map((id) => ({ id, team: 1 })).concat([...'vwxyz'].map((id) => ({ id, team: 2 })));
const metaOf = (victims, { team1Side = 'T', winner = 1, extra = {} } = {}) => ({
  team1Side,
  winner,
  players,
  freezeEndTick: 1000,
  tickRate: 64,
  events: { kills: victims.map((v, i) => ({ tick: 2000 + i * 200, victim: v, attacker: 'abcde'.includes(v) ? 'z' : 'a' })) },
  ...extra
});
// Ts (team 1) trade 1 for 1, then run away with it. The last kill (4v1 to 4v0) is the end, not an advantage.
let g = aliveGaps(metaOf(['v', 'a', 'w', 'x', 'y', 'z']));
assert.deepEqual(g.steps, ['5v5', '5v4', '4v4', '4v3', '4v2', '4v1', '4v0']);
assert.equal(g.min, 0);
assert.equal(g.max, 3);
assert.ok(gapFits(g, { never_below: -1, reaches: 2 }));
// A 3v5 they convert: not clean.
g = aliveGaps(metaOf(['a', 'b', 'v', 'w', 'x', 'y', 'z']));
assert.equal(g.min, -2);
assert.ok(!gapFits(g, { never_below: -1, reaches: 2 }), 'a 3v5 comeback is not clean');
// Never better than +1 until the last kill (2v1 to 2v0): not clean either.
g = aliveGaps(metaOf(['v', 'a', 'w', 'b', 'x', 'c', 'y', 'z']));
assert.equal(g.max, 1);
assert.ok(!gapFits(g, { reaches: 2 }));
// The CT view of the same round is the mirror.
assert.equal(aliveGaps(metaOf(['v', 'w']), 'CT').min, -2);
// Team 1 on CT: sides follow team1Side.
assert.equal(winnerSide(metaOf([], { team1Side: 'CT', winner: 1 })), 'CT');
assert.deepEqual(aliveGaps(metaOf(['a'], { team1Side: 'CT' }), 'T').steps, ['5v5', '5v4']);
// Kills after the round ended do not count.
assert.equal(aliveGaps(metaOf(['v', 'a', 'b', 'c'], { extra: { endTick: 2150 } })).min, 0);
assert.match(gapWords(aliveGaps(metaOf(['v', 'w', 'a']))), /^never behind, up to \+2 \(5v3\); 5v5 → 5v4 → 5v3 → 4v3$/);
// A 5v4 traded down to 1v1 and won: the wipe-out kill does not make it +1 or better.
assert.equal(aliveGaps(metaOf(['v', 'a', 'w', 'b', 'x', 'c', 'y', 'd', 'z'])).max, 1);
// "Never down a man" as the user defines it: never fewer alive than the enemy for more than 2 seconds.
// A 4v5 traded in 0.5 s or 1.6 s is left out with grace 2; one held 3.1 s is not; the words still say
// the brief one happened.
const traded = (heldTicks) => ({ ...metaOf([]), events: { kills: ['a', 'v', 'w', 'x', 'y', 'z'].map((v, i) => ({ tick: i === 0 ? 2000 : 2000 + heldTicks + (i - 1) * 200, victim: v })) } });
for (const held of [32, 100]) {
  g = aliveGaps(traded(held), 'T', 2);
  assert.equal(g.min, 0, `4v5 for ${held} ticks`);
  assert.equal(g.rawMin, -1);
  assert.ok(gapFits(g, { never_below: 0 }));
}
assert.match(gapWords(aliveGaps(traded(32), 'T', 2)), /^never behind \(down to -1 for 2s or less\), up to \+3 \(4v1\); 5v5 → 4v5 → 4v4/);
assert.equal(aliveGaps(traded(200), 'T', 2).min, -1, '4v5 for 3.1 s is longer than the grace');
assert.equal(aliveGaps(traded(32)).min, -1, 'without grace every count holds');
// Five kills in two seconds: nothing was traded back. The winners were up 4, the wiped side was not "never behind".
const wipe = { ...metaOf([]), events: { kills: ['v', 'w', 'x', 'y', 'z'].map((v, i) => ({ tick: 2000 + i * 20, victim: v })) } };
g = aliveGaps(wipe, 'T', 2);
assert.deepEqual([g.min, g.max], [0, 4]);
g = aliveGaps(wipe, 'CT', 2);
assert.deepEqual([g.min, g.max], [-4, 0]);
assert.match(gapWords(g), /^down to -4 at worst/);

// ---- the tools, against a fake library ----
const demos = [
  { id: 'm1', m: 'ANC', t1: 'AA', t2: 'BB', n1: 'Alpha', n2: 'Bravo', u: Date.UTC(2026, 9, 18) },
  { id: 'm2', m: 'ANC', t1: 'CC', t2: 'DD', n1: 'Charlie', n2: 'Delta', u: Date.UTC(2026, 9, 18) }
];
/** file -> { row, meta }: pistol rounds 1 and 13 of both matches, and a full buy round that must never be picked. */
const library = new Map();
const add = (d, n, { econ = 0, team1Side = 'T', winner = 1, victims }) => {
  const file = `${d.t1}-${d.t2}-1${winner}0-ANC-${String(n).padStart(2, '0')}_x~${d.id}`;
  library.set(file, {
    row: { file, round: n, team1: d.t1, team2: d.t2, winner, econ1: econ, econ2: econ, map: 'ANC', mapName: 'Ancient' },
    meta: { ...metaOf(victims, { team1Side, winner }), id: file, map: 'ANC', round: n, econ1: econ, econ2: econ, team1: { id: d.t1, name: d.n1 }, team2: { id: d.t2, name: d.n2 }, team2Side: team1Side === 'T' ? 'CT' : 'T', notes: [] }
  });
  return file;
};
const clean1 = add(demos[0], 1, { victims: ['v', 'w', 'a', 'x', 'y', 'z'] }); // T win, never behind, +2
const comeback = add(demos[0], 13, { team1Side: 'CT', winner: 2, victims: ['v', 'w', 'a', 'b', 'c', 'd', 'e'] }); // T (team 2) down 3v5, wins
const clean2 = add(demos[1], 1, { victims: ['v', 'w', 'x', 'y', 'z'] }); // T win 5v0 (5v3 on the way)
const ctWin = add(demos[1], 13, { winner: 2, victims: ['a', 'b', 'c', 'd', 'e'] }); // CT win
add(demos[1], 5, { econ: 4, victims: ['v', 'w', 'x', 'y', 'z'] }); // full buy: never picked
const saved = new Map();
/** What the tools asked the library for, by kind. */
const asked = { dominance: 0, meta: 0, ticks: 0 };
/** The model, in the agent test below: replies in order. */
let script = [];
const scripted = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url), 'http://x');
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/api/eye/chat') {
    scripted.push(JSON.parse(init.body).messages);
    const next = script.shift();
    return new Response(`${next.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200 });
  }
  if (u.pathname === '/api/replays/roster') return json({ players: [{ i: 'p1', n: 'x' }, { i: 'p2', n: 'y' }], demos: demos.map((d) => ({ ...d, p: [0, 1, 1, 2] })) });
  if (u.pathname === '/api/replays/rounds/dominance') {
    asked.dominance++;
    const { files } = JSON.parse(init.body);
    const rounds = {};
    for (const file of files) {
      const hit = library.get(file);
      if (!hit) continue;
      const { meta } = hit;
      const t1 = meta.team1Side === 'CT' ? 'CT' : 'T';
      const won = meta.winner === 1 ? t1 : t1 === 'T' ? 'CT' : 'T';
      // An older server: the side that lost still comes back with a number.
      rounds[file] = { T: won === 'T' ? 95 : 90, CT: won === 'CT' ? 60 : 92, winner: won, teams: { [t1]: meta.team1.id, [t1 === 'T' ? 'CT' : 'T']: meta.team2.id } };
    }
    return json({ rounds });
  }
  if (u.pathname.endsWith('/ticks')) {
    asked.ticks++;
    return new Response('{"error":"no ticks"}', { status: 404 });
  }
  const note = /^\/api\/replays\/rounds\/(.+)\/note$/.exec(u.pathname);
  if (note && init.method === 'POST') {
    const file = decodeURIComponent(note[1]);
    const { notes } = JSON.parse(init.body);
    saved.set(file, notes);
    library.get(file).meta.notes = notes;
    return json({ notes });
  }
  if (u.pathname.startsWith('/api/replays/rounds/')) {
    asked.meta++;
    const hit = library.get(decodeURIComponent(u.pathname.slice('/api/replays/rounds/'.length)));
    return hit ? json({ round: hit.meta }) : new Response('{"error":"Round not found."}', { status: 404 });
  }
  if (u.pathname === '/api/replays/rounds') {
    const a = u.searchParams.get('econA');
    const list = [...library.values()].map((x) => x.row).filter((r) => a === null || (String(r.econ1) === a && String(r.econ2) === (u.searchParams.get('econB') ?? a)));
    return json({ rounds: list.slice(0, Number(u.searchParams.get('limit')) || 2000), noted: [...library].filter(([, x]) => x.meta.notes.length).map(([f]) => f) });
  }
  if (u.pathname === '/api/replays/playlists' && init.method === 'POST') {
    const body = JSON.parse(init.body);
    return json({ playlists: [{ id: 'pl1', name: body.name, rounds: body.rounds, scope: 'private', mine: true }] });
  }
  if (u.pathname === '/api/replays/playlists') return json({ playlists: [] });
  return new Response('{}', { status: 404 });
};
resetTurnFacts();

const ask = { map: 'Ancient', side: 'T', result: 'won', buy: 'pistol', vs_buy: 'pistol', gap: { never_below: -1, reaches: 2 }, count: 8 };
let r = JSON.parse((await runTool('scout_rounds', ask)).content);
assert.match(r.filters_left, /^4 rounds on Ancient/, 'the full buy round is not in the pool');
assert.equal(r.picked, 2);
assert.deepEqual(r.rounds.map((x) => x.number).sort(), [1, 1]);
assert.ok(r.rounds.every((x) => x.won && x.side === 'T' && x.buys === 'pistol vs pistol'));
assert.match(r.note, /Only 2 fit everything in the whole pool/);

// "Preferably": filled with the T win that was not clean, marked; the CT win never.
// A gap with only a side checks nothing: refused, saying how to write "never down a man" (19 Oct chat).
assert.match((await runTool('scout_rounds', { ...ask, gap: { side: 'T' } })).content, /^Error: gap needs never_below or reaches\. never_below 0: never fewer players alive than the other side \(never 4v5\)/);
// An argument it does not know is refused, not ignored.
assert.match((await runTool('scout_rounds', { map: 'Ancient', enemy: 'Alpha' })).content, /^Error: scout_rounds has no "enemy"/);
assert.match((await runTool('scout_rounds', { side: 'T' })).content, /^Error: Name a map, a team or a player/);

r = JSON.parse((await runTool('scout_rounds', { ...ask, prefer: true })).content);
assert.equal(r.picked, 3);
const filled = r.rounds.find((x) => !x.fits_gap);
assert.equal(filled.number, 13);
assert.match(filled.alive, /down to -2 at worst/);
assert.match(r.note, /the other 1 pass everything but the gap/);

// Into a playlist in one call.
const pl = await runTool('save_playlist', { name: 'Ancient pistols, clean T wins', add_from: 'last_result' });
assert.match(pl.content, /^Created the playlist "Ancient pistols, clean T wins" \(id pl1\): 3 rounds/);
assert.ok([clean1, clean2, comeback].every((f) => pl.link.includes(encodeURIComponent(f))));
assert.ok(!pl.link.includes(encodeURIComponent(ctWin)));

// Notes: written at the start of the round, the user's own note kept, the eye's earlier one replaced.
library.get(clean1).meta.notes = [{ id: 'u1', tick: 3000, text: 'my own note', kind: 'user' }];
let w = await runTool('write_round_notes', { notes: [{ match: 'm1', number: 1, text: 'Full B rush through B main, 2 flashes over' }, { round: clean2, text: '1 fakes A with 2 smokes, rest walk up B', at: '1:30' }] });
assert.match(w.content, /^Wrote 2 of 2 round notes/);
let notes = saved.get(clean1);
assert.deepEqual(notes.map((n) => n.text), ['my own note', 'Full B rush through B main, 2 flashes over']);
assert.equal(notes[1].tick, 1000, '1:55 is the end of the freeze time');
assert.equal(saved.get(clean2)[0].tick, 1000 + 25 * 64, '1:30 is 25 seconds in');
w = await runTool('write_round_notes', { notes: [{ match: 'm1', number: 1, text: 'Full B rush, corrected' }] });
notes = saved.get(clean1);
assert.deepEqual(notes.map((n) => n.text), ['my own note', 'Full B rush, corrected'], 'writing again replaces the eye note only');
// Delete: the eye's note goes, the user's stays; a round with no eye note says so.
w = await runTool('write_round_notes', { notes: [{ match: 'm1', number: 1, delete: true }] });
assert.match(w.content, /^Removed 1 of 1\./);
assert.deepEqual(saved.get(clean1).map((n) => n.text), ['my own note']);
w = await runTool('write_round_notes', { notes: [{ match: 'm1', number: 1, delete: true }] });
assert.match(w.content, /no eye note to remove/);
assert.deepEqual(saved.get(clean1).map((n) => n.text), ['my own note'], 'the user note is never removed');
// Declined: nothing written.
saved.clear();
w = await runTool('write_round_notes', { notes: [{ match: 'm1', number: 1, text: 'x' }] }, { confirm: async () => false });
assert.match(w.content, /declined/);
assert.equal(saved.size, 0);
assert.match((await runTool('write_round_notes', { notes: [{ match: 'm1', number: 1 }] })).content, /^Error: Every note needs its text/);

// ---- the other questions scout_rounds answers, and what they cost ----
const costOf = async (args) => {
  asked.dominance = asked.meta = asked.ticks = 0;
  const out = JSON.parse((await runTool('scout_rounds', { describe: false, ...args })).content);
  return { out, cost: { ...asked } };
};
// A team, a buy and a result are in the file name: no round is read to find them.
let q = await costOf({ team: 'Alpha', result: 'won', buy: 'pistol', count: 1 });
assert.deepEqual([q.out.rounds[0].team, q.out.rounds[0].won], ['Alpha', true]);
assert.equal(q.cost.dominance, 0, 'nothing but the list');
assert.ok(q.cost.meta <= 1, 'at most the round picked, to say how it went');
// The enemy, and the team facing it when no team is named.
q = await costOf({ map: 'Ancient', opponent: 'Bravo', buy: 'pistol', count: 8 });
assert.ok(q.out.rounds.length === 2 && q.out.rounds.every((x) => x.team === 'Alpha'));
// A list that is not narrowed reads the sides in one request, whatever its size.
q = await costOf({ map: 'Ancient', side: 'CT', result: 'won', count: 8 });
assert.equal(q.cost.dominance, 1);
assert.ok(q.out.rounds.every((x) => x.side === 'CT' && x.won));
// Dominance: a side that lost reads 0 even from a server that sends a number for it.
q = await costOf({ map: 'Ancient', team: 'Charlie', side: 'T', dominance: { min: 50 } });
assert.ok(q.out.rounds.every((x) => x.won), 'a lost round is never dominant');
q = await costOf({ map: 'Ancient', side: 'T', dominance: { min: 90 }, sort: 'dominance', buy: 'pistol' });
assert.ok(q.out.rounds.length && q.out.rounds.every((x) => x.dominance === 95));
// From the record: a plant, how it ended, the first kill.
q = await costOf({ map: 'Ancient', team: 'Alpha', first_kill: 'team', buy: 'pistol' });
assert.equal(q.out.rounds.length, 2);
q = await costOf({ map: 'Ancient', team: 'Alpha', first_kill: 'opponent', buy: 'pistol' });
assert.equal(q.out.rounds.length, 0, 'Alpha got the first kill in both');
q = await costOf({ map: 'Ancient', team: 'Alpha', plant: true });
assert.equal(q.out.rounds.length, 0, 'no round of the fake library has a plant');
assert.match(q.out.note, /Only 0 fit everything/);
// The enemy not found says so instead of matching nothing.
assert.match((await runTool('scout_rounds', { map: 'Ancient', opponent: 'Nobody' })).content, /^Error: No team called "Nobody"/);
// To find more: the rounds of a playlist are left out.
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).includes('/api/replays/playlists') ? new Response(JSON.stringify({ playlists: [{ id: 'pl9', name: 'Seen', rounds: [clean1, comeback], scope: 'private', mine: true }] }), { status: 200 }) : fetchReal(url, init));
q = await costOf({ map: 'Ancient', buy: 'pistol', not_in_playlist: 'Seen', count: 8 });
assert.deepEqual(q.out.rounds.map((x) => x.match).sort(), ['m2', 'm2']);
globalThis.fetch = fetchReal;

// ---- notes it sends back, and what it says is left ----
resetTurnFacts();
library.get(clean1).meta.notes = [];
library.get(clean2).meta.notes = [];
saved.clear();
const twoFiles = [{ match: 'm1', number: 1 }, { match: 'm2', number: 1 }];
let briefs = JSON.parse((await runTool('round_briefs', { rounds: twoFiles, side: 'T' })).content);
assert.equal(briefs.rounds.length, 2);
assert.match(briefs.next, /Write this part's notes now/);
assert.deepEqual(notesLeft(), { read: 2, written: 0, left: 2, unread: 0, from: 'those rounds' });
w = await runTool('write_round_notes', { notes: [{ match: 'm1', number: 1, text: 'Hold B, win the B fights' }, { match: 'm2', number: 1, text: 'Full A execute with smoke CT' }] });
assert.match(w.content, /^Wrote 1 of 1 round note/);
assert.match(w.content, /1 of the rounds read still have no note/);
assert.match(w.content, /Not written, 1 to rewrite and send again: .*it says "win"/);
assert.equal(saved.size, 1, 'the one that passed is written');
assert.ok(!saved.has(clean1));
w = await runTool('write_round_notes', { notes: [{ match: 'm1', number: 1, text: 'Same line' }, { match: 'm2', number: 1, text: 'Same line' }] });
assert.match(w.content, /word for word/);
w = await runTool('write_round_notes', { notes: [{ match: 'm1', number: 1, text: 'x'.repeat(200) }] });
assert.match(w.content, /^Not written, 1 to rewrite/);
assert.match(w.content, /200 characters/);
w = await runTool('write_round_notes', { notes: [{ match: 'm1', number: 1, text: 'Hit A with 3 smokes' }] });
assert.equal(notesLeft(), null, 'every round read has its note');
// The other team is named only when the side is known: it is read from the brief.
w = await runTool('write_round_notes', { notes: [{ match: 'm1', number: 1, text: 'Walk up on Bravo' }] });
assert.match(w.content, /names Bravo from the other team/);

// round_briefs: the rounds that already have notes, left out when asked, with what they say.
library.get(clean1).meta.notes = [{ id: 'u1', tick: 3000, text: 'my own note', kind: 'user' }];
library.get(clean2).meta.notes = [];
briefs = JSON.parse((await runTool('round_briefs', { rounds: twoFiles, side: 'T' })).content);
assert.deepEqual(briefs.rounds.map((x) => x.note_by || ''), ['the user', '']);
assert.equal(briefs.rounds[0].note_now, 'my own note');
briefs = JSON.parse((await runTool('round_briefs', { rounds: twoFiles, side: 'T', missing_only: true })).content);
assert.equal(briefs.without_a_note, 1);
assert.deepEqual(briefs.rounds.map((x) => x.match), ['m2']);
library.get(clean2).meta.notes = [{ id: 'u2', tick: 3000, text: 'mine too', kind: 'user' }];
assert.match((await runTool('round_briefs', { rounds: twoFiles, side: 'T', missing_only: true })).content, /Every one of these rounds already has a note/);
library.get(clean2).meta.notes = [];

// ---- a reply that says the notes are written when they are not ----
assert.ok(claimsNotesWritten('**Cache CT Anti-eco/force wins** (10 rounds): notes written on all 10'));
assert.ok(claimsNotesWritten('Every round in every playlist now has a tactical note visible in the round viewer.'));
assert.ok(claimsNotesWritten('Done, I wrote a note on each round.'));
assert.ok(!claimsNotesWritten('Want me to write notes on these rounds?'));
assert.ok(!claimsNotesWritten('These rounds have no notes yet.'));
assert.match(notesLeftAsk({ read: 10, written: 0, left: 10, unread: 6 }), /read 10 rounds with round_briefs and wrote notes on 0, 10 of them have no note, 6 more are not read yet\./);
const sseCall = (id, name, args) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }];
const sseText = (text) => [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
script = [
  sseCall('c1', 'round_briefs', { rounds: [{ match: 'm2', number: 1 }], side: 'T' }),
  sseText('Done: notes written on all of them.'),
  sseCall('c2', 'write_round_notes', { notes: [{ match: 'm2', number: 1, text: 'Hit A with 3 smokes' }] }),
  sseText('Done: notes written on all of them.')
];
const convo = [{ role: 'user', content: 'Note that round.' }];
const answer = await runAgentTurn(convo, {});
assert.equal(answer, 'Done: notes written on all of them.');
assert.equal(scripted.length, 4, 'asked again once');
assert.match(String(scripted[2].at(-1).content), /You read 1 round with round_briefs and wrote notes on 0/);
assert.equal(convo.filter((m) => m.role === 'assistant' && !m.tool_calls?.length).length, 1, 'the false reply is not kept');
assert.ok(convo.some((m) => m.role === 'tool' && /^Wrote 1 of 1/.test(m.content)));

console.log('eyeRoundNotes.test.js ok');

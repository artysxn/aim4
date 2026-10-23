// Run: node src/replays/eye/eyeRoundNotes.test.js
//
// "8 random pistol vs pistol rounds on Ancient where the T side wins clean", made
// a playlist, then a note written on each: against a fake library of pistol
// rounds with known kill orders.

import assert from 'node:assert/strict';
import { aliveGaps, gapFits, gapWords, winnerSide } from './roundSample.js';
import { resetTurnFacts, runTool } from './eyeTools.js';

// ---- the man advantage, pure ----
const players = [...'abcde'].map((id) => ({ id, team: 1 })).concat([...'vwxyz'].map((id) => ({ id, team: 2 })));
const metaOf = (victims, { team1Side = 'T', winner = 1, extra = {} } = {}) => ({
  team1Side,
  winner,
  players,
  freezeEndTick: 1000,
  tickRate: 64,
  events: { kills: victims.map((v, i) => ({ tick: 2000 + i * 200, victim: v, attacker: '?' })) },
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
    row: { file, round: n, team1: d.t1, team2: d.t2, winner, econ1: econ, econ2: econ, mapName: 'Ancient' },
    meta: { ...metaOf(victims, { team1Side, winner }), round: n, econ1: econ, econ2: econ, notes: [] }
  });
  return file;
};
const clean1 = add(demos[0], 1, { victims: ['v', 'w', 'a', 'x', 'y', 'z'] }); // T win, never behind, +2
const comeback = add(demos[0], 13, { team1Side: 'CT', winner: 2, victims: ['v', 'w', 'a', 'b', 'c', 'd', 'e'] }); // T (team 2) down 3v5, wins
const clean2 = add(demos[1], 1, { victims: ['v', 'w', 'x', 'y', 'z'] }); // T win 5v0 (5v3 on the way)
const ctWin = add(demos[1], 13, { winner: 2, victims: ['a', 'b', 'c', 'd', 'e'] }); // CT win
add(demos[1], 5, { econ: 4, victims: ['v', 'w', 'x', 'y', 'z'] }); // full buy: never picked
const saved = new Map();
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url), 'http://x');
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/api/replays/roster') return json({ players: [{ i: 'p1', n: 'x' }], demos: demos.map((d) => ({ ...d, p: [0, 1] })) });
  const note = /^\/api\/replays\/rounds\/(.+)\/note$/.exec(u.pathname);
  if (note && init.method === 'POST') {
    const file = decodeURIComponent(note[1]);
    const { notes } = JSON.parse(init.body);
    saved.set(file, notes);
    library.get(file).meta.notes = notes;
    return json({ notes });
  }
  if (u.pathname.startsWith('/api/replays/rounds/')) {
    const hit = library.get(decodeURIComponent(u.pathname.slice('/api/replays/rounds/'.length)));
    return hit ? json({ round: hit.meta }) : new Response('{"error":"Round not found."}', { status: 404 });
  }
  if (u.pathname === '/api/replays/rounds') {
    const a = u.searchParams.get('econA');
    const list = [...library.values()].map((x) => x.row).filter((r) => a === null || (String(r.econ1) === a && String(r.econ2) === (u.searchParams.get('econB') ?? a)));
    return json({ rounds: list });
  }
  if (u.pathname === '/api/replays/playlists' && init.method === 'POST') {
    const body = JSON.parse(init.body);
    return json({ playlists: [{ id: 'pl1', name: body.name, rounds: body.rounds, scope: 'private', mine: true }] });
  }
  if (u.pathname === '/api/replays/playlists') return json({ playlists: [] });
  return new Response('{}', { status: 404 });
};
resetTurnFacts();

const ask = { map: 'Ancient', buy: 'pistol', vs_buy: 'pistol', winner: 'T', gap: { side: 'T', never_below: -1, reaches: 2 }, count: 8 };
let r = JSON.parse((await runTool('sample_rounds', ask)).content);
assert.equal(r.rounds_with_these_buys, 4, 'the full buy round is not in the pool');
assert.equal(r.fit_everything, 2);
assert.deepEqual(r.rounds.map((x) => x.number).sort(), [1, 1]);
assert.ok(r.rounds.every((x) => x.fits_gap && x.won_by === 'T'));
assert.match(r.note, /Only 2 fit everything in the whole pool/);

// "Preferably": filled with the T win that was not clean, marked; the CT win never.
// A gap with only a side checks nothing: refused, saying how to write "never down a man" (19 Oct chat).
assert.match((await runTool('sample_rounds', { ...ask, gap: { side: 'T' } })).content, /^Error: gap needs never_below or reaches\. never_below 0: never fewer players alive than the other side \(never 4v5\)/);

r = JSON.parse((await runTool('sample_rounds', { ...ask, prefer: true })).content);
assert.equal(r.picked, 3);
const filled = r.rounds.find((x) => !x.fits_gap);
assert.equal(filled.number, 13);
assert.match(filled.T_alive, /down to -2 at worst/);
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

console.log('eyeRoundNotes.test.js ok');

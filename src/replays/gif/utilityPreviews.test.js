// Run: node src/replays/gif/utilityPreviews.test.js
//
// Which clips a player's grenades make, how they land in a note, and that one
// clip failing costs only its link.

import assert from 'node:assert/strict';
import { NOTE_WITH_LINKS_MAX, linkPreviews, makeUtilityPreviews, utilityWindows } from './utilityPreviews.js';

const RATE = 64;
const LIVE = 1000;
const at = (seconds) => LIVE + seconds * RATE;
const throwAt = (player, seconds, type = 'smokegrenade') => ({ player, throwTick: at(seconds), type });
const meta = (grenades, kills = []) => ({
  tickRate: RATE,
  startTick: 0,
  freezeEndTick: LIVE,
  officialEndTick: at(150),
  players: [],
  events: { grenades, kills }
});
const spans = (list) => list.map((w) => [(w.fromTick - LIVE) / RATE, (w.toTick - LIVE) / RATE, w.grenades.length]);

// A lone grenade: 5 seconds before it, 3 after.
assert.deepEqual(spans(utilityWindows(meta([throwAt('a', 40)]), 'a')), [[35, 43, 1]]);
// Two close together: one clip, from 5 before the first to 3 after the last.
assert.deepEqual(spans(utilityWindows(meta([throwAt('a', 40), throwAt('a', 44)]), 'a')), [[35, 47, 2]]);
// Exactly touching still shares a clip; a gap makes two.
assert.deepEqual(spans(utilityWindows(meta([throwAt('a', 40), throwAt('a', 48)]), 'a')), [[35, 51, 2]]);
assert.deepEqual(spans(utilityWindows(meta([throwAt('a', 40), throwAt('a', 60)]), 'a')), [[35, 43, 1], [55, 63, 1]]);
// Out of order in the events, and someone else's grenades are not this player's.
assert.deepEqual(spans(utilityWindows(meta([throwAt('a', 44), throwAt('b', 42), throwAt('a', 40)]), 'a')), [[35, 47, 2]]);
assert.deepEqual(utilityWindows(meta([throwAt('b', 40)]), 'a'), []);
// Only the part of the round asked for.
assert.deepEqual(spans(utilityWindows(meta([throwAt('a', 10), throwAt('a', 60)]), 'a', { fromTick: at(30), toTick: at(90) })), [[55, 63, 1]]);
// Kept to the round: an early throw starts where the round's data starts.
assert.equal(utilityWindows(meta([throwAt('a', -990 / RATE)]), 'a')[0].fromTick, 0);
// A thrower who dies is watched one second more, not their corpse for the rest of the clip.
assert.deepEqual(spans(utilityWindows(meta([throwAt('a', 40)], [{ victim: 'a', tick: at(41) }]), 'a')), [[35, 42, 1]]);
assert.deepEqual(spans(utilityWindows(meta([throwAt('a', 40)], [{ victim: 'b', tick: at(41) }]), 'a')), [[35, 43, 1]]);
// A chain of throws too long for one 3D clip is split rather than cut short.
{
  const chain = [0, 7, 14, 21, 28, 35].map((s) => throwAt('a', 10 + s));
  const list = utilityWindows(meta(chain), 'a');
  assert.ok(list.length > 1);
  assert.equal(list.flatMap((w) => w.grenades).length, chain.length, 'no grenade lost');
  for (const w of list) assert.ok((w.toTick - w.fromTick) / RATE <= 30, 'each fits');
}

// ---- in the note -------------------------------------------------------------------

const URL_A = 'https://aim4.io/g/aaaaaaaaaaaaaaaa';
const URL_B = 'https://aim4.io/g/bbbbbbbbbbbbbbbb';
// On the grenade's own words, so one click copies the setpos and opens the clip.
assert.equal(
  linkPreviews('At 1:30 throw <Window smoke><!ab12> then hold.', [{ url: URL_A, label: 'Preview 1:30', throwIds: ['ab12'] }]).text,
  `At 1:30 throw <Window smoke><!ab12><URL=${URL_A}> then hold.`
);
// Every grenade of a clip.
assert.equal(
  linkPreviews('<a><!aaaa> and <b><!bbbb>', [{ url: URL_A, label: 'x', throwIds: ['aaaa', 'bbbb'] }]).text,
  `<a><!aaaa><URL=${URL_A}> and <b><!bbbb><URL=${URL_A}>`
);
// A clip whose grenades the note does not name is appended under its time.
assert.equal(linkPreviews('Hold long.', [{ url: URL_B, label: 'Preview 0:45', throwIds: ['zzzz'] }]).text, `Hold long. <Preview 0:45><URL=${URL_B}>`);
assert.equal(linkPreviews('', [{ url: URL_B, label: 'Preview 0:45' }]).text, `<Preview 0:45><URL=${URL_B}>`);
// Never past what the server keeps, and never half a link.
{
  const full = 'x'.repeat(NOTE_WITH_LINKS_MAX - 5);
  const { text, left, linked } = linkPreviews(full, [{ url: URL_A, label: 'Preview 1:30' }]);
  assert.equal(text, full);
  assert.deepEqual([linked, left], [0, 1]);
  const tagged = `${'y'.repeat(NOTE_WITH_LINKS_MAX - 12)}<a><!ab12>`;
  assert.equal(linkPreviews(tagged, [{ url: URL_A, label: 'x', throwIds: ['ab12'] }]).text, tagged);
}

// ---- making them --------------------------------------------------------------------

{
  const m = { ...meta([throwAt('a', 40), throwAt('b', 50), throwAt('b', 90)]), players: [{ id: 'a', slot: 0, name: 'khaN' }, { id: 'b', slot: 1, name: 'dex' }] };
  const track = { sample: () => ({ alive: true, x: 1, y: 2, z: 3, yaw: 4, pitch: 5 }) };
  const plan = m.players.map((p) => ({ id: p.id, slot: p.slot, name: p.name, windows: utilityWindows(m, p.id) }));
  const asked = [];
  let closed = 0;
  const maker = async () => ({
    make: async (opts) => {
      asked.push(opts);
      if (asked.length === 2) throw new Error('out of room');
      return { url: `u${asked.length}` };
    },
    close: () => closed++
  });
  const status = [];
  const res = await makeUtilityPreviews({ file: 'r~m1', meta: m, track, plan, strategyName: 'Fast B', onStatus: (t) => status.push(t), maker });
  assert.deepEqual([res.made, res.failed, res.firstError], [2, 1, 'out of room'], 'one failing costs its link only');
  assert.deepEqual(res.byPlayer.get('a').map((c) => c.url), ['u1']);
  assert.deepEqual(res.byPlayer.get('b').map((c) => c.url), ['u3']);
  assert.deepEqual(res.byPlayer.get('b')[0].throwTicks, [at(90)]);
  assert.equal(closed, 1, 'the scene is let go');
  assert.equal(asked[0].camera.player, 0, 'from their own eyes');
  assert.equal(asked[0].camera.mode, 'pov');
  assert.equal(asked[0].source, 'strategy');
  assert.match(asked[0].title, /^Fast B: khaN /);
  assert.equal(asked[0].setposLines.length, 1, "this player's lineups");
  assert.match(asked[0].setposLines[0], /khaN Smoke <setpos /);
  assert.match(status[0], /^Preview 1 of 3, khaN/);
  // Nothing to make: nothing opened.
  const none = await makeUtilityPreviews({ file: 'r', meta: m, track, plan: [], maker: () => assert.fail('no scene for no clips') });
  assert.equal(none.made, 0);
  // Cancelled: the whole job stops, and the scene is still let go.
  closed = 0;
  const stop = Object.assign(new Error('Cancelled'), { name: 'AbortError' });
  await assert.rejects(makeUtilityPreviews({ file: 'r', meta: m, track, plan, maker: async () => ({ make: async () => { throw stop; }, close: () => closed++ }) }), /Cancelled/);
  assert.equal(closed, 1);
}

console.log('utilityPreviews.test.js ok');

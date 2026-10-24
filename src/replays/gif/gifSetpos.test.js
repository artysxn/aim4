// node src/replays/gif/gifSetpos.test.js
import assert from 'node:assert/strict';
import { appendSetposLines, setposText, utilitySetposLines } from './gifSetpos.js';

// A track that says where each slot stood at each tick, and records what it was asked.
function fakeTrack(stateAt) {
  const asked = [];
  return {
    asked,
    sample(slot, tick, out = {}) {
      asked.push([slot, tick]);
      return Object.assign(out, stateAt(slot, tick));
    }
  };
}

const timing = { tickRate: 64, startTick: 0, freezeEndTick: 64 * 20, plantTick: null, endTick: 64 * 200 };
const meta = {
  players: [
    { id: 'a', name: 's1mple', slot: 0 },
    { id: 'b', name: 'b1t', slot: 6 }
  ],
  events: {
    grenades: [
      { type: 'flashbang', player: 'b', throwTick: 64 * 40 },
      { type: 'smokegrenade', player: 'a', throwTick: 64 * 30 },
      { type: 'incgrenade', player: 'a', throwTick: 64 * 90 },
      { type: 'hegrenade', player: 'nobody', throwTick: 64 * 35 }
    ]
  }
};

// The position is read the tick before the grenade leaves the hand, and before the throw itself.
const track = fakeTrack((slot, tick) => ({ alive: true, x: slot * 100 + 0.25, y: -tick, z: 64, yaw: 90.5, pitch: -12.34 }));
const lines = utilitySetposLines(meta, track, { fromTick: 64 * 25, toTick: 64 * 60, timing });
assert.deepEqual(track.asked, [
  [0, 64 * 30 - 1],
  [6, 64 * 40 - 1]
]);
// In throw order, with the clock, the thrower and the grenade; the unknown thrower and the late molotov left out.
assert.equal(lines.length, 2);
assert.equal(lines[0], `01:45 s1mple Smoke <setpos 0.25 -${64 * 30 - 1}.00 64.00; setang -12.34 90.50 0>`);
assert.match(lines[1], /^01:35 b1t Flash <setpos 600\.25 /);

// Incendiaries and molotovs read the same.
const fire = utilitySetposLines(meta, track, { fromTick: 64 * 89, toTick: 64 * 91, timing });
assert.match(fire[0], / s1mple Molotov <setpos /);

// A thrower dead (or missing) on that tick has no setpos to give.
const dead = fakeTrack(() => ({ alive: false, x: 1, y: 1, z: 1, yaw: 0, pitch: 0 }));
assert.deepEqual(utilitySetposLines(meta, dead, { fromTick: 0, toTick: 64 * 200, timing }), []);
assert.deepEqual(utilitySetposLines(meta, null, { fromTick: 0, toTick: 64 * 200, timing }), []);

// Two decimals: all the tick data holds.
assert.equal(setposText({ x: -1234.25, y: 2, z: 64.5, pitch: 3.14159, yaw: -179.99 }), 'setpos -1234.25 2.00 64.50; setang 3.14 -179.99 0');

// Appended under the description, never cutting a line in half.
assert.deepEqual(appendSetposLines('B split', ['one <a>', 'two <b>'], 100), { text: 'B split\n\none <a>\ntwo <b>', added: 2, left: 0 });
assert.deepEqual(appendSetposLines('', ['one <a>'], 100), { text: 'one <a>', added: 1, left: 0 });
const tight = appendSetposLines('desc', ['0123456789', 'abcdefghij'], 'desc\n\n0123456789\nabc'.length);
assert.deepEqual(tight, { text: 'desc\n\n0123456789', added: 1, left: 1 });

console.log('gif/gifSetpos.test.js ok');

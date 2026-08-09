import assert from 'node:assert/strict';
import {
  CORE_OPENING_ELAPSED,
  coreOpeningDuels
} from './coreOpenings.js';

/** Minimal track: fixed alive positions per slot, any tick. */
function fakeTrack(bySlot) {
  return {
    firstTick: 0,
    sampleAll() {
      const out = [];
      for (let s = 0; s < 10; s++) {
        out[s] = bySlot[s] || { alive: false, x: 0, y: 0, z: 0 };
      }
      return out;
    }
  };
}

const roster = [
  { id: 't1', team: 1, slot: 0 },
  { id: 't2', team: 1, slot: 1 },
  { id: 't3', team: 1, slot: 2 },
  { id: 'ct1', team: 2, slot: 5 },
  { id: 'ct2', team: 2, slot: 6 },
  { id: 'ct3', team: 2, slot: 7 }
];

// Three T stacked, three CT stacked → both sides have a core.
const stacked = {
  0: { alive: true, x: 0, y: 0, z: 0 },
  1: { alive: true, x: 40, y: 0, z: 0 },
  2: { alive: true, x: 80, y: 0, z: 0 },
  5: { alive: true, x: 2000, y: 0, z: 0 },
  6: { alive: true, x: 2040, y: 0, z: 0 },
  7: { alive: true, x: 2080, y: 0, z: 0 }
};

const freezeEnd = 1000;
const rate = 64;
const afterCut = freezeEnd + (CORE_OPENING_ELAPSED + 1) * rate;
const beforeCut = freezeEnd + 5 * rate;

{
  const meta = {
    tickRate: rate,
    freezeEndTick: freezeEnd,
    events: {
      kills: [{ tick: afterCut, attacker: 't2', victim: 'ct2' }]
    }
  };
  const { cok, cod } = coreOpeningDuels(meta, fakeTrack(stacked), roster);
  assert.deepEqual(cok, ['t2']);
  assert.deepEqual(cod, ['ct2']);
}

{
  // Kill before 1:30 must not count, even if it is the only kill.
  const meta = {
    tickRate: rate,
    freezeEndTick: freezeEnd,
    events: {
      kills: [{ tick: beforeCut, attacker: 't1', victim: 'ct1' }]
    }
  };
  const { cok, cod } = coreOpeningDuels(meta, fakeTrack(stacked), roster);
  assert.deepEqual(cok, []);
  assert.deepEqual(cod, []);
}

{
  // Lurker far from the T pack: their death is not a core opening for T.
  const withLurk = {
    ...stacked,
    0: { alive: true, x: 0, y: 0, z: 0 },
    1: { alive: true, x: 40, y: 0, z: 0 },
    2: { alive: true, x: 5000, y: 0, z: 0 } // alone
  };
  const meta = {
    tickRate: rate,
    freezeEndTick: freezeEnd,
    events: {
      kills: [{ tick: afterCut, attacker: 'ct1', victim: 't3' }]
    }
  };
  const { cok, cod } = coreOpeningDuels(meta, fakeTrack(withLurk), roster);
  // CT core (ct1) gets the kill credit; T lurker death is not a T core opening.
  assert.deepEqual(cok, ['ct1']);
  assert.ok(!cod.includes('t3'));
}

console.log('coreOpenings.test.js: ok');

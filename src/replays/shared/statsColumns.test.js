// Column contracts: what a page may ask /stats for, and what it may not.
import assert from 'node:assert/strict';
import {
  COLUMN_GROUPS,
  COLUMN_GROUP_IDS,
  ColumnContractError,
  IDENTITY_ROW_KEYS,
  RATING_CORE,
  columnsSatisfy,
  projectEntry,
  resolveColumns
} from './statsColumns.js';
import { aim4RatingBreakdown } from './statsMath.js';

const entry = {
  id: 'd1',
  v: 19,
  map: 'de_nuke',
  name1: 'A',
  name2: 'B',
  players: [{ id: 'p1', name: 'donk', team: 1 }],
  roles: { p1: { tactical: 'entry' } },
  rounds: [
    {
      f: 'r1', d: 'd1', m: 'de_nuke', n: 1, w: 1, s1: 'T', s2: 'CT', e1: 4, e2: 4,
      ok: 'p1', od: 'p2', p: { p1: [1, 0, 0, 100, 5, 3, 1, 0, 0, 1] },
      sw: { p1: 12 }, kt: [{ t: 5 }], ev: [], am: { p1: { shots: 5 } },
      ut: { p1: { heThrown: 1 } }, utt: { 1: 40 }, du: { p1: { w: 1, p: 0.5, n: 1 } },
      mv: { p1: { psdt: 300, dt: 900 } }, aw: { p1: 12 }, ph: { p1: [1, 2] },
      rl: 'exec-a', cok: ['p1'], cod: [], pos1: 0.5, pos2: 0.5,
      aca1: 1, ack1: 0, aca2: 0, ack2: 1, prw1: 0.6, prw2: 0.4, dur: 45, pt: null
    }
  ]
};

// --- no contract is the old behaviour -------------------------------------
{
  const c = resolveColumns(null);
  assert.equal(c.all, true);
  assert.equal(projectEntry(entry, c), entry, 'full contract must not copy');
}

// --- identity keeps every column rowPasses filters on ----------------------
{
  const out = projectEntry(entry, resolveColumns('identity'));
  for (const k of IDENTITY_ROW_KEYS) {
    assert.ok(k in out.rounds[0], `identity must keep "${k}" for filtering`);
  }
  assert.ok(!('am' in out.rounds[0]));
  assert.ok(!('du' in out.rounds[0]));
  assert.ok(!('roles' in out), 'roles is an opt-in group');
}

// --- a group brings exactly its own keys ------------------------------------
{
  const out = projectEntry(entry, resolveColumns('shapes'));
  assert.ok('ph' in out.rounds[0]);
  assert.ok('rl' in out.rounds[0]);
  assert.ok(!('du' in out.rounds[0]));
  assert.ok(!('ut' in out.rounds[0]));
}

// --- rating preset carries every rating input -------------------------------
{
  const c = resolveColumns('rating');
  assert.equal(c.ratingReady, true);
  const out = projectEntry(entry, c);
  for (const k of ['p', 'ok', 'od', 'sw', 'kt', 'ev', 'am', 'du']) {
    assert.ok(k in out.rounds[0], `rating contract must carry "${k}"`);
  }
}

// --- THE GUARD -------------------------------------------------------------
// aim4RatingBreakdown substitutes league averages for missing terms, so a
// partial rating contract yields a plausible wrong number rather than a null.
// Prove the hazard is real, then prove the contract refuses to create it.
{
  const full = {
    rating: 1.15, swing: 0.4, kd: 1.2, xk: 0.75, duelWin: 55, kast: 74,
    opatt: 0.22, or: 56, ready: 74, aim: 71, pfo: 3.2, pfw: 52,
    swingWon: 12, swingLost: -3.9, rounds: 600
  };
  const starved = { ...full, xk: null, pfw: null, pfo: null, ready: null, aim: null };
  const a = aim4RatingBreakdown(full).value;
  const b = aim4RatingBreakdown(starved).value;
  assert.ok(Number.isFinite(b), 'starved rating is a number, not a null — that is the hazard');
  assert.ok(Math.abs(a - b) > 0.2, 'and it differs materially');

  for (const partial of [['aim'], ['duels'], ['swing', 'kills'], ['aim', 'duels', 'kills']]) {
    assert.throws(
      () => resolveColumns(partial),
      ColumnContractError,
      `partial rating contract ${partial.join('+')} must be refused`
    );
  }
  // All four together is fine.
  assert.doesNotThrow(() => resolveColumns(RATING_CORE));
  // None of them is fine too: no rating is rendered from that payload.
  assert.doesNotThrow(() => resolveColumns('shapes'));
  assert.equal(resolveColumns('shapes').ratingReady, false);
}

// --- team columns are not rating columns ------------------------------------
{
  const c = resolveColumns('team');
  assert.equal(c.ratingReady, false);
  const out = projectEntry(entry, c);
  assert.ok('prw1' in out.rounds[0], 'team PRW is not the player swing column');
  assert.ok(!('sw' in out.rounds[0]));
}

// --- unknown groups are refused, not ignored --------------------------------
assert.throws(() => resolveColumns(['nonsense']), ColumnContractError);
assert.throws(() => resolveColumns('scoreboard'), ColumnContractError); // now baseline

// --- cache reuse: wider satisfies narrower ----------------------------------
{
  assert.equal(columnsSatisfy(null, ['phase']), true, 'full payload satisfies anything');
  assert.equal(columnsSatisfy(resolveColumns('full').groups, resolveColumns('shapes').groups), true);
  assert.equal(columnsSatisfy(resolveColumns('shapes').groups, resolveColumns('rating').groups), false);
}

// --- every declared group is reachable and costed ---------------------------
for (const id of COLUMN_GROUP_IDS) {
  const def = COLUMN_GROUPS[id];
  assert.ok(Number.isFinite(def.bytes) && def.bytes >= 0, `${id} needs a measured cost`);
  assert.ok(def.rows.length || def.entry?.length, `${id} owns no keys`);
}

// --- projection is strictly smaller ----------------------------------------
{
  const full = JSON.stringify(projectEntry(entry, resolveColumns(null))).length;
  const shapes = JSON.stringify(projectEntry(entry, resolveColumns('shapes'))).length;
  const identity = JSON.stringify(projectEntry(entry, resolveColumns('identity'))).length;
  assert.ok(identity < shapes && shapes < full, 'contracts must actually shrink the payload');
}

console.log('statsColumns.test.js: all assertions passed');

// Run: node src/replays/aggregateFilters.test.js
//
// Every filter the Database can set has to REACH /api/replays/aggregate.
//
// Six of them did not: `hasAwp`, `oppHasAwp`, `roundOwn`, `roundOpp`, `fromSec`
// and `toSec` were built into the filter, drawn in the bar, and then dropped on
// the way to the request. Nothing failed. The query came back unfiltered and the
// table repainted identical numbers under a changed bar, which is what "the
// Database ignored my filter" was.
//
// So this walks the filter field by field over the real request builder, both
// transports, and asserts every one of them is on the wire.

import assert from 'node:assert/strict';
import { fetchAggregate } from './api.js';

/** Captured request, so the assertions read the wire and not an intention. */
let seen = null;
globalThis.fetch = async (url, init) => {
  seen = { url: String(url), init: init || {} };
  return { ok: true, status: 200, json: async () => ({ players: [], teams: [] }) };
};

/**
 * Every field of the Database's filter object, and the param it becomes.
 *
 * Keep this in step with the filter the stats panel builds (its `[data-clear]`
 * handler is the full list). A field that grows there and not here is exactly
 * the hole this file exists to close.
 */
const FIELDS = {
  maps: { value: ['ANU'], param: 'maps' },
  side: { value: 'T', param: 'side' },
  econ: { value: 4, param: 'econ' },
  oppEcon: { value: 4, param: 'oppEcon' },
  hasAwp: { value: true, param: 'hasAwp' },
  oppHasAwp: { value: true, param: 'oppHasAwp' },
  result: { value: 'won', param: 'result' },
  advantage: { value: '5v4', param: 'advantage' },
  role: { value: { side: 'T', value: 'Mid' }, param: 'role' },
  rankOwn: { value: 'top10', param: 'rankOwn' },
  rankOpp: { value: 'top30', param: 'rankOpp' },
  dateFrom: { value: '2026-01-01', param: 'from' },
  dateTo: { value: '2026-02-01', param: 'to' },
  minRounds: { value: 5, param: 'minRounds' },
  // The round library's own filters. The store carries the tags a round was
  // given and the clock each one came true on, so these travel like the rest.
  roundOwn: { value: ['anu-mid-take', 'anu-mid-rush'], param: 'roundOwn' },
  roundOpp: { value: ['anu-water-crunch'], param: 'roundOpp' },
  fromSec: { value: 0, param: 'fromSec' },
  toSec: { value: 35, param: 'toSec' }
};

// ---- GET: the shape every ordinary filter change uses ----------------------

for (const [field, spec] of Object.entries(FIELDS)) {
  await fetchAggregate({ [field]: spec.value }, { tables: 'players,teams' });
  assert.ok(seen, `${field}: a request was made`);
  assert.match(seen.url, /\/api\/replays\/aggregate\?/, `${field}: hits the aggregate`);
  const q = new URL(seen.url, 'http://localhost').searchParams;
  assert.ok(q.has(spec.param), `${field} reaches the server as "${spec.param}"`);
  assert.ok(String(q.get(spec.param)).length > 0, `${field} carries a value`);
}

// ---- POST: same fields, same names, taken when the files list is long ------

const files = Array.from({ length: 201 }, (_, i) => `f${i}`);
for (const [field, spec] of Object.entries(FIELDS)) {
  await fetchAggregate({ [field]: spec.value, files }, { tables: 'players' });
  const body = JSON.parse(String(seen.init.body || '{}'));
  assert.equal(seen.init.method, 'POST', `${field}: long file lists go in a body`);
  assert.ok(
    Object.prototype.hasOwnProperty.call(body, spec.param),
    `${field} reaches the server as "${spec.param}" over POST too`
  );
}

// ---- the reported case ----------------------------------------------------
//
// Anubis, four calls picked, a T role. Every part of that has to be on the wire:
// sending the role while dropping the calls is how a table ends up filtered by
// neither, because the query looks legitimate and covers every round.
{
  const active = {
    maps: ['ANU'],
    side: 'T',
    role: { side: 'T', value: 'Mid' },
    roundOwn: ['anu-mid-take', 'anu-mid-rush', 'anu-a-split', 'anu-mid-temple'],
    fromSec: 0,
    toSec: 35
  };
  await fetchAggregate(active, { tables: 'players,teams' });
  const q = new URL(seen.url, 'http://localhost').searchParams;
  assert.equal(q.get('maps'), 'ANU');
  assert.equal(q.get('side'), 'T');
  assert.equal(q.get('role'), 'T:Mid');
  assert.equal(
    q.get('roundOwn'),
    'anu-mid-take,anu-mid-rush,anu-a-split,anu-mid-temple',
    'all four calls, in one param'
  );
  assert.equal(q.get('fromSec'), '0', 'and a window bound of zero is a bound');
  assert.equal(q.get('toSec'), '35');
}

console.log('aggregateFilters.test.js ok');

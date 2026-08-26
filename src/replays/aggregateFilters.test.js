// Run: node src/replays/aggregateFilters.test.js
//
// Every filter the Database can set either REACHES /api/replays/aggregate or is
// declared unanswerable by it. There is no third option, and the third option is
// what shipped: `hasAwp`, `roundOwn`, `roundOpp`, `fromSec` and `toSec` were
// neither sent nor declared, so picking a call or an AWP round re-ran an
// identical query and repainted identical numbers under a changed filter bar.
// Nothing failed. The table simply ignored the filter.
//
// So this walks the filter field by field over the real request builder, both
// transports, and asserts the partition holds.

import assert from 'node:assert/strict';
import { fetchAggregate } from './api.js';
import { filterNeedsRounds } from './shared/statsMath.js';

/** Captured request, so the assertions read the wire and not an intention. */
let seen = null;
globalThis.fetch = async (url, init) => {
  seen = { url: String(url), init: init || {} };
  return { ok: true, status: 200, json: async () => ({ players: [], teams: [] }) };
};

/**
 * Every field of the Database's filter object, and where it has to end up.
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
  // The round library's own filters. The aggregate's resident store keeps one
  // line per round and no tags, so these can only be answered from the rounds:
  // callers check filterNeedsRounds and take that path instead.
  roundOwn: { value: ['anu-mid-take', 'anu-mid-rush'], roundsOnly: true },
  roundOpp: { value: ['anu-water-crunch'], roundsOnly: true },
  fromSec: { value: 0, roundsOnly: true },
  toSec: { value: 35, roundsOnly: true }
};

// ---- GET: the shape every ordinary filter change uses ----------------------

for (const [field, spec] of Object.entries(FIELDS)) {
  await fetchAggregate({ [field]: spec.value }, { tables: 'players,teams' });
  assert.ok(seen, `${field}: a request was made`);
  assert.match(seen.url, /\/api\/replays\/aggregate\?/, `${field}: hits the aggregate`);
  const q = new URL(seen.url, 'http://localhost').searchParams;
  if (spec.roundsOnly) {
    assert.ok(
      filterNeedsRounds({ [field]: spec.value }),
      `${field} cannot be answered here, so it must keep callers off this endpoint`
    );
    continue;
  }
  assert.ok(
    !filterNeedsRounds({ [field]: spec.value }),
    `${field} is answerable here and must not force the rounds path`
  );
  assert.ok(q.has(spec.param), `${field} reaches the server as "${spec.param}"`);
  assert.ok(String(q.get(spec.param)).length > 0, `${field} carries a value`);
}

// ---- POST: same fields, same names, taken when the files list is long ------

const files = Array.from({ length: 201 }, (_, i) => `f${i}`);
for (const [field, spec] of Object.entries(FIELDS)) {
  if (spec.roundsOnly) continue;
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
// Anubis, four calls picked, a T role. The role is answerable and rides along;
// the calls are not, and their presence is what has to move the whole query off
// this endpoint. Sending the role while dropping the calls is how a table ends
// up filtered by neither: the query looks legitimate and covers every round.
{
  const active = {
    maps: ['ANU'],
    side: 'T',
    role: { side: 'T', value: 'Mid' },
    roundOwn: ['anu-mid-take', 'anu-mid-rush', 'anu-a-split', 'anu-mid-temple']
  };
  assert.ok(filterNeedsRounds(active), 'a call pick takes the rounds path, role or not');
  await fetchAggregate(active, { tables: 'players,teams' });
  const q = new URL(seen.url, 'http://localhost').searchParams;
  assert.equal(q.get('role'), 'T:Mid', 'the role alone would have been honoured');
  assert.equal(q.get('roundOwn'), null, 'and the calls are not quietly sent as a no-op');
}

// Clearing the picks puts the query back on the fast path.
assert.equal(
  filterNeedsRounds({ maps: ['ANU'], side: 'T', role: { side: 'T', value: 'Mid' } }),
  false
);

console.log('aggregateFilters.test.js ok');

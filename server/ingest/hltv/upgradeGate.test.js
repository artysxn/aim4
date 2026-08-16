// Run: node server/ingest/hltv/upgradeGate.test.js
//
// The ingester's duplicate check has one exception: a match we already hold is
// re-stored when the copy we hold came from an OLDER parser. That is what
// makes a re-run of the crawler upgrade the library instead of skipping it.
//
// The rule that matters, and the one this exists to protect: an upgrade keeps
// the EXISTING demo id. Minting a new one would leave the stale copy in place
// and add a second beside it — 4200 duplicates instead of 4200 upgrades — and
// every link, note and tag pointing at the match would still resolve to the
// version without jump or crouch.

import { PARSER_REVISION } from '../../demoparser/schema.js';
import { fingerprintDemo, fingerprintRecord, fingerprintsMatch } from './duplicates.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

/**
 * The gate, exactly as ingestParseWorker applies it. Kept as a pure function
 * here so the decision can be tested without forking a parser: the worker
 * computes `upgrading` and `targetId` from these two inputs and nothing else.
 */
function decide(dup, freshId) {
  const dupRevision = dup ? (dup.parser?.revision ?? 1) : null;
  const upgrading = Boolean(dup) && dupRevision < PARSER_REVISION;
  return {
    upgrading,
    skipped: Boolean(dup) && !upgrading,
    targetId: upgrading ? dup.id : freshId
  };
}

// ---- a stale duplicate is overridden in place -----------------------------
{
  for (const revision of [undefined, 1, 2]) {
    const dup = { id: 'existing-1', parser: revision === undefined ? undefined : { revision } };
    const d = decide(dup, 'fresh-9');
    assert(d.upgrading, `revision ${revision} upgrades`);
    assert(!d.skipped, `revision ${revision} is not skipped`);
    assert(d.targetId === 'existing-1', `revision ${revision} writes under the EXISTING id, not a new one`);
  }
}

// ---- a current duplicate is still skipped ---------------------------------
{
  const dup = { id: 'existing-2', parser: { revision: PARSER_REVISION } };
  const d = decide(dup, 'fresh-9');
  assert(!d.upgrading, 'a current copy is not re-stored');
  assert(d.skipped, 'a current copy is reported as a duplicate');
}

// ---- a future revision is left alone --------------------------------------
{
  // A rollback must not cause the older binary to overwrite newer data.
  const dup = { id: 'existing-3', parser: { revision: PARSER_REVISION + 1 } };
  const d = decide(dup, 'fresh-9');
  assert(!d.upgrading, 'a newer copy is never downgraded');
  assert(d.skipped, 'a newer copy is treated as a duplicate');
}

// ---- no duplicate: a genuinely new demo keeps its fresh id ----------------
{
  const d = decide(null, 'fresh-9');
  assert(!d.upgrading && !d.skipped, 'a new match is stored normally');
  assert(d.targetId === 'fresh-9', 'a new match uses the id the pipeline minted');
}

// ---- the gate only fires on demos the matcher actually paired -------------
// The revision check rides on top of fingerprinting; it must not widen what
// counts as the same match.
{
  const players = Array.from({ length: 10 }, (_, i) => ({ steamId: `7656119${i}`, name: `p${i}` }));
  const demo = { map: 'NUK', rounds: [{ players }, { winner: 1 }, { winner: 2 }] };
  const fresh = fingerprintDemo(demo, 100_000_000);

  const same = fingerprintRecord({
    map: 'NUK',
    players,
    score: { team1: 1, team2: 1 },
    sizeBytes: 100_000_000,
    id: 'x'
  });
  assert(fingerprintsMatch(fresh, same), 'the same match on the same map pairs');

  const otherMap = fingerprintRecord({
    map: 'INF',
    players,
    score: { team1: 1, team2: 1 },
    sizeBytes: 100_000_000,
    id: 'y'
  });
  assert(!fingerprintsMatch(fresh, otherMap), 'a different map never pairs');

  const otherPlayers = fingerprintRecord({
    map: 'NUK',
    players: players.map((p, i) => ({ steamId: `999${i}`, name: `q${i}` })),
    score: { team1: 1, team2: 1 },
    sizeBytes: 100_000_000,
    id: 'z'
  });
  assert(!fingerprintsMatch(fresh, otherPlayers), 'a different roster never pairs');

  const otherSize = fingerprintRecord({
    map: 'NUK',
    players,
    score: { team1: 1, team2: 1 },
    sizeBytes: 10_000_000,
    id: 'w'
  });
  assert(!fingerprintsMatch(fresh, otherSize), 'a very different file size never pairs');
}

console.log('upgradeGate.test: ok');

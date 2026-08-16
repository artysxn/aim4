// Run: node server/ingest/hltv/reparseGate.test.js
//
// upgradeGate.test.js covers the decision ingestParseWorker makes once a demo
// has been downloaded and parsed. This covers the one BEFORE it: whether the
// crawler bothers to download the demo at all.
//
// That ordering is the whole point. runOneDemo used to return early on ledger
// state alone, so a match parsed by an older revision never reached the
// upgrade gate and the library kept a parse with no jump or crouch data
// forever. A row is only "done" if the parser that produced it is current.

import { PARSER_REVISION } from '../../demoparser/schema.js';
import { STATES } from './ledger.js';
import { needsParserUpgrade } from './pipeline.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- a row from an older parser is re-driven ------------------------------
{
  for (const rev of [1, 2]) {
    const row = { state: STATES.CLEANED, parserRevision: rev };
    assert(needsParserUpgrade(row), `cleaned at revision ${rev} is re-downloaded`);
  }
}

// ---- rows written before the field existed count as stale -----------------
// Every row in the live ledger predates this stamp; if an absent revision read
// as current, the upgrade would silently never happen.
{
  assert(
    needsParserUpgrade({ state: STATES.CLEANED }),
    'a cleaned row with no recorded revision is stale, not current'
  );
  assert(
    needsParserUpgrade({ state: STATES.NEEDS_REVIEW }),
    'needs_review is ingested data too, and upgrades the same way'
  );
  assert(
    needsParserUpgrade({ state: STATES.FILTERED_OUT }),
    'filtered_out held duplicates that may themselves be stale'
  );
}

// ---- a current row is left alone ------------------------------------------
{
  for (const state of [STATES.CLEANED, STATES.NEEDS_REVIEW, STATES.FILTERED_OUT]) {
    const row = { state, parserRevision: PARSER_REVISION };
    assert(!needsParserUpgrade(row), `${state} at the current revision is not re-downloaded`);
  }
}

// ---- a newer row is never downgraded --------------------------------------
// A rollback to an older binary must not drag the library backwards.
{
  const row = { state: STATES.CLEANED, parserRevision: PARSER_REVISION + 1 };
  assert(!needsParserUpgrade(row), 'a newer parse is left alone');
}

// ---- failed_permanent is not an upgrade candidate -------------------------
// Those never produced a parse, and the set includes unpublished-id gaps that
// would each cost a download to re-confirm for nothing.
{
  const row = { state: STATES.FAILED, lastError: 'HLTV demo not published' };
  assert(!needsParserUpgrade(row), 'failed_permanent is not re-driven by the revision check');
}

// ---- an unknown row is not an upgrade -------------------------------------
{
  assert(!needsParserUpgrade(null), 'a missing row is not an upgrade candidate');
}

// ---- the stamp settles: re-parsing a stale row makes it current -----------
// Without this the filtered_out path in particular would re-download on every
// single crawl, forever.
{
  const row = { state: STATES.CLEANED };
  assert(needsParserUpgrade(row), 'stale before');
  row.parserRevision = PARSER_REVISION;
  assert(!needsParserUpgrade(row), 'current after the stamp, so it settles');
}

console.log('reparseGate.test: ok');

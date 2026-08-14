// Run: node shared/sim/firewall.test.js
//
// 9.5's acceptance is one sentence: "a CI test tries to ingest a sim round and
// is rejected". This is that test. It is deliberately unglamorous — the value
// of a firewall is entirely in the cases nobody thought about, so most of what
// is below is the awkward spellings rather than the happy path.

import {
  FirewallError,
  RESERVED_LIBRARY_KEYS,
  SIM_LIBRARY_KEY,
  assertNotReservedKey,
  assertReal,
  isReservedLibraryKey,
  isSynthetic,
  markSynthetic
} from './firewall.js';
import { userKey } from '../../server/replays/demoStore.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function throws(fn, msg) {
  try {
    fn();
  } catch (err) {
    assert(err instanceof FirewallError, `${msg}: threw, but not a FirewallError (${err.name})`);
    assert(err.firewall === true, `${msg}: not flagged as a firewall refusal`);
    return err;
  }
  throw new Error(`${msg}: did not throw`);
}

// ---- the marker ----------------------------------------------------------

{
  assert(isSynthetic(markSynthetic({ map: 'INF' })) === true, 'a stamped meta is synthetic');
  assert(isSynthetic({ map: 'INF' }) === false, 'a real meta is not');
  assert(isSynthetic(null) === false, 'and neither is nothing');
  assert(isSynthetic({ synthetic: false }) === false, 'an explicit false is honoured');
  // The dangerous direction: anything present and not literally false counts.
  // A meta that has been through form data or a CSV carries "false" the
  // string, and a truthiness check would read that as real.
  assert(isSynthetic({ synthetic: 'true' }) === true, 'the string "true" is synthetic');
  assert(isSynthetic({ synthetic: 1 }) === true, 'so is 1');
  assert(isSynthetic({ synthetic: 'false' }) === false, 'the string "false" is not');
}

{
  // The stamp is not negotiable: it goes on last, so an `extra` bag cannot
  // clear it. This is the shape encode.js relies on.
  const meta = { map: 'INF', ...{ synthetic: false }, ...markSynthetic({}) };
  assert(isSynthetic(meta) === true, 'a caller cannot un-set the marker');
  assert(meta.map === 'INF', 'and the rest of the meta survives');
}

// ---- the reserved names --------------------------------------------------

{
  assert(isReservedLibraryKey(SIM_LIBRARY_KEY) === true, 'sim is reserved');
  assert(isReservedLibraryKey('zones') === true, 'so is zones, as it always was');
  assert(isReservedLibraryKey('local') === false, 'the real library is not');
  // Case folding matters on the volumes this actually runs on: macOS is
  // case-insensitive by default, so Sim/ and sim/ are one directory.
  assert(isReservedLibraryKey('SIM') === true, 'uppercase is the same directory');
  assert(isReservedLibraryKey('  Sim  ') === true, 'and so is a padded one');
  assert(RESERVED_LIBRARY_KEYS.includes('sim'), 'the list is the list');
}

// ---- the refusals --------------------------------------------------------

{
  const err = throws(() => assertNotReservedKey('sim', 'test'), 'reading the sim tree as a library');
  assert(/12\.1/.test(err.message), 'the refusal cites the rule it is enforcing');
  assertNotReservedKey('local', 'test'); // does not throw
}

{
  const err = throws(() => assertReal(markSynthetic({ map: 'INF' }), 'test'), 'ingesting a sim round');
  assert(/12\.1/.test(err.message), 'and so does this one');
  assertReal({ map: 'INF' }, 'test'); // does not throw
  assertReal(null, 'test'); // a missing meta is a missing file, not a breach
}

// ---- the acceptance: the demo store itself refuses ------------------------

{
  // The store is how every extractor, trainer, and the stats index reads
  // rounds. Asking it for the sim library is the ingest 12.1 forbids.
  throws(() => userKey('sim'), 'demoStore.userKey("sim")');
  throws(() => userKey('SIM'), 'demoStore.userKey("SIM")');
  // Sanitizing must not become a way through: userKey strips characters
  // before it decides, so a spelling that *becomes* "sim" is still "sim".
  throws(() => userKey('s.i.m'), 'a key that sanitizes into sim');
  assert(userKey('local') === 'local', 'the real library still resolves');
  assert(userKey('') === 'local', 'and the empty fallback is unchanged');
}

console.log('firewall: ok');

// Run: node server/replays/parseGate.test.js
//
// The marker file is the only thing standing between a user's upload and an
// ingest parse sharing the box's memory, so the cases that matter are the
// lifecycle (mark → seen, clear → gone) and the crash story: a marker whose
// writer died must read as idle, or a kill -9 of the API parks ingest forever.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './demoStore.js';
import {
  clearUserParseActive,
  markUserParseActive,
  userParseActive,
  waitForUserParseIdle
} from './parseGate.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const MARKER = path.join(ROOT, '.user-parse-active');

{
  clearUserParseActive();
  assert(!(await userParseActive()), 'no marker means idle');
  console.log('  a missing marker reads as idle');
}

{
  markUserParseActive();
  assert(await userParseActive(), 'a fresh marker reads as active');
  assert(fs.existsSync(MARKER), 'the marker is a real file on the replay volume');
  clearUserParseActive();
  assert(!(await userParseActive()), 'clearing removes it');
  console.log('  mark → active, clear → idle');
}

{
  // A crashed writer: the file exists but nobody heartbeats it. Backdate the
  // mtime past the staleness window and it must read as idle.
  markUserParseActive();
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fsp.utimes(MARKER, old, old);
  assert(!(await userParseActive()), 'a stale marker reads as idle, not busy');
  clearUserParseActive();
  console.log('  a marker from a dead process does not park ingest');
}

{
  // The waiter returns promptly when idle, and actually waits when active.
  const idleWait = await waitForUserParseIdle({ pollMs: 10 });
  assert(idleWait === 0, 'no wait when idle');

  markUserParseActive();
  let waited = false;
  const waiter = waitForUserParseIdle({ pollMs: 25, onWait: () => (waited = true) });
  setTimeout(() => clearUserParseActive(), 80);
  const ms = await waiter;
  assert(waited, 'onWait fired once the hold began');
  assert(ms >= 25, `waited through at least one poll, got ${ms}`);
  console.log('  the waiter holds while the marker is fresh and releases when it goes');
}

clearUserParseActive();
console.log('parseGate: all assertions passed');

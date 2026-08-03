// Ledger state machine: the property the whole ingester rests on is that a
// process killed at any point leaves a row saying what it was in the middle of,
// and that startup can put that row back to work.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Ledger, STATES, openLedger } from './ledger.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-ledger-'));
const file = path.join(tmp, 'ledger.json');

const match = (id, playedAt) => ({
  matchId: id,
  archiveName: `event-a-vs-b-bo3-${id}.rar`,
  playedAt
});

{
  const l = new Ledger(file);
  l.upsertDiscovered(match('m1', '2025-03-01T00:00:00Z'));
  l.upsertDiscovered(match('m2', '2025-01-01T00:00:00Z'));
  l.upsertDiscovered(match('m3', '2025-02-01T00:00:00Z'));

  const batch = l.nextBatch(3);
  assert(batch.length === 3, 'batch of three');
  // Chronological, because the admin page reports a position in time.
  assert(
    batch.map((r) => r.matchId).join(',') === 'm2,m3,m1',
    `oldest first, got ${batch.map((r) => r.matchId).join(',')}`
  );
}

{
  // Re-discovering a known match must not reset its progress. Discovery runs
  // every poll, so a non-idempotent upsert would re-ingest the whole library.
  const l = new Ledger(file);
  l.upsertDiscovered(match('m1', '2025-03-01T00:00:00Z'));
  l.setState('m1', STATES.CLEANED, { demoIds: ['a', 'b'] });
  l.upsertDiscovered({ ...match('m1', '2025-03-01T00:00:00Z'), event: 'Renamed Event' });

  const row = l.get('m1');
  assert(row.state === STATES.CLEANED, 'state survives re-discovery');
  assert(row.demoIds.length === 2, 'demo ids survive re-discovery');
  assert(row.event === 'Renamed Event', 'metadata is refreshed');
  assert(l.nextBatch(5).length === 0, 'a cleaned row is never queued again');
}

{
  // A crash mid-download or mid-parse must come back as work to redo.
  const l = new Ledger(file);
  l.upsertDiscovered(match('d1', '2025-01-01T00:00:00Z'));
  l.upsertDiscovered(match('p1', '2025-01-02T00:00:00Z'));
  l.upsertDiscovered(match('c1', '2025-01-03T00:00:00Z'));
  l.setState('d1', STATES.DOWNLOADING);
  l.setState('p1', STATES.PARSING);
  l.setState('c1', STATES.CLEANED);

  const recovered = l.recoverInterrupted();
  assert(recovered.length === 2, `two interrupted rows, got ${recovered.length}`);
  assert(l.get('d1').state === STATES.DISCOVERED, 'downloading requeued');
  assert(l.get('p1').state === STATES.PARSING ? false : true, 'parsing requeued');
  assert(l.get('c1').state === STATES.CLEANED, 'finished work is left alone');
}

{
  // Attempts are capped so one poisonous match cannot block the queue forever.
  const l = new Ledger(file);
  l.upsertDiscovered(match('bad', '2025-01-01T00:00:00Z'));
  l.fail('bad', new Error('boom'), 3);
  assert(l.get('bad').state === STATES.DISCOVERED, 'first failure retries');
  l.fail('bad', new Error('boom'), 3);
  assert(l.get('bad').state === STATES.DISCOVERED, 'second failure retries');
  l.fail('bad', new Error('boom'), 3);
  assert(l.get('bad').state === STATES.FAILED, 'third failure is terminal');
  assert(l.nextBatch(5).every((r) => r.matchId !== 'bad'), 'terminal row leaves the queue');
  assert(l.get('bad').lastError.includes('boom'), 'the reason is kept');
}

{
  // Round trip through disk, which is what makes a restart cheap.
  const l = new Ledger(file);
  l.upsertDiscovered(match('s1', '2025-05-05T00:00:00Z'));
  l.setState('s1', STATES.INGESTED, { demoIds: ['x'] });
  await l.save();

  const reopened = await openLedger(file);
  assert(reopened.get('s1')?.state === STATES.INGESTED, 'state survives a reload');
  assert(reopened.get('s1').demoIds[0] === 'x', 'demo ids survive a reload');

  const counts = reopened.counts();
  assert(counts.total === 1, 'counts total');
  assert(counts.remaining === 1, 'ingested is not yet done');
}

{
  const l = new Ledger(path.join(tmp, 'counts.json'));
  l.upsertDiscovered(match('a', '2025-01-01T00:00:00Z'));
  l.upsertDiscovered(match('b', '2025-01-02T00:00:00Z'));
  l.upsertDiscovered(match('c', '2025-01-03T00:00:00Z'));
  l.setState('a', STATES.CLEANED);
  l.setState('b', STATES.FAILED);
  const counts = l.counts();
  assert(counts.done === 2, `done counts terminal rows, got ${counts.done}`);
  assert(counts.remaining === 1, 'remaining is the rest');
  assert(l.oldestPending()?.matchId === 'c', 'oldest pending is the queue head');
}

await fsp.rm(tmp, { recursive: true, force: true });
console.log('hltv ledger: all assertions passed');

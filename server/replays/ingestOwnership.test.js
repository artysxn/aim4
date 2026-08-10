// Run: node server/replays/ingestOwnership.test.js
//
// Guards the seam where a SUCCESSFUL parse replaces the placeholder record.
// startIngest stamps the placeholder with who uploaded the demo and how
// visible it is, but the parse worker's meta never carried those, and the
// materialized "ready" record used to replace the placeholder wholesale — so
// every successfully parsed upload fell back to the legacy uploader and,
// worse, private uploads came out public. The failed-parse path never had the
// bug (markFailed spreads the old record), which is exactly why ingest.test.js
// missed it: its fixtures all fail to parse.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HEADER_BYTES,
  TICK_BYTES,
  PLAYER_SLOTS,
  writeHeader,
  writeRecord
} from '../../src/replays/shared/tickFormat.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-ingest-own-'));
process.env.AIM4_REPLAY_DIR = ROOT;

// ROOT is read at module load, so the env has to be set before the imports.
const store = await import('./demoStore.js');
const { ingestDemo } = await import('./ingest.js');

const USER = 'local';
const DEMO_ID = 'feedbead12345678';

function makeTicks(rows) {
  const buf = Buffer.alloc(HEADER_BYTES + rows * TICK_BYTES);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  writeHeader(view, {
    tickCount: rows,
    firstTick: 0,
    stride: 1,
    tickRate: 64,
    playerCount: PLAYER_SLOTS
  });
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < PLAYER_SLOTS; s++) {
      writeRecord(view, r, s, {
        x: s * 100,
        y: r,
        z: 64,
        yaw: 0,
        pitch: 0,
        health: 100,
        armor: 100,
        weapon: 1,
        flags: 1,
        flash: 0,
        side: s < 5 ? 2 : 3
      });
    }
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const players = Array.from({ length: 10 }, (_, s) => ({
  id: `p${String(s).padStart(2, '0')}`,
  name: `Player ${s}`,
  steamId: `7656119800000000${s}`,
  team: s < 5 ? 1 : 2,
  slot: s
}));

/** The smallest demo materializeDemo will accept. */
const demo = {
  map: 'INF',
  tickRate: 64,
  team1: { id: 'AAA', name: 'Alpha' },
  team2: { id: 'BBB', name: 'Bravo' },
  parser: { name: 'test', version: '0', revision: 1 },
  rounds: [
    {
      round: 1,
      winner: 1,
      winnerSide: 'T',
      team1Side: 'T',
      team2Side: 'CT',
      econ1: 0,
      econ2: 0,
      startTick: 0,
      freezeEndTick: 100,
      plantTick: null,
      endTick: 900,
      officialEndTick: 1000,
      players,
      weapons: ['none', 'ak47'],
      ticks: makeTicks(64),
      events: { kills: [], shots: [], grenades: [], bomb: [] },
      stats: {}
    }
  ]
};

// The placeholder startIngest writes when the upload is accepted.
await store.writeRecord(USER, {
  id: DEMO_ID,
  status: 'parsing',
  filename: 'heione-match.dem',
  sizeBytes: 12345,
  uploadedAt: Date.now(),
  uploaderId: 'user-heione',
  uploaderName: 'heione',
  visibility: 'private',
  rounds: []
});

// A successful parse, with the meta the worker actually sends: no owner.
{
  const record = await ingestDemo(USER, DEMO_ID, demo, {
    filename: 'heione-match.dem',
    sizeBytes: 12345,
    uploadedAt: Date.now()
  });
  assert(record.status === 'ready', `parse produced a ready record, got ${record.status}`);
  assert(
    record.uploaderId === 'user-heione',
    `uploaderId survives the parse swap, got "${record.uploaderId}"`
  );
  assert(
    record.uploaderName === 'heione',
    `uploaderName survives the parse swap, got "${record.uploaderName}"`
  );
  assert(
    record.visibility === 'private',
    `a private upload stays private after parsing, got "${record.visibility}"`
  );

  const onDisk = await store.readRecord(USER, DEMO_ID);
  assert(onDisk.uploaderName === 'heione', 'and the persisted record agrees');
  assert(onDisk.visibility === 'private', 'on disk too');
  console.log('  ownership and visibility survive a successful parse');
}

// A caller that stamps meta explicitly (imports, HLTV) wins over the placeholder.
{
  const record = await ingestDemo(USER, DEMO_ID, demo, {
    filename: 'heione-match.dem',
    uploaderId: 'user-import',
    uploaderName: 'importer',
    visibility: 'unlisted'
  });
  assert(record.uploaderName === 'importer', 'explicit meta ownership wins');
  assert(record.visibility === 'unlisted', 'explicit meta visibility wins');
  console.log('  explicit meta still outranks the placeholder');
}

// No placeholder at all (HLTV ingest writes fresh): nothing invents an owner.
{
  const record = await ingestDemo(USER, 'aaaabbbbccccdddd', demo, {
    filename: 'fresh.dem'
  });
  assert(record.uploaderId === '', 'no placeholder, no invented uploader');
  console.log('  a fresh ingest stays unattributed');
}

await fsp.rm(ROOT, { recursive: true, force: true });
console.log('ingestOwnership: all assertions passed');

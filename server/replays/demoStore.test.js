// Run: node server/replays/demoStore.test.js
//
// Proves the compact form is invisible from above: what writeRound stores and
// what readRoundTicks hands back are the same bytes the viewer used to get,
// and a library that predates compaction still reads.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  HEADER_BYTES,
  TICK_BYTES,
  PLAYER_SLOTS,
  writeHeader,
  writeRecord,
  sliceStride
} from '../../src/replays/shared/tickFormat.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-store-'));
process.env.AIM4_REPLAY_DIR = ROOT;

// ROOT is read at module load, so the env has to be set before the import.
const store = await import('./demoStore.js');

const USER = 'local';
const DEMO_ID = 'abc123def4567890';
const ROUND_ID = 'FZE-VP-W12-INF-05_aaabbbcccdddeee_fffggghhhiiijjj';

function makeTicks(rows) {
  const buf = Buffer.alloc(HEADER_BYTES + rows * TICK_BYTES);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  writeHeader(view, {
    tickCount: rows,
    firstTick: 9001,
    stride: 1,
    tickRate: 64,
    playerCount: PLAYER_SLOTS
  });
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < PLAYER_SLOTS; s++) {
      writeRecord(view, r, s, {
        x: Math.sin(r / 40 + s) * 1200,
        y: Math.cos(r / 37 + s) * 1200,
        z: 64 + s,
        yaw: ((r * 0.7 + s * 36) % 360) - 180,
        pitch: Math.sin(r / 90) * 20,
        health: r > 3000 && s === 2 ? 0 : 100,
        armor: 100,
        weapon: 4 + (s % 3),
        flags: 1,
        flash: 0,
        side: s < 5 ? 2 : 3
      });
    }
  }
  return buf;
}

const ticks = makeTicks(7000);
const round = {
  id: ROUND_ID,
  round: 5,
  winner: 1,
  winnerSide: 'T',
  team1: { id: 'FZE', name: 'FaZe' },
  team2: { id: 'VP', name: 'Virtus.pro' },
  startTick: 9001,
  freezeEndTick: 9200,
  endTick: 15800,
  events: {
    kills: [{ tick: 9400, attacker: 'aaa', victim: 'fff', weapon: 'ak47', headshot: true }],
    shots: [{ tick: 9399, player: 'aaa', weapon: 'ak47', x: 1.5, y: -2.25, z: 64, yaw: 91.5, pitch: -1.25 }],
    grenades: [],
    bomb: []
  },
  ticks: ticks.buffer.slice(ticks.byteOffset, ticks.byteOffset + ticks.byteLength)
};

// ---- write, then read back through the public API ---------------------------

const stem = await store.writeRound(USER, DEMO_ID, round, { map: 'INF' });
assert(stem === `${ROUND_ID}~${DEMO_ID}`, 'stem is roundId~demoId');

{
  const full = Buffer.from(await store.readRoundTicks(USER, stem, 1));
  assert(Buffer.compare(full, ticks) === 0, 'full read is byte-identical to what was written');
}

{
  const want = Buffer.from(sliceStride(ticks, 100));
  const got = Buffer.from(await store.readRoundTicks(USER, stem, 100));
  assert(Buffer.compare(want, got) === 0, 'coarse read matches sliceStride exactly');
}

{
  // An odd stride has no sidecar and must fall through to the decoder.
  const want = Buffer.from(sliceStride(ticks, 7));
  const got = Buffer.from(await store.readRoundTicks(USER, stem, 7));
  assert(Buffer.compare(want, got) === 0, 'arbitrary stride matches sliceStride');
}

{
  const meta = await store.readRoundMeta(USER, stem);
  assert(meta.map === 'INF', 'extra fields survive');
  assert(meta.demoId === DEMO_ID, 'demoId stamped');
  assert(meta.ticks === undefined, 'ticks are not duplicated into the meta');
  assert(meta.events.kills[0].weapon === 'ak47', 'events survive');
  assert(meta.events.shots[0].yaw === 91.5, 'shot angles keep full precision');
  assert(meta.events.shots[0].y === -2.25, 'shot positions keep full precision');
}

{
  const names = await store.listRoundNames(USER);
  assert(names.length === 1 && names[0] === stem, `listRoundNames -> ${JSON.stringify(names)}`);
}

// ---- notes round-trip through the compressed meta ---------------------------

{
  await store.writeRoundNotes(USER, stem, { notes: [{ id: 'n1', tick: 9500, text: 'stack B' }] });
  const meta = await store.readRoundMeta(USER, stem);
  assert(meta.notes?.[0]?.text === 'stack B', 'note written into compressed meta');
  assert(meta.events.kills.length === 1, 'note write preserves the rest of the meta');
  const noted = await store.listNotedRounds(USER);
  assert(noted.includes(stem), 'notes index updated');
}

{
  // renameDemoTeams walks the demo record's round list, so the record has to
  // exist the way ingestDemo would have written it.
  await store.writeRecord(USER, {
    id: DEMO_ID,
    status: 'ready',
    filename: 'faze-vs-vp-m2-inferno.dem',
    team1: { id: 'FZE', name: 'FaZe' },
    team2: { id: 'VP', name: 'Virtus.pro' },
    rounds: [{ file: stem }]
  });
  await store.renameDemoTeams(USER, DEMO_ID, 'FaZe Clan', 'VP');
  const meta = await store.readRoundMeta(USER, stem);
  assert(meta.team1.name === 'FaZe Clan', 'team rename reaches the compressed meta');
  assert(meta.notes?.[0]?.text === 'stack B', 'rename preserves notes');
}

// ---- a library written before compaction still reads ------------------------

{
  const legacyStem = `LEG-ACY-W12-INF-01_aaabbbcccdddeee_fffggghhhiiijjj~${DEMO_ID}`;
  const dir = path.join(ROOT, USER, 'rounds');
  await fsp.writeFile(path.join(dir, `${legacyStem}.bin`), ticks);
  await fsp.writeFile(path.join(dir, `${legacyStem}.json`), JSON.stringify({ map: 'INF', legacy: true }));

  const full = Buffer.from(await store.readRoundTicks(USER, legacyStem, 1));
  assert(Buffer.compare(full, ticks) === 0, 'legacy .bin full read unchanged');
  const coarse = Buffer.from(await store.readRoundTicks(USER, legacyStem, 100));
  assert(Buffer.compare(coarse, Buffer.from(sliceStride(ticks, 100))) === 0, 'legacy coarse read unchanged');
  const meta = await store.readRoundMeta(USER, legacyStem);
  assert(meta.legacy === true, 'legacy .json still read');
  const names = await store.listRoundNames(USER);
  assert(names.length === 2, 'legacy round is listed alongside the compact one');
}

// ---- size ------------------------------------------------------------------

{
  const dir = path.join(ROOT, USER, 'rounds');
  const size = async (f) => (await fsp.stat(path.join(dir, f))).size;
  const tickz = await size(`${stem}.tickz`);
  const coarse = await size(`${stem}.c100.bin`);
  const metaZ = await size(`${stem}.json.zst`);
  const plainMeta = Buffer.byteLength(
    JSON.stringify({ ...round, ticks: undefined, map: 'INF', demoId: DEMO_ID })
  );
  console.log(`  ticks  ${(ticks.length / 1024).toFixed(0)} KB -> ${(tickz / 1024).toFixed(0)} KB tickz + ${(coarse / 1024).toFixed(0)} KB coarse`);
  console.log(`  meta   ${(plainMeta / 1024).toFixed(1)} KB -> ${(metaZ / 1024).toFixed(1)} KB`);
  assert(tickz + coarse < ticks.length * 0.8, 'compact form is at least 20% smaller');
}

// ---- delete takes every file with it ----------------------------------------

{
  await store.deleteDemo(USER, DEMO_ID);
  const left = await fsp.readdir(path.join(ROOT, USER, 'rounds'));
  assert(left.length === 0, `deleteDemo left files behind: ${left.join(', ')}`);
}

await fsp.rm(ROOT, { recursive: true, force: true });
console.log('demoStore: all assertions passed');

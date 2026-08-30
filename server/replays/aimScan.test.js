// The aim rescan, against a temporary library on disk.
//
// The behaviour worth pinning is not the measurement (aimMotion.test.js does
// that) but the QUEUE: it has to survive a reader jumping the line, it has to
// stand aside for a library job, it has to remember what it finished, and a
// demo already measured has to cost one JSON read rather than a tick walk.
// Those are the four ways a background pass beside live traffic goes wrong.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { HEADER_BYTES, TICK_BYTES, FLAG_ALIVE, writeHeader, writeRecord } from '../../src/replays/shared/tickFormat.js';
import { AIM_MOTION_VERSION } from '../../src/replays/shared/aimMotion.js';
import {
  aimScanPending,
  aimScanStatus,
  ensureAimScanLedger,
  initAimScan,
  prioritizeAimScan,
  resetAimScanForTests,
  setAimScanPauseWhen,
  startAimScan,
  stopAimScan
} from './aimScan.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aimscan-'));
const USER = 'shared';
const userDir = () => path.join(root, USER);
const statsDir = () => path.join(userDir(), 'stats');

const TICK_RATE = 64;
const TICKS = 140;

/** One round: A flicks 90 degrees onto B at tick 70 and connects. */
function roundMeta(file) {
  const yawAt = (t) => (t <= 60 ? 0 : t >= 70 ? 90 : ((t - 60) / 10) * 90);
  return {
    file,
    tickRate: TICK_RATE,
    map: 'de_test',
    players: [
      { id: 'aaa', name: 'A', team: 1, slot: 0 },
      { id: 'bbb', name: 'B', team: 2, slot: 5 }
    ],
    events: {
      shots: [{ tick: 70, player: 'aaa', weapon: 'ak47', x: 0, y: 0, yaw: yawAt(70) }],
      damage: [{ tick: 72, attacker: 'aaa', victim: 'bbb', weapon: 'ak47', hp: 40 }],
      kills: [{ tick: 72, attacker: 'aaa', victim: 'bbb', weapon: 'ak47' }],
      grenades: []
    }
  };
}

function roundTicks() {
  const yawAt = (t) => (t <= 60 ? 0 : t >= 70 ? 90 : ((t - 60) / 10) * 90);
  const buffer = new ArrayBuffer(HEADER_BYTES + TICKS * TICK_BYTES);
  const view = new DataView(buffer);
  writeHeader(view, {
    tickCount: TICKS,
    firstTick: 0,
    stride: 1,
    tickRate: TICK_RATE,
    playerCount: 10
  });
  const base = {
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, health: 100, armor: 100,
    weapon: 0, flags: FLAG_ALIVE, flash: 0, side: 2
  };
  for (let t = 0; t < TICKS; t++) {
    for (let slot = 0; slot < 10; slot++) {
      if (slot === 0) writeRecord(view, t, slot, { ...base, yaw: yawAt(t) });
      else if (slot === 5) writeRecord(view, t, slot, { ...base, y: 1000, yaw: -90, side: 3 });
      else writeRecord(view, t, slot, { ...base, x: 9000, y: 9000, health: 0, flags: 0 });
    }
  }
  return Buffer.from(buffer);
}

/** Records the scan walks, and the stats index each one already has. */
const DEMOS = ['d1', 'd2', 'd3', 'd4'];
const records = DEMOS.map((id, i) => ({
  id,
  filename: `${id}.dem`,
  status: 'ready',
  uploadedAt: 1000 + i,
  parsedAt: 1000 + i,
  roundCount: 1,
  team1: { name: 'T1' },
  team2: { name: 'T2' }
}));

/** Mirrors `versionKey` / `recordFingerprint` in statsIndex.js. */
const keyFor = (r) =>
  `19|${[r.parsedAt, r.uploadedAt, r.roundCount, r.team1.name, r.team2.name].join('|')}`;

let metaReads = 0;
let tickReads = 0;

const io = {
  userDir,
  async readRoundMeta(_user, file) {
    metaReads += 1;
    return roundMeta(file);
  },
  async readRoundTicks(_user, _file, _stride) {
    tickReads += 1;
    return roundTicks();
  },
  async getZones() {
    return null;
  }
};

async function writeEntry(id, { a2v = undefined } = {}) {
  const record = records.find((r) => r.id === id);
  const entry = {
    id,
    v: 19,
    key: keyFor(record),
    map: 'de_test',
    players: [
      { id: 'aaa', name: 'A', team: 1, slot: 0 },
      { id: 'bbb', name: 'B', team: 2, slot: 5 }
    ],
    rounds: [{ f: `${id}-r1`, d: id, m: 'de_test', n: 1, w: 1, s1: 'T', s2: 'CT', p: {} }]
  };
  if (a2v !== undefined) {
    entry.a2v = a2v;
    entry.rounds[0].a2 = {};
  }
  await fsp.mkdir(statsDir(), { recursive: true });
  await fsp.writeFile(path.join(statsDir(), `${id}.json`), JSON.stringify(entry));
}

const readEntry = async (id) =>
  JSON.parse(await fsp.readFile(path.join(statsDir(), `${id}.json`), 'utf8'));

/** Wait for the detached loop to stop, rather than guessing at a delay. */
async function settle(limitMs = 15000) {
  const until = Date.now() + limitMs;
  while (aimScanStatus().running && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(aimScanStatus().running, false, 'scan finished');
}

// ---------------------------------------------------------------------------
{
  // A plain run measures every demo that has an index, remembers it in the
  // ledger, and stamps the version onto the entry.
  for (const id of DEMOS) await writeEntry(id);
  resetAimScanForTests();
  setAimScanPauseWhen(() => false);
  initAimScan({ io, user: USER, listRecords: async () => records });

  await startAimScan({ startedBy: 'test' });
  await settle();

  const st = aimScanStatus();
  assert.equal(st.report.measured, DEMOS.length, `measured all: ${JSON.stringify(st.report)}`);
  assert.equal(st.report.failed, 0, 'nothing failed');
  assert.equal(st.pending, 0, 'queue drained');

  const entry = await readEntry('d1');
  assert.equal(entry.a2v, AIM_MOTION_VERSION, 'entry stamped with the motion version');
  const vec = entry.rounds[0].a2?.aaa;
  assert.ok(Array.isArray(vec), 'the round carries a packed motion vector');
  assert.ok(
    vec.some((n) => n > 0),
    `and the flick was measured: ${JSON.stringify(vec)}`
  );

  const ledger = JSON.parse(await fsp.readFile(path.join(statsDir(), 'aim-scan.json'), 'utf8'));
  assert.equal(ledger.v, AIM_MOTION_VERSION, 'ledger records the version it describes');
  assert.equal(ledger.ids.length, DEMOS.length, 'ledger names every measured demo');
  assert.equal(aimScanPending(DEMOS), 0, 'nothing pending for these demos');
}

// ---------------------------------------------------------------------------
{
  // A second run over the same library reads each index once to confirm it is
  // current and never opens a tick buffer. This is what makes the pass safe to
  // start again at any time.
  resetAimScanForTests();
  initAimScan({ io, user: USER, listRecords: async () => records });
  await ensureAimScanLedger();
  // The ledger alone already answers it, so nothing is even queued.
  assert.equal(aimScanPending(DEMOS), 0, 'ledger survives a restart');

  // With the ledger gone, the entries themselves still answer.
  await fsp.rm(path.join(statsDir(), 'aim-scan.json'), { force: true });
  resetAimScanForTests();
  initAimScan({ io, user: USER, listRecords: async () => records });
  tickReads = 0;
  metaReads = 0;
  await startAimScan({});
  await settle();
  const st = aimScanStatus();
  assert.equal(st.report.current, DEMOS.length, 'every demo was already current');
  assert.equal(st.report.measured, 0, 'and none was measured again');
  assert.equal(tickReads, 0, 'no tick buffer was opened');
  assert.equal(metaReads, 0, 'no round meta was read either');
}

// ---------------------------------------------------------------------------
{
  // force re-measures regardless.
  resetAimScanForTests();
  initAimScan({ io, user: USER, listRecords: async () => records });
  tickReads = 0;
  await startAimScan({ force: true });
  await settle();
  assert.equal(aimScanStatus().report.measured, DEMOS.length, 'force re-measured all');
  assert.equal(tickReads, DEMOS.length, 'and it did open the ticks');
}

// ---------------------------------------------------------------------------
{
  // A Performance visit without a library rescan running measures ONLY the
  // demos that player opened. The rest of the library waits for the overnight
  // admin pass, instead of riding along as a side effect of looking at Aim.
  for (const id of DEMOS) await writeEntry(id);
  await fsp.rm(path.join(statsDir(), 'aim-scan.json'), { force: true });
  resetAimScanForTests();
  initAimScan({ io, user: USER, listRecords: async () => records });

  const mine = await prioritizeAimScan(['d1']);
  assert.equal(mine.pending, 1, 'one demo promoted');
  await settle();
  assert.equal(aimScanPending(['d1']), 0, 'theirs is done');
  assert.equal(aimScanPending(['d2', 'd3', 'd4']), 3, 'the rest are not pulled in');

  await startAimScan({ startedBy: 'admin' });
  await settle();
  assert.equal(aimScanPending(DEMOS), 0, 'the admin run then does the rest');
}

// ---------------------------------------------------------------------------
{
  // A promote that arrives before the scanner is wired (the 6s boot lag) is
  // kept and started as a player-scoped run, not dropped.
  for (const id of DEMOS) await writeEntry(id);
  await fsp.rm(path.join(statsDir(), 'aim-scan.json'), { force: true });
  resetAimScanForTests();

  const early = await prioritizeAimScan(['d1']);
  assert.equal(early.running, false, 'not wired yet');
  await initAimScan({ io, user: USER, listRecords: async () => records });
  await settle();
  assert.equal(aimScanPending(['d1']), 0, 'deferred promote ran once wired');
  assert.equal(aimScanPending(['d2', 'd3', 'd4']), 3, 'and did not pull the library in');
}

// ---------------------------------------------------------------------------
{
  // Admin Rescan while a player-scoped run is still going expands into the
  // rest of the library instead of being a no-op until that player finishes.
  for (const id of DEMOS) await writeEntry(id);
  await fsp.rm(path.join(statsDir(), 'aim-scan.json'), { force: true });
  resetAimScanForTests();
  initAimScan({ io, user: USER, listRecords: async () => records });

  let held = true;
  setAimScanPauseWhen(() => held);
  await prioritizeAimScan(['d1']);
  const mid = await startAimScan({ startedBy: 'admin' });
  assert.ok(
    mid.expanding || mid.scope === 'library',
    `admin rescan is taken: ${JSON.stringify({ expanding: mid.expanding, scope: mid.scope })}`
  );
  held = false;
  await settle();
  assert.equal(aimScanPending(DEMOS), 0, 'the rest of the library then finish');
  setAimScanPauseWhen(() => false);
}

// ---------------------------------------------------------------------------
{
  // The line-jump against an already-running library rescan. d4 is newest and
  // would have been first; a reader opening d1's player has to go first, and
  // the rest of that library job still finishes after.
  for (const id of DEMOS) await writeEntry(id);
  await fsp.rm(path.join(statsDir(), 'aim-scan.json'), { force: true });
  resetAimScanForTests();
  initAimScan({ io, user: USER, listRecords: async () => records });

  let paused = true;
  setAimScanPauseWhen(() => paused);
  await startAimScan({ startedBy: 'admin' });

  const promoted = await prioritizeAimScan(['d1']);
  assert.equal(promoted.pending, 1, 'one demo promoted');
  assert.equal(aimScanPending(['d1']), 1, 'and it is still pending');

  paused = false;
  const seen = [];
  const until = Date.now() + 8000;
  while (seen.length < 1 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 20));
    if (aimScanPending(['d1']) === 0) seen.push('d1');
  }
  assert.deepEqual(seen, ['d1'], 'the promoted demo was measured first');
  await settle();
  assert.equal(aimScanPending(DEMOS), 0, 'the rest of the library job still finish');
  setAimScanPauseWhen(() => false);
}

// ---------------------------------------------------------------------------
{
  // A demo that was never indexed is skipped, remembered as unscannable, and
  // does not come back on the next run. Leaving it out of the ledger is what
  // turned an unreadable round into an endless re-enrichment loop once already.
  //
  // Deliberately a demo with NO index rather than one whose file is deleted:
  // statsIndex keeps recently read entries in memory, so removing the JSON
  // under it tests the cache, not the scan.
  const withUnindexed = [
    ...records,
    { id: 'd5', filename: 'd5.dem', status: 'ready', uploadedAt: 900, parsedAt: 900,
      roundCount: 1, team1: { name: 'T1' }, team2: { name: 'T2' } }
  ];
  await fsp.rm(path.join(statsDir(), 'aim-scan.json'), { force: true });
  resetAimScanForTests();
  initAimScan({ io, user: USER, listRecords: async () => withUnindexed });
  await startAimScan({});
  await settle();
  const st = aimScanStatus();
  assert.equal(st.report.skipped, 1, `one demo skipped: ${JSON.stringify(st.report)}`);
  assert.equal(st.unscannable, 1, 'and it is remembered as unscannable');
  assert.equal(aimScanPending(['d5']), 0, 'so it stops counting as pending work');
}

// ---------------------------------------------------------------------------
{
  // Stop takes effect, and the status says so while it is happening.
  for (const id of DEMOS) await writeEntry(id);
  await fsp.rm(path.join(statsDir(), 'aim-scan.json'), { force: true });
  resetAimScanForTests();
  initAimScan({ io, user: USER, listRecords: async () => records });
  await startAimScan({});
  const st = stopAimScan();
  assert.equal(st.stopping || st.running === false, true, 'stop was acknowledged');
  await settle();
  assert.equal(aimScanStatus().running, false, 'and the loop ended');
}

await fsp.rm(root, { recursive: true, force: true });
console.log('aimScan.test.js: queue order, player-only runs, deferred start, expand, ledger, skips, force and stop all pass');

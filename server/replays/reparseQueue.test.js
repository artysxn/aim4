// Run: node server/replays/reparseQueue.test.js
//
// Guards the parts of the 3D upgrade path that are expensive to get wrong
// once, and catastrophic to get wrong 4200 times:
//
//   the duck nibble shares a byte with `side`, so a mistake there corrupts
//     which team a player was on in every round ever stored
//   old rounds must keep reading exactly as they did, because the whole
//     library is old rounds until the queue drains
//   an upgrade is only offered when something can actually fetch the demo;
//     a handle read from the wrong ledger row would queue work that can
//     never finish

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  writeRecord,
  readRecord,
  writeHeader,
  totalBytes,
  HEADER_BYTES,
  SIDE_T,
  SIDE_CT,
  DUCK_MAX,
  FLAG_ALIVE,
  FLAG_DUCKING,
  FLAG_AIRBORNE
} from '../../src/replays/shared/tickFormat.js';
import { hltvHandleFor } from './reparseQueue.js';
import { cs3dMapByCode } from '../cs3d/availability.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

function buffer(rows = 4) {
  const buf = new ArrayBuffer(totalBytes(rows));
  const view = new DataView(buf);
  writeHeader(view, { tickCount: rows, firstTick: 0, stride: 1, tickRate: 64, playerCount: 10 });
  return view;
}

// ---- the duck nibble shares a byte with side ------------------------------
{
  const view = buffer();
  // Every duck level against both sides, because the failure mode is one
  // leaking into the other.
  for (let level = 0; level <= DUCK_MAX; level++) {
    const amount = level / DUCK_MAX;
    for (const side of ['T', 'CT']) {
      writeRecord(view, 0, 0, {
        x: 100.25, y: -50.5, z: 12.75,
        yaw: 90, pitch: -10, health: 100, armor: 50, weapon: 3,
        flags: FLAG_ALIVE, flash: 0, side, duckAmount: amount
      });
      const r = readRecord(view, 0, 0);
      assert(r.side === side, `side survives duck ${level}: got ${r.side}`);
      assert(r.teamNum === (side === 'T' ? SIDE_T : SIDE_CT), `teamNum clean at duck ${level}`);
      close(r.duckAmount, amount, 1 / DUCK_MAX / 2, `duck ${level} round-trips`);
      // The rest of the record must not have moved.
      close(r.x, 100.25, 1e-6, 'x intact');
      close(r.z, 12.75, 1e-6, 'z intact');
      assert(r.health === 100 && r.armor === 50 && r.weapon === 3, 'other fields intact');
    }
  }
}

// ---- out-of-range duck is clamped, never wrapped --------------------------
{
  const view = buffer();
  for (const [amount, want] of [[-1, 0], [0, 0], [1, 1], [2, 1], [NaN, 0]]) {
    writeRecord(view, 0, 1, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, health: 1, flags: FLAG_ALIVE, side: 'CT', duckAmount: amount });
    const r = readRecord(view, 0, 1);
    close(r.duckAmount, want, 1e-6, `duck ${amount} clamps to ${want}`);
    // A wrap would corrupt side; that is the bug this exists to catch.
    assert(r.side === 'CT', `side survives duck ${amount}`);
  }
}

// ---- rounds written before the nibble existed still read the same ---------
{
  const view = buffer();
  // No duckAmount at all: what every revision 1-2 writer passed.
  writeRecord(view, 0, 2, {
    x: 5, y: 5, z: 5, yaw: 0, pitch: 0, health: 100, armor: 0, weapon: 1,
    flags: FLAG_ALIVE, flash: 0, side: 'T'
  });
  const r = readRecord(view, 0, 2);
  assert(r.duckAmount === 0, 'absent duck reads as standing');
  assert(r.side === 'T', 'side unchanged');
  assert((r.flags & FLAG_DUCKING) === 0 && (r.flags & FLAG_AIRBORNE) === 0, 'no movement flags invented');
}

// ---- movement flags coexist with the nibble -------------------------------
{
  const view = buffer();
  writeRecord(view, 0, 3, {
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, health: 100, weapon: 0,
    flags: FLAG_ALIVE | FLAG_DUCKING | FLAG_AIRBORNE, flash: 0, side: 'CT', duckAmount: 1
  });
  const r = readRecord(view, 0, 3);
  assert((r.flags & FLAG_DUCKING) !== 0, 'ducking flag set');
  assert((r.flags & FLAG_AIRBORNE) !== 0, 'airborne flag set');
  close(r.duckAmount, 1, 1e-6, 'full duck');
  assert(r.side === 'CT', 'side still clean');
}

// ---- a handle is only offered when something can fetch it ------------------
{
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-ledger-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  await fsp.writeFile(
    ledgerPath,
    JSON.stringify({
      matches: [
        { matchId: '110092', source: 'hltv', hltvDemoId: 110092, matchUrl: 'https://www.hltv.org/download/demo/110092', demoIds: ['aaa', 'bbb'] },
        // An HLTV row that predates the explicit field: the key is the id.
        { matchId: '110093', source: 'hltv', demoIds: ['ccc'] },
        // A local import: real row, but nothing to re-download.
        { matchId: 'upload-x', source: 'local', demoIds: ['ddd'] }
      ]
    })
  );

  const a = await hltvHandleFor('aaa', { ledgerPath });
  assert(a?.hltvDemoId === 110092, 'finds the HLTV id for a demo in the row');
  assert(a.matchUrl.endsWith('/110092'), 'carries the download url');

  const b = await hltvHandleFor('bbb', { ledgerPath });
  assert(b?.hltvDemoId === 110092, 'a series archive maps every demo it produced');

  const c = await hltvHandleFor('ccc', { ledgerPath });
  assert(c?.hltvDemoId === 110093, 'falls back to the row key for older rows');

  const d = await hltvHandleFor('ddd', { ledgerPath });
  assert(d === null, 'a local import offers no handle');

  const missing = await hltvHandleFor('not-in-ledger', { ledgerPath });
  assert(missing === null, 'an unknown demo offers no handle');

  const noLedger = await hltvHandleFor('aaa', { ledgerPath: path.join(dir, 'nope.json') });
  assert(noLedger === null, 'a missing ledger is not an error, just no handle');

  await fsp.rm(dir, { recursive: true, force: true });
}

// ---- map gating ------------------------------------------------------------
{
  assert(cs3dMapByCode('NUK')?.slug === 'nuke', 'NUK resolves to nuke');
  assert(cs3dMapByCode('nuk')?.slug === 'nuke', 'code match is case-insensitive');
  assert(cs3dMapByCode('') === null, 'empty code resolves to nothing');
  assert(cs3dMapByCode('ZZZ') === null, 'unknown code resolves to nothing');
}

console.log('reparseQueue.test: ok');

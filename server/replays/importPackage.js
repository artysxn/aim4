// ---------------------------------------------------------------------------
// replays/importPackage.js
// Accept a locally-parsed .aim4replay package and land it in the library
// with the same round filenames the server-side ingest would have produced.
//
// Packages may carry either the plain v1 pair (.json + .bin) or the compact
// library form (.json.zst + .tickz + optional .c100.bin). Both land as the
// compact on-disk shape via writeMaterialized.
// ---------------------------------------------------------------------------

import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { decodeReplayPackage } from '../../src/replays/shared/replayPackage.js';

const zstdDecompress = promisify(zlib.zstdDecompress);
import { isRoundId, parseRoundId } from '../../src/replays/shared/roundId.js';
import { checkQuota, readRecord, writeMaterialized } from './demoStore.js';
import { TICKZ_EXT } from './tickCodec.js';
import { applyStandingsToRecord } from './teamStandingsDb.js';
import { applyLibraryTeamNamesToRecord } from './lineupNames.js';
import { scheduleImportIndex } from './autoIndex.js';
import { discardDuplicateUpload } from './dupeScan.js';

/**
 * @param {string} user
 * @param {Uint8Array|Buffer|ArrayBuffer} buf
 * @param {object} [meta]
 */
export async function importReplayPackage(user, buf, meta = {}) {
  const { files } = decodeReplayPackage(buf);
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new Error('Package is missing manifest.json.');

  let record;
  try {
    record = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error('Package manifest is not valid JSON.');
  }

  const demoId = String(record.id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!demoId) throw new Error('Package manifest has no demo id.');

  if (await readRecord(user, demoId)) {
    throw new Error('A replay with this id is already in the library.');
  }

  const rounds = Array.isArray(record.rounds) ? record.rounds : [];
  if (!rounds.length) throw new Error('Package has no rounds.');

  let payloadBytes = 0;
  for (const [, data] of files) payloadBytes += data.byteLength;

  const gate = await checkQuota(user, payloadBytes);
  if (!gate.ok) {
    const err = new Error(gate.error);
    err.status = 413;
    err.usage = gate.usage;
    throw err;
  }

  for (const r of rounds) {
    if (!r?.file || !r?.id) throw new Error('Package round entry is incomplete.');
    if (!isRoundId(r.id) || !parseRoundId(r.id)) {
      throw new Error(`Invalid round id in package: ${r.id}`);
    }
    if (!String(r.file).endsWith(`~${demoId}`)) {
      throw new Error(`Round file stem does not match demo id: ${r.file}`);
    }

    const plainJson = `rounds/${r.file}.json`;
    const zstJson = `rounds/${r.file}.json.zst`;
    const plainBin = `rounds/${r.file}.bin`;
    const tickz = `rounds/${r.file}${TICKZ_EXT}`;
    const hasPlain = files.has(plainJson) && files.has(plainBin);
    const hasCompact = files.has(zstJson) && files.has(tickz);
    if (!hasPlain && !hasCompact) {
      throw new Error(`Package is missing files for round ${r.id}.`);
    }

    let metaJson;
    try {
      if (hasCompact) {
        // Threadpool, not sync: imports run on the request path and a package
        // holds a whole match of round metas.
        const raw = await zstdDecompress(Buffer.from(files.get(zstJson)));
        metaJson = JSON.parse(raw.toString('utf8'));
      } else {
        metaJson = JSON.parse(new TextDecoder().decode(files.get(plainJson)));
      }
    } catch {
      throw new Error(`Corrupt round JSON: ${r.file}`);
    }
    if (metaJson.id !== r.id || metaJson.demoId !== demoId) {
      throw new Error(`Round JSON does not match manifest for ${r.id}.`);
    }

    const tickBytes = hasCompact ? files.get(tickz) : files.get(plainBin);
    if (!tickBytes?.byteLength) {
      throw new Error(`Empty tick buffer for ${r.id}.`);
    }
  }

  const ready = {
    ...record,
    id: demoId,
    status: 'ready',
    filename: meta.filename || record.filename || `${demoId}.aim4replay`,
    sizeBytes: payloadBytes,
    uploadedAt: meta.uploadedAt || Date.now(),
    parsedAt: record.parsedAt || Date.now(),
    source: 'import',
    error: null,
    roundCount: rounds.length,
    rounds,
    // Ownership comes from the caller, never from the package. The manifest is
    // a file the uploader controls: falling back to `record.uploaderId` meant a
    // package could name any account as its owner, and the demo landed on that
    // account, counted against that account's cap, and answered to that
    // account's Delete button. Every package is imported as whoever uploaded
    // it, and an anonymous import owns nothing.
    uploaderId: meta.uploaderId || '',
    uploaderName: meta.uploaderName || '',
    visibility: meta.visibility || record.visibility || 'private'
  };

  // Local packages often still carry clan/player fallbacks — stamp standings
  // names onto the manifest + plain round JSON before they hit the library.
  applyStandingsToRecord(ready, files);
  // A team the VRS tables have never heard of can still be one the library
  // named already; four of five shared players is the same squad. Names only:
  // the package's round ids were baked on the user's PC.
  await applyLibraryTeamNamesToRecord(user, ready, files);

  await writeMaterialized(user, ready, files);

  // Packages skip the parse worker, so this is the first moment identity exists.
  const dup = await discardDuplicateUpload(user, ready, { filename: ready.filename });
  if (dup) {
    const err = new Error(dup.message);
    err.status = 409;
    err.duplicate = true;
    throw err;
  }

  // The demo counts toward the database from now, not from whenever a visitor
  // next makes the stats page pay for every pending index at once.
  scheduleImportIndex(user, ready);
  return ready;
}

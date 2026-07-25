// ---------------------------------------------------------------------------
// replays/importPackage.js
// Accept a locally-parsed .aim4replay package and land it in the library
// with the same round filenames the server-side ingest would have produced.
// ---------------------------------------------------------------------------

import { decodeReplayPackage } from '../../src/replays/shared/replayPackage.js';
import { isRoundId, parseRoundId } from '../../src/replays/shared/roundId.js';
import { checkQuota, readRecord, writeMaterialized } from './demoStore.js';

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
    const jsonName = `rounds/${r.file}.json`;
    const binName = `rounds/${r.file}.bin`;
    if (!files.has(jsonName) || !files.has(binName)) {
      throw new Error(`Package is missing files for round ${r.id}.`);
    }
    let metaJson;
    try {
      metaJson = JSON.parse(new TextDecoder().decode(files.get(jsonName)));
    } catch {
      throw new Error(`Corrupt round JSON: ${r.file}`);
    }
    if (metaJson.id !== r.id || metaJson.demoId !== demoId) {
      throw new Error(`Round JSON does not match manifest for ${r.id}.`);
    }
    if (!files.get(binName)?.byteLength) {
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
    rounds
  };

  await writeMaterialized(user, ready, files);
  return ready;
}

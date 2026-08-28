// ---------------------------------------------------------------------------
// replays/commsStore.js — recorded TeamSpeak comms, attached to a demo
//
// One demo gets at most one comms file. It arrives from the desktop recorder
// as a finished .aim4comms container (see shared/comms/format.js): transcript
// plus low-bitrate per-speaker voice, around 2 MB.
//
// Layout under a library folder:
//
//   comms/<demoId>.aim4comms   the container, stored exactly as uploaded
//   comms/<demoId>.json        sidecar: mapping, sync, and a summary
//   comms/identities.json      TeamSpeak UID -> roster player, library-wide
//
// The sidecar exists so the library listing and the viewer's mic button can
// answer "does this demo have comms, and are its speakers mapped?" without
// gunzipping a 2 MB file. It is derived data: everything in it can be rebuilt
// from the container, so a lost sidecar costs a re-attach and nothing more.
//
// The container is stored byte-for-byte rather than re-packed. It is already
// compressed, the recorder chose its bitrate against a size budget, and
// keeping the original is what lets a transcript be re-derived later from the
// audio the user actually shipped.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';

import { decodeComms, MAX_FILE_BYTES } from '../../shared/comms/format.js';
// commsDir lives with the other library folders so the storage meter can size
// this directory without importing this module and forming a cycle.
import { commsDir } from './demoStore.js';

function sanitizeId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!s) throw new Error('Invalid id');
  return s;
}

const filePath = (user, demoId) => path.join(commsDir(user), `${sanitizeId(demoId)}.aim4comms`);
const metaPath = (user, demoId) => path.join(commsDir(user), `${sanitizeId(demoId)}.json`);
const identitiesPath = (user) => path.join(commsDir(user), 'identities.json');

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Validate an uploaded container and store it against a demo.
 *
 * The upload is parsed before it is written: a file that cannot be decoded is
 * refused here rather than discovered by the viewer later, and the parse is
 * also where the sidecar summary comes from.
 *
 * @param {string} user
 * @param {string} demoId
 * @param {Uint8Array|Buffer} bytes
 * @param {{ uploadedBy?: string, filename?: string }} [ctx]
 */
export async function saveComms(user, demoId, bytes, ctx = {}) {
  const id = sanitizeId(demoId);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buf.byteLength) throw new Error('Comms file is empty.');
  if (buf.byteLength > MAX_FILE_BYTES) throw new Error('Comms file is too large.');

  // Throws with a readable message on anything that is not a comms file.
  const { manifest } = await decodeComms(new Uint8Array(buf));

  await fsp.mkdir(commsDir(user), { recursive: true });
  await fsp.writeFile(filePath(user, id), buf);

  const previous = await readComms(user, id);
  const meta = {
    demoId: id,
    name: manifest.name,
    filename: String(ctx.filename || '').slice(0, 120),
    uploadedAt: Date.now(),
    uploadedBy: ctx.uploadedBy || null,
    sizeBytes: buf.byteLength,
    lang: manifest.lang,
    model: manifest.model,
    durationMs: manifest.durationMs,
    hasAudio: Boolean(manifest.audio),
    sync: manifest.sync,
    speakers: manifest.speakers.map((s) => ({
      uid: s.uid,
      nickname: s.nickname,
      talkMs: s.talkMs
    })),
    utteranceCount: manifest.utterances.length,
    // Re-attaching the same session should not throw away a mapping the user
    // already made, so a replaced file keeps whatever still applies.
    mapping: previous?.mapping || {},
    offsetMs: previous?.offsetMs || 0,
    anchorTick: previous?.anchorTick ?? null
  };
  await fsp.writeFile(metaPath(user, id), JSON.stringify(meta, null, 2));
  return meta;
}

/** The sidecar for one demo, or null when nothing is attached. */
export async function readComms(user, demoId) {
  return readJson(metaPath(user, sanitizeId(demoId)));
}

/** The raw container bytes, or null. */
export async function readCommsFile(user, demoId) {
  try {
    return await fsp.readFile(filePath(user, sanitizeId(demoId)));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Save the speaker mapping, the resolved anchor, and any manual nudge.
 *
 * `mapping` is keyed by TeamSpeak UID rather than by speaker index: indexes
 * are a property of one file, but a UID is the same person next week, which is
 * what makes the library-wide memory below possible.
 *
 * @param {string} user
 * @param {string} demoId
 * @param {{ mapping?: Record<string,string>, offsetMs?: number, anchorTick?: number|null }} patch
 */
export async function updateCommsAttachment(user, demoId, patch = {}) {
  const id = sanitizeId(demoId);
  const meta = await readComms(user, id);
  if (!meta) return null;

  if (patch.mapping && typeof patch.mapping === 'object') {
    const known = new Set(meta.speakers.map((s) => s.uid));
    const clean = {};
    for (const [uid, playerId] of Object.entries(patch.mapping)) {
      if (!known.has(uid)) continue;
      const pid = String(playerId || '').slice(0, 64);
      if (pid) clean[uid] = pid;
    }
    meta.mapping = clean;
    await rememberIdentities(user, meta.speakers, clean);
  }
  if (Number.isFinite(patch.offsetMs)) {
    // A nudge is a trim, not a re-sync; a minute of it means the anchor is
    // wrong and the user should pick a different countdown instead.
    meta.offsetMs = Math.max(-60000, Math.min(60000, Math.round(patch.offsetMs)));
  }
  if (patch.anchorTick === null || Number.isFinite(patch.anchorTick)) {
    meta.anchorTick = patch.anchorTick === null ? null : Math.round(patch.anchorTick);
  }
  if (Number.isFinite(patch.anchorMs)) {
    meta.sync = { ...meta.sync, anchorMs: Math.max(0, Math.round(patch.anchorMs)) };
  }
  meta.updatedAt = Date.now();
  await fsp.mkdir(commsDir(user), { recursive: true });
  await fsp.writeFile(metaPath(user, id), JSON.stringify(meta, null, 2));
  return meta;
}

export async function deleteComms(user, demoId) {
  const id = sanitizeId(demoId);
  await fsp.rm(filePath(user, id), { force: true });
  await fsp.rm(metaPath(user, id), { force: true });
  return true;
}

// ---- library-wide identity memory ------------------------------------------

/** Cap: a library sees a few dozen distinct voices, not thousands. */
const MAX_IDENTITIES = 500;

/**
 * Remember which roster player a TeamSpeak UID turned out to be.
 *
 * This is what makes the second attach a no-op: the same five people scrim
 * every week under the same identities, so the dialog can pre-fill and the
 * user only confirms.
 */
async function rememberIdentities(user, speakers, mapping) {
  const store = (await readJson(identitiesPath(user))) || {};
  const now = Date.now();
  for (const s of speakers) {
    const playerId = mapping[s.uid];
    if (!playerId) continue;
    store[s.uid] = { playerId, nickname: s.nickname, lastSeen: now };
  }
  const entries = Object.entries(store)
    .sort((a, b) => (b[1]?.lastSeen || 0) - (a[1]?.lastSeen || 0))
    .slice(0, MAX_IDENTITIES);
  await fsp.mkdir(commsDir(user), { recursive: true });
  await fsp.writeFile(identitiesPath(user), JSON.stringify(Object.fromEntries(entries), null, 2));
}

/** Remembered UID -> player mappings, for pre-filling the attach dialog. */
export async function readIdentities(user) {
  return (await readJson(identitiesPath(user))) || {};
}

/**
 * Set (or clear, with an empty playerId) one UID -> player link directly.
 *
 * The attach dialog writes identities as a side effect of mapping one demo;
 * the team Communication page edits the library-wide memory itself, so a
 * link made there applies to every past and future session at once.
 */
export async function setIdentity(user, uid, { playerId = '', nickname = '' } = {}) {
  const key = String(uid ?? '').slice(0, 80);
  if (!key) throw new Error('Missing TeamSpeak uid.');
  const store = (await readJson(identitiesPath(user))) || {};
  const pid = String(playerId || '').slice(0, 64);
  if (!pid) {
    delete store[key];
  } else {
    store[key] = {
      playerId: pid,
      nickname: String(nickname || store[key]?.nickname || '').slice(0, 80),
      lastSeen: Date.now()
    };
  }
  await fsp.mkdir(commsDir(user), { recursive: true });
  await fsp.writeFile(identitiesPath(user), JSON.stringify(store, null, 2));
  return store;
}

// ---------------------------------------------------------------------------
// server/sim/export.js
// Package library demos as .aim4replay files, for building a training sample.
//
// The demo library lives on the server and is about 10 GB; the trainer lives
// wherever it lives. Shipping the whole corpus back and forth is exactly what
// SIM-PLAN 9.2c forbids, so the workflow is selection: list what exists with
// enough metadata to choose by (map, teams, rounds, size), then download
// the selection as one zip of .aim4replay packages. The package format is
// the site's own (.aim4replay v2), so anything that can import a local parse
//
// Admin-only by the same guard as everything under /api/sim, and read-only by
// construction: nothing here writes to the library, ever.
//
// I/O is injected so the packaging logic is testable against a fixture
// directory rather than against a real 10 GB library.
//
// Listing walks every library folder under the replay root, not only
// SHARED_LIBRARY. Production often keeps demos under a former per-account
// folder (AIM4_REPLAY_LIBRARY) or a sibling user key; a listing that only
// asked `local` showed an empty Export tab while Database still had the
// corpus. Round files whose `~demoId` suffix has no json record still appear,
// because the files are the sample.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';

import { encodeReplayPackage, PACKAGE_EXT } from '../../src/replays/shared/replayPackage.js';
import { ROOT, listDemos, listLibraryUsers, userKey } from '../replays/demoStore.js';
import { SHARED_LIBRARY } from '../replays/auth.js';

function libraryDirs(user) {
  const key = userKey(user);
  return {
    user: key,
    listDemos: () => listDemos(key),
    demosDir: () => path.join(ROOT, key, 'demos'),
    roundsDir: () => path.join(ROOT, key, 'rounds')
  };
}

/** The real I/O, replaced wholesale in tests. */
export const defaultIo = {
  listDemos: () => listDemos(SHARED_LIBRARY),
  demosDir: () => path.join(ROOT, userKey(SHARED_LIBRARY), 'demos'),
  roundsDir: () => path.join(ROOT, userKey(SHARED_LIBRARY), 'rounds'),
  listLibraries: async () => {
    let users = [];
    try {
      users = await listLibraryUsers();
    } catch {
      users = [];
    }
    const keys = [];
    const seen = new Set();
    for (const u of [SHARED_LIBRARY, ...users]) {
      const key = userKey(u);
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    return keys.map(libraryDirs);
  },
  readFile: (p) => fsp.readFile(p),
  listFiles: async (dir) => {
    try {
      return await fsp.readdir(dir);
    } catch {
      return [];
    }
  },
  stat: async (p) => {
    try {
      return await fsp.stat(p);
    } catch {
      return null;
    }
  }
};

const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '');

function callMaybe(fnOrVal) {
  return typeof fnOrVal === 'function' ? fnOrVal() : fnOrVal;
}

/**
 * One library to scan. Tests that omit listLibraries keep the old single-dir
 * contract; production supplies every folder under the replay root.
 */
async function librariesOf(io) {
  if (typeof io.listLibraries === 'function') {
    const libs = await io.listLibraries();
    if (libs?.length) return libs;
  }
  return [
    {
      listDemos: () => io.listDemos(),
      demosDir: io.demosDir,
      roundsDir: io.roundsDir
    }
  ];
}

function teamNames(r) {
  const name = (t) => {
    if (!t) return null;
    if (typeof t === 'string') return t;
    return t.name || null;
  };
  return [name(r.team1), name(r.team2)].filter(Boolean);
}

/** Round files are `<roundId>~<demoId>.<ext>`. */
export function demoIdFromRoundFile(f) {
  const at = String(f).indexOf('~');
  if (at < 0) return '';
  const rest = String(f).slice(at + 1);
  const dot = rest.indexOf('.');
  return safeId(dot < 0 ? rest : rest.slice(0, dot));
}

function rowFromRecord(r, files, bytes) {
  const id = safeId(r.id || r.demoId);
  return {
    id,
    filename: r.filename || `${id}${PACKAGE_EXT}`,
    map: r.map || r.mapCode || null,
    teams: teamNames(r),
    score: r.score ? [r.score.team1 ?? 0, r.score.team2 ?? 0] : null,
    rounds: r.roundCount ?? r.rounds ?? (files.length ? Math.round(files.length / 3) : null),
    uploadedAt: r.uploadedAt || null,
    files: files.length,
    bytes,
    library: r._library || null
  };
}

/**
 * What can be exported, with enough metadata to select a sample by.
 *
 * @returns {Promise<Array<{id, filename, map, teams, rounds, uploadedAt, bytes}>>}
 */
export async function listExportableDemos(io = defaultIo) {
  const libs = await librariesOf(io);
  const byId = new Map();

  for (const lib of libs) {
    let records = [];
    try {
      records = (await lib.listDemos()) || [];
    } catch {
      records = [];
    }
    const roundsDir = callMaybe(lib.roundsDir);
    const roundFiles = await io.listFiles(roundsDir);
    const filesByDemo = new Map();
    for (const f of roundFiles) {
      const demoId = demoIdFromRoundFile(f);
      if (!demoId) continue;
      if (!filesByDemo.has(demoId)) filesByDemo.set(demoId, []);
      filesByDemo.get(demoId).push(f);
    }

    const seen = new Set();
    for (const r of records) {
      const id = safeId(r.id || r.demoId);
      if (!id) continue;
      seen.add(id);
      const files = filesByDemo.get(id) || [];
      let bytes = 0;
      for (const f of files) {
        const st = await io.stat(path.join(roundsDir, f));
        if (st) bytes += st.size;
      }
      const prev = byId.get(id);
      if (prev && prev.files >= files.length) continue;
      byId.set(
        id,
        rowFromRecord({ ...r, _library: lib.user || r._library || null }, files, bytes)
      );
    }

    // Round files with no json record still belong in a selection UI. The
    // Database page can show a demo the Export tab used to skip because
    // listDemos was pointed at an empty folder.
    for (const [id, files] of filesByDemo) {
      if (seen.has(id) || byId.has(id)) continue;
      let bytes = 0;
      for (const f of files) {
        const st = await io.stat(path.join(roundsDir, f));
        if (st) bytes += st.size;
      }
      byId.set(id, {
        id,
        filename: `${id}${PACKAGE_EXT}`,
        map: null,
        teams: [],
        score: null,
        rounds: files.length ? Math.round(files.length / 3) : null,
        uploadedAt: null,
        files: files.length,
        bytes,
        library: lib.user || null
      });
    }
  }

  return [...byId.values()];
}

async function readManifest(io, lib, id) {
  const dir = callMaybe(lib.demosDir);
  try {
    return await io.readFile(path.join(dir, `${id}.json`));
  } catch {
    return null;
  }
}

/**
 * Build the .aim4replay package for one demo: its record as manifest.json plus
 * every round file that belongs to it, exactly the layout the importer reads.
 *
 * @returns {Promise<{filename: string, bytes: Uint8Array}|null>} null if unknown
 */
export async function packageDemo(demoId, io = defaultIo) {
  const id = safeId(demoId);
  if (!id) return null;

  const libs = await librariesOf(io);
  let manifest = null;
  let roundsDir = null;
  let roundFiles = [];

  for (const lib of libs) {
    const hit = await readManifest(io, lib, id);
    const dir = callMaybe(lib.roundsDir);
    const files = (await io.listFiles(dir)).filter((f) => f.includes(`~${id}.`));
    if (hit) {
      manifest = hit;
      roundsDir = dir;
      roundFiles = files;
      break;
    }
    if (!manifest && files.length) {
      roundsDir = dir;
      roundFiles = files;
    }
  }

  if (!manifest && !roundFiles.length) return null;
  if (!manifest) {
    manifest = new TextEncoder().encode(JSON.stringify({ id, filename: `${id}${PACKAGE_EXT}` }));
  }

  const entries = [['manifest.json', manifest]];
  for (const f of roundFiles) {
    entries.push([`rounds/${f}`, await io.readFile(path.join(roundsDir, f))]);
  }

  return {
    filename: `${id}${PACKAGE_EXT}`,
    bytes: encodeReplayPackage(entries)
  };
}

/** Uncompressed zip of named files. One HTTP body, N .aim4replay entries. */
function zipStore(files) {
  const chunks = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const nameBuf = Buffer.from(String(name).replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localFull = Buffer.concat([local, nameBuf, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
    chunks.push(localFull);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localFull.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, centralDir, eocd]));
}

/**
 * One download for a selection. A single id stays a .aim4replay; two or more
 * land in one .zip. The client batches at 50; this cap is the server's lid
 * so a long fetch cannot rebuild the 10 GB problem in one body.
 */
export const EXPORT_BUNDLE_MAX = 100;

export async function packageDemos(demoIds, io = defaultIo) {
  const ids = [...new Set((demoIds || []).map(safeId).filter(Boolean))].slice(0, EXPORT_BUNDLE_MAX);
  if (!ids.length) return null;
  if (ids.length === 1) return packageDemo(ids[0], io);

  const files = [];
  for (const id of ids) {
    const pkg = await packageDemo(id, io);
    if (pkg) files.push({ name: pkg.filename, bytes: pkg.bytes });
  }
  if (!files.length) return null;
  if (files.length === 1) return { filename: files[0].name, bytes: files[0].bytes };
  return {
    filename: `aim4-export-${files.length}.zip`,
    bytes: zipStore(files)
  };
}

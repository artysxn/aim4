// ---------------------------------------------------------------------------
// server/sim/export.js
// Package library demos as .aim4replay files, for building a training sample.
//
// The demo library lives on the server and is about 10 GB; the trainer lives
// wherever it lives. Shipping the whole corpus back and forth is exactly what
// SIM-PLAN 9.2c forbids, so the workflow is selection: list what exists with
// enough metadata to choose by (map, teams, rounds, size), then download the
// chosen demos one package at a time. The package format is the site's own
// (.aim4replay v2), so anything that can import a local parse can import these,
// including another aim4 instance.
//
// Admin-only by the same guard as everything under /api/sim, and read-only by
// construction: nothing here writes to the library, ever.
//
// I/O is injected so the packaging logic is testable against a fixture
// directory rather than against a real 10 GB library.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';

import { encodeReplayPackage, PACKAGE_EXT } from '../../src/replays/shared/replayPackage.js';
import { ROOT, listDemos, userKey } from '../replays/demoStore.js';
import { SHARED_LIBRARY } from '../replays/auth.js';

/** The real I/O, replaced wholesale in tests. */
export const defaultIo = {
  listDemos: () => listDemos(SHARED_LIBRARY),
  demosDir: () => path.join(ROOT, userKey(SHARED_LIBRARY), 'demos'),
  roundsDir: () => path.join(ROOT, userKey(SHARED_LIBRARY), 'rounds'),
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

/**
 * What can be exported, with enough metadata to select a sample by.
 *
 * @returns {Promise<Array<{id, filename, map, teams, rounds, uploadedAt, bytes}>>}
 */
export async function listExportableDemos(io = defaultIo) {
  const records = await io.listDemos();
  const roundFiles = await io.listFiles(io.roundsDir());

  // Size per demo: sum of its round files. One directory listing plus stats,
  // not a walk per request; the list endpoint is for a selection UI, and a
  // selection UI needs sizes or the 10 GB problem gets rediscovered by download.
  const byDemo = new Map();
  for (const f of roundFiles) {
    const at = f.indexOf('~');
    if (at < 0) continue;
    const rest = f.slice(at + 1);
    const dot = rest.indexOf('.');
    const demoId = dot < 0 ? rest : rest.slice(0, dot);
    if (!byDemo.has(demoId)) byDemo.set(demoId, []);
    byDemo.get(demoId).push(f);
  }

  const out = [];
  for (const r of records) {
    const id = safeId(r.id || r.demoId);
    if (!id) continue;
    const files = byDemo.get(id) || [];
    let bytes = 0;
    for (const f of files) {
      const st = await io.stat(path.join(io.roundsDir(), f));
      if (st) bytes += st.size;
    }
    out.push({
      id,
      filename: r.filename || `${id}${PACKAGE_EXT}`,
      map: r.map || r.mapCode || null,
      teams: r.teams || [r.team1, r.team2].filter(Boolean),
      rounds: r.roundCount ?? r.rounds ?? (files.length ? Math.round(files.length / 3) : null),
      uploadedAt: r.uploadedAt || null,
      files: files.length,
      bytes
    });
  }
  return out;
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

  let manifest;
  try {
    manifest = await io.readFile(path.join(io.demosDir(), `${id}.json`));
  } catch {
    return null;
  }

  const roundFiles = (await io.listFiles(io.roundsDir())).filter((f) =>
    f.includes(`~${id}.`)
  );

  const entries = [['manifest.json', manifest]];
  for (const f of roundFiles) {
    entries.push([`rounds/${f}`, await io.readFile(path.join(io.roundsDir(), f))]);
  }

  return {
    filename: `${id}${PACKAGE_EXT}`,
    bytes: encodeReplayPackage(entries)
  };
}

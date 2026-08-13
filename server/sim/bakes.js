// ---------------------------------------------------------------------------
// server/sim/bakes.js
// Load a map's baked geometry, from the repo or from a locally re-baked host.
//
// The bakes SHIP. They were under AIM4_REPLAY_DIR at first, which is gitignored,
// so a deploy landed a /sim page whose only working button said "run
// npm run sim:bake on this host". That is the wrong trade: the bakes are 9.3 MB
// of derived geometry that gzips to 1.1 MB, they change only when the map data
// or the bake code changes, and they are derived entirely from things that are
// already public (the radar PNGs in public/maps, and the painted zones the
// backend serves openly). Nothing about them is secret and nothing about them
// is per-host, so they belong in the repo like any other build input.
//
// Two sources, in order:
//
//   simdata/          committed, gzipped, ships with every deploy
//   AIM4_REPLAY_DIR/sim/   written by npm run sim:bake, wins when present
//
// The override direction matters: a host that has re-baked (a new map, a
// changed erosion rule, a fix being tested) must get its own artefact rather
// than the repo's stale one, and that is exactly when the two disagree.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ROOT as REPLAY_ROOT } from '../replays/demoStore.js';

const gunzip = promisify(zlib.gunzip);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Committed bakes, relative to the repo root. */
export const SHIPPED_DIR = path.join(__dirname, '..', '..', 'simdata');
/** Locally re-baked artefacts, which win when they exist. */
export const LOCAL_DIR = path.join(REPLAY_ROOT, 'sim');

const cache = new Map();

async function readJson(file) {
  if (file.endsWith('.gz')) {
    return JSON.parse((await gunzip(await fsp.readFile(file))).toString('utf8'));
  }
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

/**
 * @param {'navcache'|'angles'} kind
 * @param {string} map
 * @returns {Promise<{bake: object, source: 'local'|'shipped'}|null>}
 */
export async function loadBake(kind, map) {
  const key = `${kind}:${map}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const candidates = [
    { file: path.join(LOCAL_DIR, kind, `${map}.json`), source: 'local' },
    { file: path.join(SHIPPED_DIR, kind, `${map}.json.gz`), source: 'shipped' },
    { file: path.join(SHIPPED_DIR, kind, `${map}.json`), source: 'shipped' }
  ];

  for (const c of candidates) {
    try {
      const bake = await readJson(c.file);
      const out = { bake, source: c.source };
      cache.set(key, out);
      return out;
    } catch {
      /* try the next source */
    }
  }
  return null;
}

/** Which maps can actually be simulated on this host, and from where. */
export async function availableMaps() {
  const seen = new Map();
  const scan = async (dir, source) => {
    let files;
    try {
      files = await fsp.readdir(path.join(dir, 'navcache'));
    } catch {
      return;
    }
    for (const f of files) {
      const m = /^([A-Z0-9]+)\.json(\.gz)?$/.exec(f);
      if (m && !seen.has(m[1])) seen.set(m[1], source);
    }
  };
  // Local first so it reports as the winner when both exist.
  await scan(LOCAL_DIR, 'local');
  await scan(SHIPPED_DIR, 'shipped');

  const out = [];
  for (const [map, source] of seen) {
    const angles = await loadBake('angles', map);
    out.push({ map, source, angles: Boolean(angles) });
  }
  out.sort((a, b) => a.map.localeCompare(b.map));
  return out;
}

/** Tests and the bake script invalidate through here. */
export function clearBakeCache() {
  cache.clear();
}

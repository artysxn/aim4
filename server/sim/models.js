// ---------------------------------------------------------------------------
// server/sim/models.js
// The model registry: which brains this host can put on the map, and where
// each of them came from.
//
// SIM-PLAN 9.9 asks for a registry the server loads, the admin can inspect,
// and the UI can pick from per match ("Gen 12 vs Gen 8"). This is that, and it
// deliberately copies bakes.js rather than inventing a second convention,
// because a model is the same KIND of artefact as a bake: derived data, small,
// versioned, produced off-line, and useless to a deployed /sim if it only ever
// existed on the machine that trained it.
//
//   simdata/models/           committed, ships with every deploy
//   AIM4_REPLAY_DIR/sim/models/   written by the trainer, wins when present
//
// The override direction is the whole point of the training loop: artysan
// trains on the 4090, the new weights land in the local directory, and the
// next match uses them without a deploy or a restart. Shipping a model is then
// a deliberate act (copy it into simdata/models/ and commit), which is the
// correct amount of friction for a file that changes how every bot behaves.
//
// Two differences from bakes.js, both because a model can be WRONG in ways a
// bake cannot:
//
//   Entries are validated through loadPolicy at listing time, so a model
//   trained against an older observation layout shows up in the panel as
//   broken with its reason, instead of failing when a match is already running.
//
//   The cache is mtime-keyed rather than permanent. Re-training bc0 replaces a
//   file in place, and a registry that had to be restarted to notice would
//   make the local training loop feel broken.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ROOT as REPLAY_ROOT } from '../replays/demoStore.js';
import { loadPolicy } from '../../shared/sim/policy.js';

const gunzip = promisify(zlib.gunzip);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Committed models, relative to the repo root. */
export const SHIPPED_DIR = path.join(__dirname, '..', '..', 'simdata', 'models');
/** Locally trained models, which win when they exist. */
export const LOCAL_DIR = path.join(REPLAY_ROOT, 'sim', 'models');

/** The brains that are not files: the scripted baseline and the P3b arbiter. */
export const BUILTIN_BRAINS = Object.freeze(['scripted', 'desire']);

const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');

/** name -> {mtimeMs, source, file, json, policy, error} */
const cache = new Map();

async function readJson(file) {
  const bytes = await fsp.readFile(file);
  if (file.endsWith('.gz')) return JSON.parse((await gunzip(bytes)).toString('utf8'));
  return JSON.parse(bytes.toString('utf8'));
}

/** Where a model of this name would be read from, local first. */
function candidates(name) {
  return [
    { file: path.join(LOCAL_DIR, `${name}.json`), source: 'local' },
    { file: path.join(LOCAL_DIR, `${name}.json.gz`), source: 'local' },
    { file: path.join(SHIPPED_DIR, `${name}.json`), source: 'shipped' },
    { file: path.join(SHIPPED_DIR, `${name}.json.gz`), source: 'shipped' }
  ];
}

/**
 * Load a registered model, validated.
 *
 * @param {string} rawName
 * @returns {Promise<{policy: object, meta: object}|{error: string}>}
 */
export async function loadModel(rawName) {
  const name = safe(rawName);
  if (!name) return { error: 'model: no name' };

  for (const c of candidates(name)) {
    let stat;
    try {
      stat = await fsp.stat(c.file);
    } catch {
      continue; // not at this source; try the next
    }

    const hit = cache.get(name);
    if (hit && hit.file === c.file && hit.mtimeMs === stat.mtimeMs) {
      return hit.error ? { error: hit.error } : { policy: hit.policy, meta: hit.meta };
    }

    try {
      const json = await readJson(c.file);
      const policy = loadPolicy(json);
      const meta = describe(name, json, c, stat);
      cache.set(name, { file: c.file, mtimeMs: stat.mtimeMs, policy, meta });
      return { policy, meta };
    } catch (err) {
      // A file that exists and does not load is an error, not a miss: falling
      // through to the shipped copy would silently run different weights than
      // the ones the operator just installed.
      const error = `model ${name}: ${err.message}`;
      cache.set(name, { file: c.file, mtimeMs: stat.mtimeMs, error });
      return { error };
    }
  }
  return { error: `model ${name}: not on this host` };
}

/** The inspectable summary: everything the panel shows about a model. */
function describe(name, json, c, stat) {
  const layers = Array.isArray(json.layers) ? json.layers : [];
  return {
    name,
    source: c.source,
    v: json.v ?? null,
    obsVersion: json.obsVersion ?? null,
    vocab: Array.isArray(json.vocab) ? json.vocab.length : 0,
    teacher: json.teacher || null,
    dataset: json.dataset || null,
    valAccuracy: json.valAccuracy ?? null,
    embedDim: json.embed?.dim ?? 0,
    embedPlayers: json.embed?.players ? Object.keys(json.embed.players).length : 0,
    hidden: layers.slice(0, -1).map((l) => l.W?.length || 0),
    bytes: stat.size,
    trainedAt: stat.mtime.toISOString(),
    ok: true
  };
}

/**
 * Every model this host can offer, both sources, newest-looking first.
 * A model that fails to load is listed WITH its reason rather than hidden:
 * "bc0 is missing" and "bc0 was trained against observation v1" are different
 * problems and the panel should not have to guess which one it has.
 */
export async function listModels() {
  const seen = new Map();
  const scan = async (dir, source) => {
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const f of files) {
      const m = /^([A-Za-z0-9_-]+)\.json(\.gz)?$/.exec(f);
      if (m && !seen.has(m[1])) seen.set(m[1], source);
    }
  };
  await scan(LOCAL_DIR, 'local');
  await scan(SHIPPED_DIR, 'shipped');

  const out = [];
  for (const name of seen.keys()) {
    const loaded = await loadModel(name);
    if (loaded.error) {
      out.push({ name, ok: false, error: loaded.error, source: seen.get(name) });
    } else {
      out.push(loaded.meta);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Is this a brain a match may be asked to play? */
export async function isBrain(name) {
  if (BUILTIN_BRAINS.includes(name)) return true;
  const loaded = await loadModel(name);
  return !loaded.error;
}

/** Tests and the trainer invalidate through here. */
export function clearModelCache() {
  cache.clear();
}

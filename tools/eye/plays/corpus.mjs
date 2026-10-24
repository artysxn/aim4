// ---------------------------------------------------------------------------
// tools/eye/plays/corpus.mjs
// The rounds the eye trains on, as Similar Rounds indexes, from wherever they
// are:
//
//   --dir DIR          a folder of .aim4replay packages (default: sampledemos/)
//   --rounds-dir DIR   a server library on disk: <name>.json.zst + <name>.c100.bin
//                      (server/data/replays/<user>/rounds)
//   --base URL         a running aim4 server (the desktop app's own, or a checkout's)
//   --token TOKEN      ...with your sign-in (or AIM4_TOKEN): copy the Bearer token
//                      from any /api request in the browser's network tab
//   --maps CCH,ANC     only these maps
//   --per-map N        at most N rounds a map (the newest, for --base)
//   --cache DIR        keep what --base downloaded (default tools/eye/plays/out/cache):
//                      a second run, or one cut short by an expired token, starts
//                      where the last one stopped
//
// Every round is reduced once to the index Similar Rounds scans (positions every
// 100 ticks, utility, kills, plant, the win chance), which is all the play
// tools read, so a whole library fits in memory.
//
// Node only.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { decodeRoundPacks } from '../../../src/replays/shared/roundPackWire.js';
import { splitStoredName } from '../../../src/replays/shared/roundFilter.js';
import { MAP_CODES } from '../../../src/replays/shared/roundId.js';
import { sliceStride } from '../../../src/replays/shared/tickFormat.js';
import { INDEX_VERSION, SCAN_STRIDE, buildRoundIndex } from '../../../src/replays/similar/roundSimilarity.js';
import { SAMPLE_DIR, eachRound } from '../../../scripts/lib/sampledemoPackages.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.join(here, 'out');

export function flagOf(argv = process.argv) {
  const flag = (name, fallback = '') => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const has = (name) => argv.includes(name);
  return { flag, has };
}

/** The corpus options every plays tool takes. */
export function corpusOptions(argv = process.argv) {
  const { flag } = flagOf(argv);
  return {
    dir: flag('--dir', ''),
    roundsDir: flag('--rounds-dir', ''),
    base: flag('--base', '').replace(/\/$/, ''),
    token: flag('--token', process.env.AIM4_TOKEN || ''),
    maps: flag('--maps') ? flag('--maps').split(',').map((m) => m.trim().toUpperCase()) : null,
    perMap: Number(flag('--per-map', 0)) || 0,
    cache: flag('--cache', path.join(OUT_DIR, 'cache'))
  };
}

/** The match a round belongs to: rounds of one match never split between training and held out. */
export const demoOf = (file) => splitStoredName(String(file || '')).demoId || String(file || '').split('-').slice(0, 3).join('-');

/** Small stable hash, so a demo always lands on the same side of the split. */
export function hash(text, seed = 'aim4') {
  let h = 2166136261;
  for (const ch of `${seed}:${text}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** One demo in five is held out for evaluation. */
export const heldOut = (file, seed = 'aim4') => hash(demoOf(file), seed) % 5 === 0;

const mapOfName = (file) => MAP_CODES.find((code) => String(file).includes(`-${code}-`)) || '';

// ---- sources ----------------------------------------------------------------

async function fromPackages(dir, keep) {
  const out = [];
  for await (const { entry, meta, track } of eachRound({ dir })) {
    if (!keep(meta.map || '')) continue;
    const index = buildRoundIndex(meta, sliceStride(track.buffer, SCAN_STRIDE), entry.file);
    if (index) out.push(index);
  }
  return out;
}

async function fromRoundsDir(dir, keep, perMap) {
  const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.c100.bin')).sort();
  const out = [];
  const perMapCount = new Map();
  for (const n of names) {
    const stem = n.slice(0, -'.c100.bin'.length);
    const map = mapOfName(stem);
    if (!keep(map)) continue;
    if (perMap && (perMapCount.get(map) || 0) >= perMap) continue;
    let meta;
    try {
      const zst = path.join(dir, `${stem}.json.zst`);
      meta = fs.existsSync(zst)
        ? JSON.parse(zlib.zstdDecompressSync(await fsp.readFile(zst)).toString('utf8'))
        : JSON.parse(await fsp.readFile(path.join(dir, `${stem}.json`), 'utf8'));
    } catch {
      continue;
    }
    const ticks = await fsp.readFile(path.join(dir, n));
    const index = buildRoundIndex(meta, ticks, stem);
    if (!index) continue;
    out.push(index);
    perMapCount.set(map, (perMapCount.get(map) || 0) + 1);
  }
  return out;
}

// Indexes as JSON lines: typed arrays as base64, so a cache is one file a map.
const TYPED = { px: Int16Array, py: Int16Array, pz: Int16Array, alive: Uint8Array, gun: Uint8Array, death: Int32Array, slotSide: Int8Array, win: Uint8Array };

export function serializeIndex(index) {
  const out = { ...index };
  for (const k of Object.keys(TYPED)) out[k] = Buffer.from(index[k].buffer, index[k].byteOffset, index[k].byteLength).toString('base64');
  return JSON.stringify(out);
}

export function deserializeIndex(line) {
  const o = JSON.parse(line);
  for (const [k, T] of Object.entries(TYPED)) {
    const b = Buffer.from(o[k], 'base64');
    o[k] = new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
  return o;
}

async function fromApi({ base, token, maps, perMap, cache }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const out = [];
  await fsp.mkdir(cache, { recursive: true });
  for (const map of maps || MAP_CODES) {
    const cacheFile = path.join(cache, `${map}.v${INDEX_VERSION}.ndjson`);
    const kept = new Map();
    if (fs.existsSync(cacheFile)) {
      for (const line of (await fsp.readFile(cacheFile, 'utf8')).split('\n')) {
        if (!line) continue;
        try {
          const index = deserializeIndex(line);
          kept.set(index.file, index);
        } catch {
          // A line cut short by a stopped run: that round is fetched again.
        }
      }
    }
    const res = await fetch(`${base}/api/replays/rounds?${new URLSearchParams({ maps: map, limit: '1000000' })}`, { headers });
    if (!res.ok) throw new Error(`${base}: listing ${map} answered ${res.status}${res.status === 401 ? ' (sign in: pass --token)' : ''}`);
    let files = [...new Set(((await res.json()).rounds || []).map((r) => String(r?.file || r?.name || '')).filter((f) => /^[A-Za-z0-9_~-]+$/.test(f)))];
    if (perMap) files = files.slice(-perMap);
    const missing = files.filter((f) => !kept.has(f));
    console.log(`${map}: ${files.length} rounds, ${files.length - missing.length} cached, ${missing.length} to fetch`);
    const sink = fs.createWriteStream(cacheFile, { flags: 'a' });
    for (let i = 0; i < missing.length; i += 150) {
      const batch = missing.slice(i, i + 150);
      const r = await fetch(`${base}/api/replays/rounds/packs`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: batch, stride: SCAN_STRIDE, ticks: true, meta: 'similar' })
      });
      if (!r.ok) throw new Error(`${base}: round packs answered ${r.status}${r.status === 401 ? ' (the token expired? pass a fresh --token; what was fetched is kept)' : ''}`);
      for (const p of decodeRoundPacks(await r.arrayBuffer()) || []) {
        const index = p.meta && p.ticks ? buildRoundIndex(p.meta, p.ticks, p.file) : null;
        if (!index) continue;
        kept.set(index.file, index);
        sink.write(`${serializeIndex(index)}\n`);
      }
      process.stdout.write(`\r${map}: ${Math.min(i + 150, missing.length)} of ${missing.length} fetched`);
    }
    if (missing.length) process.stdout.write('\n');
    await new Promise((resolve) => sink.end(resolve));
    for (const f of files) if (kept.has(f)) out.push(kept.get(f));
  }
  return out;
}

/**
 * Every round of the corpus as an index, grouped by map.
 * @returns {Promise<Map<string, object[]>>}
 */
export async function loadCorpus(opts = corpusOptions()) {
  const keep = (map) => Boolean(map) && (!opts.maps || opts.maps.includes(map));
  let indexes;
  if (opts.base) indexes = await fromApi(opts);
  else if (opts.roundsDir) indexes = await fromRoundsDir(opts.roundsDir, keep, opts.perMap);
  else indexes = await fromPackages(opts.dir || SAMPLE_DIR, keep);
  const byMap = new Map();
  for (const index of indexes) {
    if (!keep(index.map)) continue;
    if (!byMap.has(index.map)) byMap.set(index.map, []);
    byMap.get(index.map).push(index);
  }
  if (opts.perMap) for (const [map, list] of byMap) byMap.set(map, list.slice(-opts.perMap));
  return byMap;
}

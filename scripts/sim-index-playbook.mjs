#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-index-playbook.mjs
// Build the light sidecar beside each mined tape file.
//
//   node scripts/sim-index-playbook.mjs [--maps DD2,INF] [--dir <path>] [--force]
//
// The loader self-heals -- a missing sidecar is built on first read -- but a
// 2.25 GB scan inside a web request is a two-minute stall on whatever asked
// first. Run this after a mine and the server starts cold in a second.
//
// Rebuilt automatically when the source file changes, because the sidecar is
// a table of byte offsets and a re-mine moves every one of them.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { buildMeta } from '../server/sim/playbookStore.js';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const DIR = flag('dir', path.join(REPLAY_ROOT, 'sim', 'playbook'));
const ONLY = (flag('maps', '') || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const FORCE = has('force');

const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;
const dur = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '0s';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return m ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
};

/** Is the sidecar already current for this source? */
async function isFresh(file) {
  const meta = path.join(path.dirname(file), `${path.basename(file, '.jsonl')}.meta.jsonl`);
  try {
    const [st, fh] = await Promise.all([fsp.stat(file), fsp.open(meta, 'r')]);
    const buf = Buffer.allocUnsafe(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    await fh.close();
    const line = buf.toString('utf8', 0, bytesRead).split('\n')[0];
    const h = JSON.parse(line);
    return h.size === st.size && h.mtimeMs === st.mtimeMs;
  } catch {
    return false;
  }
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.meta.jsonl'))
  .filter((f) => !ONLY.length || ONLY.includes(path.basename(f, '.jsonl').toUpperCase()))
  .map((f) => path.join(DIR, f));

if (!files.length) {
  console.error(`no tape files in ${DIR}`);
  process.exit(1);
}

const totalBytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);
console.log(`indexing ${files.length} tape files, ${gb(totalBytes)}\n`);

const startedAt = Date.now();
let doneBytes = 0;
let totalEntries = 0;

for (const file of files) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;

  if (!FORCE && (await isFresh(file))) {
    console.log(`${name.padEnd(14)} ${gb(size).padStart(8)}  already indexed`);
    doneBytes += size;
    continue;
  }

  let last = 0;
  const { entries, wrote } = await buildMeta(file, ({ bytes, total, entries: n }) => {
    const now = Date.now();
    if (now - last < 400) return;
    last = now;
    const seen = doneBytes + bytes;
    const rate = seen / Math.max(0.001, (now - startedAt) / 1000);
    const pct = ((bytes / total) * 100).toFixed(1);
    process.stdout.write(
      `\r${name.padEnd(14)} ${pct.padStart(5)}%  ${n} tapes  ` +
        `${(rate / 1e6).toFixed(0)} MB/s  eta ${dur((totalBytes - seen) / rate)}   `
    );
  });

  doneBytes += size;
  totalEntries += entries.length;
  const meta = path.join(DIR, `${path.basename(file, '.jsonl')}.meta.jsonl`);
  const metaSize = wrote ? fs.statSync(meta).size : 0;
  process.stdout.write(
    `\r${name.padEnd(14)} ${gb(size).padStart(8)}  ${String(entries.length).padStart(6)} tapes  ` +
      `-> ${(metaSize / 1e6).toFixed(0)} MB sidecar` +
      `${wrote ? '' : ' (NOT WRITTEN: source dir is read-only)'}          \n`
  );
}

const elapsed = (Date.now() - startedAt) / 1000;
console.log(`\n${totalEntries} tapes indexed in ${dur(elapsed)} (${(totalBytes / 1e6 / elapsed).toFixed(0)} MB/s)`);

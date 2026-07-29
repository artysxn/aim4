#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/compact-replays.mjs
// Convert an existing replay library to the compact on-disk form, in place.
//
//   <name>.bin   ->  <name>.tickz + <name>.c100.bin
//   <name>.json  ->  <name>.json.zst
//
// A source file is deleted only after the compact form has been read back and
// compared byte for byte against it. Anything that fails that check is left
// exactly as it was and reported at the end. That is the whole safety argument:
// the library is the only copy once the .dem files are gone, so "it should be
// lossless" is not good enough.
//
// Safe to interrupt and re-run: each round is independent and an already
// converted one is skipped.
//
// Usage:
//   node scripts/compact-replays.mjs --dry-run       report, change nothing
//   node scripts/compact-replays.mjs                 convert
//   node scripts/compact-replays.mjs --limit 50      convert at most 50 rounds
//   AIM4_REPLAY_DIR=/data/replays node scripts/compact-replays.mjs
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { sliceStride } from '../src/replays/shared/tickFormat.js';
import { decodeTickz, decodeTickzStride, encodeTickz } from '../server/replays/tickCodec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.AIM4_REPLAY_DIR || path.join(__dirname, '..', 'server', 'data', 'replays');
const COARSE_STRIDE = 100;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || Infinity;

const fmt = (n) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(Math.max(1, n)) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

async function listUsers() {
  const out = [];
  for (const e of await fsp.readdir(ROOT, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && !e.name.startsWith('.')) out.push(e.name);
  }
  return out;
}

const stats = {
  ticksBefore: 0,
  ticksAfter: 0,
  metaBefore: 0,
  metaAfter: 0,
  rounds: 0,
  metas: 0,
  skipped: 0,
  failures: []
};

/**
 * Convert one tick buffer. Returns false and touches nothing if the round trip
 * is not exact.
 */
async function compactTicks(dir, stem) {
  const binPath = path.join(dir, `${stem}.bin`);
  const original = await fsp.readFile(binPath);

  let tickz;
  let coarse;
  try {
    tickz = encodeTickz(original);
    coarse = Buffer.from(sliceStride(original, COARSE_STRIDE));

    // Read it back the way the server will, not the way we just wrote it.
    const full = Buffer.from(decodeTickz(tickz));
    if (Buffer.compare(full, original) !== 0) {
      throw new Error('full decode differs from the original');
    }
    const strided = Buffer.from(decodeTickzStride(tickz, COARSE_STRIDE));
    if (Buffer.compare(strided, coarse) !== 0) {
      throw new Error('strided decode differs from sliceStride');
    }
  } catch (err) {
    stats.failures.push(`${stem}.bin: ${err.message}`);
    return false;
  }

  stats.ticksBefore += original.length;
  stats.ticksAfter += tickz.length + coarse.length;
  stats.rounds += 1;
  if (DRY) return true;

  await fsp.writeFile(path.join(dir, `${stem}.tickz`), tickz);
  await fsp.writeFile(path.join(dir, `${stem}.c100.bin`), coarse);
  await fsp.rm(binPath, { force: true });
  return true;
}

async function compactMeta(dir, stem) {
  const jsonPath = path.join(dir, `${stem}.json`);
  const original = await fsp.readFile(jsonPath);

  let packed;
  try {
    // Compare the parsed values, not the bytes: JSON.stringify is not required
    // to reproduce the original spacing and this file is read, never diffed.
    const before = JSON.parse(original.toString('utf8'));
    packed = zlib.zstdCompressSync(Buffer.from(JSON.stringify(before)));
    const after = JSON.parse(zlib.zstdDecompressSync(packed).toString('utf8'));
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('round trip changed the meta');
    }
  } catch (err) {
    stats.failures.push(`${stem}.json: ${err.message}`);
    return false;
  }

  stats.metaBefore += original.length;
  stats.metaAfter += packed.length;
  stats.metas += 1;
  if (DRY) return true;

  await fsp.writeFile(path.join(dir, `${stem}.json.zst`), packed);
  await fsp.rm(jsonPath, { force: true });
  return true;
}

async function run() {
  const users = await listUsers();
  if (!users.length) {
    console.log(`No libraries found under ${ROOT}`);
    return;
  }
  console.log(`${DRY ? 'Inspecting' : 'Compacting'} ${ROOT}`);

  let handled = 0;
  for (const user of users) {
    const dir = path.join(ROOT, user, 'rounds');
    const files = await fsp.readdir(dir).catch(() => []);
    if (!files.length) continue;

    // The precomputed coarse pass is also a .bin, and converting it as if it
    // were a full round would produce nonsense.
    const bins = files.filter((f) => f.endsWith('.bin') && !f.endsWith('.c100.bin'));
    const jsons = files.filter((f) => f.endsWith('.json'));
    const already = files.filter((f) => f.endsWith('.tickz')).length;
    stats.skipped += already;

    console.log(
      `  ${user}: ${bins.length} tick files, ${jsons.length} meta files to convert` +
        (already ? ` (${already} already compact)` : '')
    );

    for (const f of bins) {
      if (handled >= LIMIT) break;
      await compactTicks(dir, f.slice(0, -4));
      handled += 1;
      if (handled % 200 === 0) console.log(`    ${handled} rounds…`);
    }
    for (const f of jsons) {
      if (handled >= LIMIT) break;
      await compactMeta(dir, f.slice(0, -5));
      handled += 1;
    }
  }

  const before = stats.ticksBefore + stats.metaBefore;
  const after = stats.ticksAfter + stats.metaAfter;
  console.log('');
  console.log(`  ticks  ${stats.rounds} files  ${fmt(stats.ticksBefore)} -> ${fmt(stats.ticksAfter)}`);
  console.log(`  meta   ${stats.metas} files  ${fmt(stats.metaBefore)} -> ${fmt(stats.metaAfter)}`);
  if (before) {
    const saved = before - after;
    console.log(`  total  ${fmt(before)} -> ${fmt(after)}, ${fmt(saved)} freed (${((saved / before) * 100).toFixed(1)}%)`);
  }
  if (stats.failures.length) {
    console.log('');
    console.log(`  ${stats.failures.length} file(s) failed verification and were left untouched:`);
    for (const f of stats.failures.slice(0, 20)) console.log(`    ${f}`);
    if (stats.failures.length > 20) console.log(`    …and ${stats.failures.length - 20} more`);
  }
  if (DRY) console.log('\n  Dry run: nothing was written or deleted.');
  // A failed verification is the one outcome worth a non-zero exit, so this can
  // be wired into a deploy step without anyone reading the output.
  if (stats.failures.length) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

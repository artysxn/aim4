// Run: node server/replays/archive.test.js
//
// Archives are built with the system zip/gzip/zstd so the reader is tested
// against real files rather than against its own writer.

import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyUpload, isAcceptedUpload, unpackUpload } from './archive.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function have(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-archive-'));
const OUT = path.join(TMP, 'out');
await fsp.mkdir(OUT);
const targetFor = (name) => path.join(OUT, name);
const BUDGET = 64 * 1024 * 1024;

/** Demo-shaped bytes: a CS2 magic plus enough body to be worth compressing. */
function fakeDem(seed, kb = 256) {
  const body = Buffer.alloc(kb * 1024);
  for (let i = 0; i < body.length; i++) body[i] = (i * seed) % 251;
  return Buffer.concat([Buffer.from('PBDEMS2\0'), body]);
}

async function reset() {
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT);
}

// ---- classification ---------------------------------------------------------

assert(classifyUpload('a.dem') === 'dem', 'dem');
assert(classifyUpload('a.DEM') === 'dem', 'case insensitive');
assert(classifyUpload('a.zip') === 'zip', 'zip');
assert(classifyUpload('a.dem.gz') === 'gz', 'gz');
assert(classifyUpload('a.dem.zst') === 'zst', 'zst');
assert(classifyUpload('a.tar.gz') === 'tar', 'tar.gz recognised so it can be refused');
assert(classifyUpload('a.rar') === null, 'unknown');
assert(!isAcceptedUpload('a.tar.gz'), 'tar.gz is not accepted');
assert(!isAcceptedUpload('notes.txt'), 'txt is not accepted');

// ---- zip: only .dem comes out ----------------------------------------------

if (have('zip')) {
  const src = path.join(TMP, 'zipsrc');
  await fsp.mkdir(src, { recursive: true });
  await fsp.mkdir(path.join(src, 'nested'), { recursive: true });
  const a = fakeDem(7);
  const b = fakeDem(11);
  await fsp.writeFile(path.join(src, 'match1.dem'), a);
  await fsp.writeFile(path.join(src, 'nested', 'match2.dem'), b);
  await fsp.writeFile(path.join(src, 'readme.txt'), 'junk that must not be stored');
  await fsp.writeFile(path.join(src, 'thumb.jpg'), Buffer.alloc(4096, 9));
  await fsp.writeFile(path.join(src, 'config.cfg'), 'sensitivity 2.0');

  const zip = path.join(TMP, 'bundle.zip');
  execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: src });

  await reset();
  const got = await unpackUpload({
    source: zip,
    filename: 'bundle.zip',
    targetFor,
    allowedBytes: BUDGET
  });

  assert(got.length === 2, `expected 2 demos, got ${got.length}`);
  const left = (await fsp.readdir(OUT)).sort();
  assert(
    left.join(',') === 'match1.dem,match2.dem',
    `only .dem should be written, found: ${left.join(', ')}`
  );
  // Nested path must be flattened to a basename, not recreated under OUT.
  assert(!left.includes('nested'), 'nested directory was not recreated');
  assert(Buffer.compare(await fsp.readFile(path.join(OUT, 'match1.dem')), a) === 0, 'match1 intact');
  assert(Buffer.compare(await fsp.readFile(path.join(OUT, 'match2.dem')), b) === 0, 'match2 intact');
  console.log('  zip: 2 demos extracted, 3 junk entries skipped');

  // A zip with nothing usable in it is an error, not an empty success.
  const junkOnly = path.join(TMP, 'junk.zip');
  execFileSync('zip', ['-q', junkOnly, 'readme.txt', 'thumb.jpg'], { cwd: src });
  await reset();
  let threw = null;
  await unpackUpload({
    source: junkOnly,
    filename: 'junk.zip',
    targetFor,
    allowedBytes: BUDGET
  }).catch((e) => {
    threw = e;
  });
  assert(threw && /No \.dem files/.test(threw.message), 'junk-only zip is rejected');
  assert((await fsp.readdir(OUT)).length === 0, 'junk-only zip wrote nothing');
  console.log('  zip: junk-only archive rejected, nothing written');

  // Stored (method 0) entries take the copy path rather than inflate.
  const stored = path.join(TMP, 'stored.zip');
  execFileSync('zip', ['-q', '-0', stored, 'match1.dem'], { cwd: src });
  await reset();
  const gotStored = await unpackUpload({
    source: stored,
    filename: 'stored.zip',
    targetFor,
    allowedBytes: BUDGET
  });
  assert(gotStored.length === 1, 'stored entry extracted');
  assert(
    Buffer.compare(await fsp.readFile(path.join(OUT, 'match1.dem')), a) === 0,
    'stored entry intact'
  );
  console.log('  zip: stored (uncompressed) entry handled');

  // The budget has to bite while streaming, since a zip does not have to tell
  // the truth about how large it expands to.
  await reset();
  threw = null;
  await unpackUpload({
    source: zip,
    filename: 'bundle.zip',
    targetFor,
    allowedBytes: 1024
  }).catch((e) => {
    threw = e;
  });
  assert(threw && /available space/.test(threw.message), 'over-budget archive aborts');
  assert(
    (await fsp.readdir(OUT)).length === 0,
    'aborted extraction leaves no partial file behind'
  );
  console.log('  zip: quota enforced mid-stream, partial file removed');
} else {
  console.log('  zip: skipped (no zip binary)');
}

// ---- gz / zst ---------------------------------------------------------------

for (const [kind, cmd, args] of [
  ['gz', 'gzip', ['-k', '-f']],
  ['zst', 'zstd', ['-q', '-f', '-k']]
]) {
  if (!have(cmd)) {
    console.log(`  ${kind}: skipped (no ${cmd} binary)`);
    continue;
  }
  const dem = fakeDem(3);
  const plain = path.join(TMP, `single-${kind}.dem`);
  await fsp.writeFile(plain, dem);
  execFileSync(cmd, [...args, plain]);
  const packed = `${plain}.${kind}`;

  await reset();
  const got = await unpackUpload({
    source: packed,
    filename: path.basename(packed),
    targetFor,
    allowedBytes: BUDGET
  });
  assert(got.length === 1, `${kind}: one demo`);
  assert(got[0].name === `single-${kind}.dem`, `${kind}: name is ${got[0].name}`);
  assert(
    Buffer.compare(await fsp.readFile(got[0].path), dem) === 0,
    `${kind}: contents intact`
  );
  console.log(`  ${kind}: single demo decompressed intact`);
}

// ---- bare .dem is adopted, not copied ---------------------------------------

{
  await reset();
  const dem = fakeDem(5, 16);
  const upload = path.join(TMP, 'upload.tmp');
  await fsp.writeFile(upload, dem);
  const got = await unpackUpload({
    source: upload,
    filename: 'faze-vs-vp.dem',
    targetFor,
    allowedBytes: BUDGET
  });
  assert(got.length === 1 && got[0].name === 'faze-vs-vp.dem', 'bare dem keeps its name');
  assert(Buffer.compare(await fsp.readFile(got[0].path), dem) === 0, 'bare dem intact');
  console.log('  dem: adopted in place');
}

// ---- refusals ---------------------------------------------------------------

{
  let threw = null;
  await unpackUpload({
    source: path.join(TMP, 'upload.tmp'),
    filename: 'x.tar.gz',
    targetFor,
    allowedBytes: BUDGET
  }).catch((e) => {
    threw = e;
  });
  assert(threw && /tar\.gz/.test(threw.message), 'tar.gz refused by name');
}

await fsp.rm(TMP, { recursive: true, force: true });
console.log('archive: all assertions passed');

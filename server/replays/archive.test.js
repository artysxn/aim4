// Run: node server/replays/archive.test.js
//
// Archives are built with the system zip/gzip/zstd so the reader is tested
// against real files rather than against its own writer.

import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyUpload, isAcceptedUpload, isDemoEntry, rarSupport, unpackUpload } from './archive.js';

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
assert(classifyUpload('a.rar') === 'rar', 'rar');
assert(classifyUpload('a.tar') === 'tar', 'tar');
// The order of these two matters: a bare .gz test would claim .tar.gz first and
// a multi-demo tarball would be treated as one compressed demo.
assert(classifyUpload('a.tar.gz') === 'tar.gz', 'tar.gz beats gz');
assert(classifyUpload('a.tgz') === 'tar.gz', 'tgz');
assert(classifyUpload('a.tar.zst') === 'tar.zst', 'tar.zst beats zst');
assert(classifyUpload('a.dem.gz') === 'gz', 'gz');
assert(classifyUpload('a.dem.zst') === 'zst', 'zst');
assert(classifyUpload('a.7z') === null, 'unknown');
assert(!isAcceptedUpload('notes.txt'), 'txt is not accepted');
assert(isAcceptedUpload('a.tar.gz') && isAcceptedUpload('a.rar'), 'tar.gz and rar accepted');

// ---- which entries count as demos ------------------------------------------

assert(isDemoEntry('x.dem') && isDemoEntry('sub/x.dem'), 'plain and nested demos');
assert(isDemoEntry('X.DEM'), 'extension is case insensitive');
assert(!isDemoEntry('x.dem.bak') && !isDemoEntry('notes.dem.txt'), 'decoys rejected');
assert(!isDemoEntry('dir/'), 'directories rejected');
// Anything zipped or tarred on a Mac carries these, and they end in .dem.
assert(!isDemoEntry('__MACOSX/x.dem'), 'Finder resource forks rejected');
assert(!isDemoEntry('._x.dem') && !isDemoEntry('sub/._x.dem'), 'AppleDouble rejected');

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

// ---- macOS-made zip ---------------------------------------------------------

if (have('zip')) {
  const src = path.join(TMP, 'macsrc');
  await fsp.mkdir(path.join(src, '__MACOSX'), { recursive: true });
  const real = fakeDem(23, 64);
  await fsp.writeFile(path.join(src, 'real.dem'), real);
  // What Finder's "Compress" actually puts in the archive alongside it.
  await fsp.writeFile(path.join(src, '__MACOSX', '._real.dem'), Buffer.alloc(4096, 1));
  await fsp.writeFile(path.join(src, '._stray.dem'), Buffer.alloc(2048, 2));
  const zip = path.join(TMP, 'mac.zip');
  execFileSync('zip', ['-q', '-r', zip, '.'], { cwd: src });

  await reset();
  const got = await unpackUpload({ source: zip, filename: 'mac.zip', targetFor, allowedBytes: BUDGET });
  const names = (await fsp.readdir(OUT)).sort();
  assert(got.length === 1, `expected only the real demo, got ${got.length}`);
  assert(names.join(',') === 'real.dem', `resource forks were stored: ${names.join(', ')}`);
  console.log('  zip: macOS resource forks ignored');
}

// ---- tar, tar.gz, tar.zst ---------------------------------------------------

if (have('tar')) {
  const src = path.join(TMP, 'tarsrc');
  await fsp.mkdir(path.join(src, 'nested', 'deep'), { recursive: true });
  const m1 = fakeDem(7, 80);
  const m2 = fakeDem(11, 64);
  // Longer than tar's 100-byte legacy name field, which forces the writer to
  // emit a GNU 'L' or PAX 'x' record. Event demos are routinely named this way.
  const longName =
    'blast-premier-world-final-2026-grand-final-vitality-vs-natus-vincere-map-3-de_inferno-full-broadcast.dem';
  const m3 = fakeDem(13, 48);
  await fsp.writeFile(path.join(src, 'match1.dem'), m1);
  await fsp.writeFile(path.join(src, 'nested', 'deep', 'match2.dem'), m2);
  await fsp.writeFile(path.join(src, longName), m3);
  await fsp.writeFile(path.join(src, 'readme.txt'), 'junk');
  await fsp.writeFile(path.join(src, 'poster.jpg'), Buffer.alloc(4096, 9));
  await fsp.writeFile(path.join(src, 'nested', 'config.cfg'), 'sensitivity 2');
  await fsp.symlink('match1.dem', path.join(src, 'link.dem')).catch(() => {});

  const flavours = [['tar', ['-cf']], ['tar.gz', ['-czf']]];
  for (const [ext, args] of flavours) {
    const archive = path.join(TMP, `bundle.${ext}`);
    execFileSync('tar', [...args, archive, '.'], { cwd: src });

    await reset();
    const got = await unpackUpload({
      source: archive,
      filename: `bundle.${ext}`,
      targetFor,
      allowedBytes: BUDGET
    });
    const names = (await fsp.readdir(OUT)).sort();
    assert(got.length === 3, `${ext}: expected 3 demos, got ${got.length}`);
    assert(names.filter((n) => !n.endsWith('.dem')).length === 0, `${ext}: junk stored`);
    assert(names.filter((n) => n.startsWith('._')).length === 0, `${ext}: AppleDouble stored`);
    assert(!names.includes('link.dem'), `${ext}: symlink was extracted as a file`);
    assert(names.includes('match2.dem'), `${ext}: nested demo not flattened`);
    assert(
      Buffer.compare(await fsp.readFile(path.join(OUT, 'match1.dem')), m1) === 0,
      `${ext}: match1 corrupt`
    );
    assert(
      Buffer.compare(await fsp.readFile(path.join(OUT, 'match2.dem')), m2) === 0,
      `${ext}: nested match2 corrupt`
    );
    assert(
      Buffer.compare(await fsp.readFile(path.join(OUT, longName)), m3) === 0,
      `${ext}: long-named demo corrupt`
    );
    console.log(`  ${ext}: 3 demos including a ${longName.length}-char name, junk and symlink skipped`);
  }

  // tar.zst has no single tar flag, so it is piped.
  if (have('zstd')) {
    const archive = path.join(TMP, 'bundle.tar.zst');
    execFileSync('sh', ['-c', `tar -cf - . | zstd -q -o "${archive}"`], { cwd: src });
    await reset();
    const got = await unpackUpload({
      source: archive,
      filename: 'bundle.tar.zst',
      targetFor,
      allowedBytes: BUDGET
    });
    assert(got.length === 3, `tar.zst: expected 3 demos, got ${got.length}`);
    console.log('  tar.zst: 3 demos extracted');
  }

  // A tarball with nothing usable is an error, not a silent empty success.
  const junkOnly = path.join(TMP, 'junk.tar.gz');
  execFileSync('tar', ['-czf', junkOnly, 'readme.txt', 'poster.jpg'], { cwd: src });
  await reset();
  let threw = null;
  await unpackUpload({
    source: junkOnly,
    filename: 'junk.tar.gz',
    targetFor,
    allowedBytes: BUDGET
  }).catch((e) => {
    threw = e;
  });
  assert(threw && /No \.dem files/.test(threw.message), 'junk-only tarball rejected');
  assert((await fsp.readdir(OUT)).length === 0, 'junk-only tarball wrote nothing');
  console.log('  tar.gz: junk-only archive rejected, nothing written');

  // Budget is enforced while streaming, before the file is fully written.
  await reset();
  threw = null;
  await unpackUpload({
    source: path.join(TMP, 'bundle.tar.gz'),
    filename: 'bundle.tar.gz',
    targetFor,
    allowedBytes: 1024
  }).catch((e) => {
    threw = e;
  });
  assert(threw && /available space/.test(threw.message), 'over-budget tarball aborts');
  console.log('  tar.gz: quota enforced');
} else {
  console.log('  tar: skipped (no tar binary)');
}

// ---- rar --------------------------------------------------------------------

/**
 * Minimal RAR 4.x writer, "stored" method only.
 *
 * Nothing here creates .rar files, so the fixture is built by hand. It is a
 * real archive rather than a mock: the extractor under test is an external
 * tool, and it would reject anything malformed.
 */
function makeRar(files) {
  const T = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const block = (type, flags, body, addSize = null) => {
    const size = 7 + (addSize !== null ? 4 : 0) + body.length;
    const h = Buffer.alloc(size);
    h.writeUInt8(type, 2);
    h.writeUInt16LE(flags, 3);
    h.writeUInt16LE(size, 5);
    let off = 7;
    if (addSize !== null) {
      h.writeUInt32LE(addSize, off);
      off += 4;
    }
    body.copy(h, off);
    h.writeUInt16LE(crc32(h.subarray(2)) & 0xffff, 0);
    return h;
  };

  const parts = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])];
  parts.push(block(0x73, 0x0000, Buffer.alloc(6)));
  for (const { name, data } of files) {
    const nb = Buffer.from(name, 'ascii');
    const body = Buffer.alloc(21 + nb.length);
    body.writeUInt32LE(data.length, 0); // UNP_SIZE
    body.writeUInt8(3, 4); // HOST_OS
    body.writeUInt32LE(crc32(data), 5);
    body.writeUInt32LE(0x50000000, 9); // FTIME
    body.writeUInt8(20, 13); // UNP_VER
    body.writeUInt8(0x30, 14); // METHOD: stored
    body.writeUInt16LE(nb.length, 15);
    body.writeUInt32LE(0x81a4, 17); // ATTR
    nb.copy(body, 21);
    parts.push(block(0x74, 0x8000, body, data.length));
    parts.push(data);
  }
  parts.push(block(0x7b, 0x4000, Buffer.alloc(0)));
  return Buffer.concat(parts);
}

{
  const support = rarSupport();
  if (!support.available) {
    // Not a failure: the server is expected to run without a rar extractor and
    // say so rather than pretend. That path is asserted below.
    console.log('  rar: no extractor on this machine, extraction not exercised');
    await reset();
    let threw = null;
    await fsp.writeFile(path.join(TMP, 'x.rar'), makeRar([{ name: 'a.dem', data: fakeDem(1, 4) }]));
    await unpackUpload({
      source: path.join(TMP, 'x.rar'),
      filename: 'x.rar',
      targetFor,
      allowedBytes: BUDGET
    }).catch((e) => {
      threw = e;
    });
    assert(threw && /cannot open \.rar/i.test(threw.message), 'missing extractor is explained');
    assert(/unar|libarchive-tools/i.test(threw.message), 'the error names the packages to install');
    console.log('  rar: missing extractor reported with a way forward');
  } else {
    const m1 = fakeDem(7, 64);
    const m2 = fakeDem(11, 48);
    // Built in TMP because staging happens beside the source.
    const archive = path.join(TMP, 'bundle.rar');
    await fsp.writeFile(
      archive,
      makeRar([
        { name: 'match1.dem', data: m1 },
        { name: 'sub/match2.dem', data: m2 },
        { name: 'readme.txt', data: Buffer.from('junk that must not be stored') },
        { name: '._match1.dem', data: Buffer.alloc(2048, 1) }
      ])
    );

    await reset();
    const got = await unpackUpload({ source: archive, filename: 'bundle.rar', targetFor, allowedBytes: BUDGET });
    const names = (await fsp.readdir(OUT)).sort();
    assert(got.length === 2, `rar: expected 2 demos, got ${got.length}`);
    assert(names.join(',') === 'match1.dem,match2.dem', `rar: wrong files: ${names.join(', ')}`);
    assert(Buffer.compare(await fsp.readFile(path.join(OUT, 'match1.dem')), m1) === 0, 'rar: match1 corrupt');
    assert(Buffer.compare(await fsp.readFile(path.join(OUT, 'match2.dem')), m2) === 0, 'rar: nested match2 corrupt');
    const staging = (await fsp.readdir(TMP)).filter((f) => f.startsWith('.rar-'));
    assert(staging.length === 0, `rar: staging directory left behind: ${staging.join(', ')}`);
    console.log(`  rar (${support.tool}): 2 demos extracted, junk and resource forks skipped, staging cleaned`);

    // Nothing usable inside is an error rather than an empty success.
    const junkRar = path.join(TMP, 'junk.rar');
    await fsp.writeFile(junkRar, makeRar([{ name: 'readme.txt', data: Buffer.from('nope') }]));
    await reset();
    let threw = null;
    await unpackUpload({ source: junkRar, filename: 'junk.rar', targetFor, allowedBytes: BUDGET }).catch((e) => {
      threw = e;
    });
    assert(threw, 'junk-only rar is rejected');
    assert((await fsp.readdir(OUT)).length === 0, 'junk-only rar wrote nothing');
    console.log('  rar: junk-only archive rejected, nothing written');
  }
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
  // An extension nothing here can open is refused by name, before any I/O.
  const decoy = path.join(TMP, 'decoy.bin');
  await fsp.writeFile(decoy, Buffer.alloc(64, 1));
  let threw = null;
  await unpackUpload({
    source: decoy,
    filename: 'archive.7z',
    targetFor,
    allowedBytes: BUDGET
  }).catch((e) => {
    threw = e;
  });
  assert(threw, '7z is refused');
  assert(/\.zip, \.rar, \.tar\.gz/.test(threw.message), `error lists what works: ${threw?.message}`);
  console.log('  unsupported extension refused, with the accepted list');
}

await fsp.rm(TMP, { recursive: true, force: true });
console.log('archive: all assertions passed');

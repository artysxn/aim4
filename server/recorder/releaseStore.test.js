import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-recorder-'));
process.env.AIM4_RECORDER_DIR = path.join(tmp, 'recorder');

const {
  compareVersions,
  deleteRelease,
  isValidVersion,
  latestRelease,
  listReleases,
  publishRelease,
  readBuild,
  looksExecutable
} = await import('./releaseStore.js');

{
  // The check exists to catch a wrong artifact, not to enforce one OS: a Mac
  // or Linux build is a plausible thing to publish later.
  assert.ok(looksExecutable(Buffer.from([0x4d, 0x5a, 0, 0])), 'Windows PE');
  assert.ok(looksExecutable(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'Linux ELF');
  assert.ok(looksExecutable(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])), 'Mach-O 64-bit');
  assert.ok(looksExecutable(Buffer.from([0xca, 0xfe, 0xba, 0xbe])), 'Mach-O universal');

  assert.ok(!looksExecutable(Buffer.from('PK')), 'a zip is not a program');
  assert.ok(!looksExecutable(Buffer.from('#!/bin/sh')), 'nor is a shell script');
  assert.ok(!looksExecutable(Buffer.from('MZ')), 'nor is something too short to tell');
  assert.ok(!looksExecutable(null));
}

/** A plausible Windows executable: the MZ magic and then some payload. */
const exe = (marker) => Buffer.concat([Buffer.from('MZ'), Buffer.from(marker.padEnd(64, '.'))]);

{
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '10 is newer than 9, not older');
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.0.0', 'garbage'), 1, 'unparseable sorts oldest');

  assert.ok(isValidVersion('0.1.0'));
  assert.ok(!isValidVersion('1.2'));
  assert.ok(!isValidVersion('v1.2.3'));
  assert.ok(!isValidVersion('1.2.3-beta'));
}

{
  assert.equal(await latestRelease(), null, 'nothing published yet');
  assert.deepEqual(await listReleases(), []);
  assert.equal(await readBuild('1.0.0'), null);
}

{
  const bytes = exe('build-one');
  const rel = await publishRelease({ version: '1.0.0', notes: 'first', bytes, publishedBy: 'admin' });
  assert.equal(rel.version, '1.0.0');
  assert.equal(rel.sizeBytes, bytes.length);
  assert.equal(
    rel.sha256,
    crypto.createHash('sha256').update(bytes).digest('hex'),
    'the digest is over the exact bytes served, so the app can verify before swapping itself'
  );

  const stored = await readBuild('1.0.0');
  assert.deepEqual(stored, bytes, 'the build comes back byte for byte');
  assert.equal((await latestRelease()).version, '1.0.0');
}

{
  // A published version is immutable: recorders cache by version, so changing
  // the bytes under a number would strand whoever already has it.
  await assert.rejects(
    () => publishRelease({ version: '1.0.0', bytes: exe('different') }),
    /already published/
  );
}

{
  await assert.rejects(() => publishRelease({ version: '1.2', bytes: exe('x') }), /1\.2\.3/);
  await assert.rejects(() => publishRelease({ version: '1.0.1', bytes: Buffer.alloc(0) }), /empty/);
  // The commonest mistake is uploading the wrong artifact entirely.
  await assert.rejects(
    () => publishRelease({ version: '1.0.1', bytes: Buffer.from('#!/bin/sh\necho hi') }),
    /does not look like a program/
  );
  await assert.rejects(
    () => publishRelease({ version: '1.0.1', bytes: Buffer.from('PK\u0003\u0004zip file') }),
    /does not look like a program/,
    'a zip is the classic wrong artifact'
  );
}

{
  await publishRelease({ version: '1.0.1', bytes: exe('build-two') });
  await publishRelease({ version: '1.10.0', bytes: exe('build-ten') });
  assert.equal(
    (await latestRelease()).version,
    '1.10.0',
    'latest is by version order, not upload order'
  );
}

{
  // Only the newest few builds are kept, but nothing may advertise a file that
  // is no longer on disk.
  for (const v of ['1.0.2', '1.0.3', '1.0.4', '1.0.5']) {
    await publishRelease({ version: v, bytes: exe(`build-${v}`) });
  }
  const releases = await listReleases();
  assert.ok(releases.length <= 5, `pruned to ${releases.length} builds`);
  for (const rel of releases) {
    assert.ok(await readBuild(rel.version), `${rel.version} still has its file`);
  }
  assert.equal(await readBuild('1.0.0'), null, 'the pruned build is gone');
}

{
  const latest = await latestRelease();
  assert.equal(await deleteRelease(latest.version), true, 'a bad build can be pulled');
  assert.equal(await readBuild(latest.version), null);
  assert.notEqual((await latestRelease()).version, latest.version, 'and the feed falls back');
  assert.equal(await deleteRelease('9.9.9'), false);
}

await fsp.rm(tmp, { recursive: true, force: true });
console.log('recorder release store tests passed');

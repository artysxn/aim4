// ---------------------------------------------------------------------------
// recorder/releaseStore.js — the desktop recorder's builds and update feed
//
// The recorder ships as ONE self-contained .exe. There is no installer, no
// zip, and no folder: the user downloads a file and runs it, and from then on
// it replaces itself in place whenever a newer build is published here.
//
// Builds live in the data volume, not in the repo and not in the image:
//
//   <data>/recorder/aim4-recorder-<version>.exe
//   <data>/recorder/releases.json
//
// That location is the whole point. Coolify mounts a named volume over
// server/data, so a published build survives every later site deploy — and,
// more importantly, shipping a recorder update does NOT require redeploying
// the site. An admin uploads a new .exe and every running recorder picks it up
// on its next check.
//
// Nothing here compiles anything. The Rust source lives in recorder/ and is
// built on a developer machine; the Dockerfile never copies that directory, so
// the site image has no Rust toolchain and no reason to grow one.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ROOT } from '../replays/demoStore.js';

/** Beside the replay library, inside the same mounted volume. */
export const RECORDER_DIR = process.env.AIM4_RECORDER_DIR || path.join(ROOT, '..', 'recorder');

const INDEX = 'releases.json';
/** A single-file Rust binary with whisper.cpp linked in. Well under this. */
export const MAX_BUILD_BYTES = 200 * 1024 * 1024;
/** Keep a few old builds so a bad release can be rolled back by pointing back. */
const KEEP_BUILDS = 5;

const indexPath = () => path.join(RECORDER_DIR, INDEX);

/**
 * Semantic-ish version compare. Recorder versions are `major.minor.patch`;
 * anything unparseable sorts oldest so a malformed upload can never present
 * itself as newer than a real release.
 */
export function compareVersions(a, b) {
  const parts = (v) =>
    String(v || '')
      .split('.')
      .map((n) => (/^\d+$/.test(n) ? Number(n) : -1));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function isValidVersion(v) {
  return /^\d+\.\d+\.\d+$/.test(String(v || ''));
}

/**
 * Does this start like a compiled program?
 *
 * The point is catching the commonest mistake by far, which is uploading the
 * wrong artifact entirely: a zip, a readme, the .pdb next to the exe. It is
 * deliberately not "must be Windows" — the recorder targets Windows because
 * that is where CS2 is played, but a Mac or Linux build is a plausible thing
 * to publish later and this check has no business being the reason it cannot.
 *
 * @param {Buffer} bytes
 */
export function looksExecutable(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const [a, b, c, d] = bytes;
  // PE / MZ (Windows)
  if (a === 0x4d && b === 0x5a) return true;
  // ELF (Linux)
  if (a === 0x7f && b === 0x45 && c === 0x4c && d === 0x46) return true;
  // Mach-O, 32 and 64 bit, either byte order, plus universal binaries.
  const magic = (a << 24) | (b << 16) | (c << 8) | d;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic >>> 0);
}

async function readIndex() {
  try {
    const raw = JSON.parse(await fsp.readFile(indexPath(), 'utf8'));
    return Array.isArray(raw?.releases) ? raw : { releases: [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { releases: [] };
    throw err;
  }
}

async function writeIndex(index) {
  await fsp.mkdir(RECORDER_DIR, { recursive: true });
  await fsp.writeFile(indexPath(), JSON.stringify(index, null, 2));
}

/**
 * The build a recorder should be running, or null when none is published.
 *
 * `sha256` is not decoration: the recorder overwrites its own executable with
 * whatever this serves, so it verifies the digest before swapping. A truncated
 * download that got a 200 would otherwise brick the app.
 */
export async function latestRelease() {
  const { releases } = await readIndex();
  if (!releases.length) return null;
  return [...releases].sort((a, b) => compareVersions(b.version, a.version))[0];
}

export async function listReleases() {
  const { releases } = await readIndex();
  return [...releases].sort((a, b) => compareVersions(b.version, a.version));
}

/** Bytes of one published build, or null. */
export async function readBuild(version) {
  if (!isValidVersion(version)) return null;
  const { releases } = await readIndex();
  const rel = releases.find((r) => r.version === version);
  if (!rel) return null;
  try {
    return await fsp.readFile(path.join(RECORDER_DIR, rel.file));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Publish a build.
 *
 * Refuses to overwrite a version that already exists: recorders cache by
 * version, so replacing the bytes under a published number would leave some
 * machines on the old build with no way to tell. Ship a new number instead.
 *
 * @param {{version: string, notes?: string, bytes: Buffer, publishedBy?: string}} opts
 */
export async function publishRelease({ version, notes = '', bytes, publishedBy = null }) {
  if (!isValidVersion(version)) {
    throw new Error('Version must look like 1.2.3.');
  }
  if (!bytes?.length) throw new Error('The build is empty.');
  if (bytes.length > MAX_BUILD_BYTES) throw new Error('That build is too large.');
  if (!looksExecutable(bytes)) {
    throw new Error('That does not look like a program. Upload the built binary.');
  }

  const index = await readIndex();
  if (index.releases.some((r) => r.version === version)) {
    throw new Error(`Version ${version} is already published.`);
  }

  const file = `aim4-recorder-${version}.exe`;
  await fsp.mkdir(RECORDER_DIR, { recursive: true });
  await fsp.writeFile(path.join(RECORDER_DIR, file), bytes);

  const release = {
    version,
    file,
    notes: String(notes || '').slice(0, 2000),
    sizeBytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    publishedAt: Date.now(),
    publishedBy
  };
  index.releases.push(release);

  // Prune the oldest builds' binaries, keeping their index entries out too so
  // nothing advertises a file that is no longer on disk.
  const ordered = [...index.releases].sort((a, b) => compareVersions(b.version, a.version));
  for (const old of ordered.slice(KEEP_BUILDS)) {
    await fsp.rm(path.join(RECORDER_DIR, old.file), { force: true });
  }
  index.releases = ordered.slice(0, KEEP_BUILDS);

  await writeIndex(index);
  return release;
}

/** Remove a published build, for pulling a bad release. */
export async function deleteRelease(version) {
  const index = await readIndex();
  const rel = index.releases.find((r) => r.version === version);
  if (!rel) return false;
  await fsp.rm(path.join(RECORDER_DIR, rel.file), { force: true });
  index.releases = index.releases.filter((r) => r.version !== version);
  await writeIndex(index);
  return true;
}

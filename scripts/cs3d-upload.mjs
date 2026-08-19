// ---------------------------------------------------------------------------
// scripts/cs3d-upload.mjs
// Sync server/data/cs3d/pack/ to a Cloudflare R2 bucket.
//
// The renderer fetches packs from VITE_CS3D_ASSET_BASE when it is set (see
// src/cs3d/mapLoader.js assetBase()), falling back to the API host's
// /api/cs3d. Pointing that at R2 takes the origin box out of the path
// entirely: the packs are static, immutable and versioned, which is exactly
// what a CDN is for, and R2 charges nothing for egress.
//
// Object keys mirror the pack directory, because the loader builds its URLs as
// `${assetBase()}/${slug}/...`:
//
//   nuke/manifest.json
//   nuke/geo/g00.glb
//   nuke/tex.bin
//
// Headers matter as much as the bytes. Everything except manifest.json is
// immutable for a year (a re-pack rewrites names or the loader's ?v= changes),
// while manifest.json is the one file the client revalidates. This mirrors
// server/cs3d/routes.js so the two delivery paths behave identically.
//
// Usage:
//   node scripts/cs3d-upload.mjs                 # every map in the pack dir
//   node scripts/cs3d-upload.mjs --map nuke      # one map
//   node scripts/cs3d-upload.mjs --dry           # show what would change
//   node scripts/cs3d-upload.mjs --force         # re-upload even if unchanged
//
// Credentials (R2 -> Manage API Tokens -> Object Read & Write):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Read from the environment or from .env.local, whichever is present.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = path.resolve(process.env.CS3D_PACK_DIR || path.join(ROOT, 'server', 'data', 'cs3d', 'pack'));

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? String(args[i + 1] || '') : d;
};
const only = opt('--map', '');
const dry = flag('--dry');
const force = flag('--force');
const CONCURRENCY = Number(opt('--jobs', 8));

/**
 * Retry a request that failed for a reason that might not repeat.
 *
 * A pack sync is ~500 objects and the best part of a gigabyte over eight
 * connections, and at that size a transient socket error is a normal event
 * rather than an exceptional one — a single `sslv3 alert bad record mac`
 * mid-run used to abort the whole upload and leave the bucket half-written.
 * Every operation here is idempotent (a PUT of the same key with the same
 * bytes, or a HEAD), so retrying is always safe.
 *
 * Not retried: anything the request itself is wrong about (auth, a bad bucket,
 * a 4xx that is not 408/429), because those repeat forever and the useful
 * thing is to fail loudly on the first one.
 */
async function retry(fn, label, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.$metadata?.httpStatusCode;
      const fatal = status && status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (fatal || i >= attempts) throw e;
      // Exponential with jitter: 0.25s, 0.5s, 1s, 2s.
      const wait = 250 * 2 ** (i - 1) * (0.5 + Math.random());
      console.warn(`  ! ${label}: ${e?.message || e} — retry ${i}/${attempts - 1} in ${(wait / 1000).toFixed(1)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Same table as server/cs3d/routes.js: the two paths must agree. */
const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.bin': 'application/octet-stream'
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=60';

function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

function fail(msg) {
  console.error(`cs3d-upload: ${msg}`);
  process.exit(1);
}

/**
 * Directories inside a pack that are LOCAL ONLY and must never be uploaded.
 *
 * `geo.orig/` is `npm run cs3d:split`'s undo copy: the pre-split geometry, kept
 * beside `geo/` so `--restore` can put it back. Nothing fetches it — the loader
 * only ever asks for the files the manifest names — and it is byte-for-byte
 * about as large as the pack itself. Left in the walk it added 458 MB of dead
 * objects across six maps to the bucket, which is both the storage bill and,
 * on a rate-limited origin, a much longer sync for no reason.
 */
const SKIP_DIRS = new Set(['geo.orig']);

/** Every file under dir, as posix-style keys relative to it. */
async function walk(dir, base = dir) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...(await walk(full, base)));
    } else if (e.isFile()) out.push({ full, key: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

async function main() {
  loadEnvLocal();
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const Bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !Bucket) {
    fail(
      'missing credentials. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ' +
        'R2_SECRET_ACCESS_KEY and R2_BUCKET in the environment or .env.local'
    );
  }
  if (!fs.existsSync(PACK_DIR)) fail(`no pack directory at ${PACK_DIR}`);

  const maps = (await fsp.readdir(PACK_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((m) => !only || m === only)
    .sort();
  if (!maps.length) fail(only ? `no pack for "${only}"` : 'no packs to upload');

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
  });

  console.log(`cs3d-upload: ${PACK_DIR} -> r2://${Bucket}${dry ? ' (dry run)' : ''}`);

  let uploaded = 0;
  let skipped = 0;
  let bytes = 0;
  let lastLog = Date.now();

  for (const map of maps) {
    const files = await walk(path.join(PACK_DIR, map));
    // manifest.json last: until it lands, the old one still points at a
    // complete set of files. Uploading it first would advertise geometry that
    // is not there yet to anyone loading mid-sync.
    files.sort((a, b) => Number(a.key.endsWith('manifest.json')) - Number(b.key.endsWith('manifest.json')));

    let mapUp = 0;
    let mapSkip = 0;
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= files.length) return;
        const { full, key: rel } = files[i];
        const Key = `${map}/${rel}`;
        const body = await fsp.readFile(full);
        const isManifest = path.basename(full) === 'manifest.json';

        if (!force) {
          try {
            const head = await retry(() => s3.send(new HeadObjectCommand({ Bucket, Key })), `head ${Key}`);
            const etag = String(head.ETag || '').replace(/"/g, '');
            // A multipart ETag is not an md5; treat it as unknown and re-upload.
            if (head.ContentLength === body.length && !etag.includes('-') && etag === md5(body)) {
              mapSkip++;
              skipped++;
              continue;
            }
          } catch {
            /* absent: upload it */
          }
        }

        if (!dry) {
          await retry(
            () =>
              s3.send(
                new PutObjectCommand({
                  Bucket,
                  Key,
                  Body: body,
                  ContentType: MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
                  CacheControl: isManifest ? REVALIDATE : IMMUTABLE
                })
              ),
            `put ${Key}`
          );
        }
        mapUp++;
        uploaded++;
        bytes += body.length;
        // A gigabyte over a few hundred objects is minutes of silence otherwise.
        if (Date.now() - lastLog > 15000) {
          lastLog = Date.now();
          console.log(`  ... ${map}: ${mapUp + mapSkip}/${files.length} files, ${(bytes / 1024 ** 2).toFixed(0)} MB sent`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    console.log(`  ${map}: ${mapUp} uploaded, ${mapSkip} unchanged (${files.length} files)`);
  }

  console.log(
    `cs3d-upload: ${uploaded} object(s), ${(bytes / 1024 ** 2).toFixed(1)} MB` +
      `${skipped ? `, ${skipped} unchanged` : ''}${dry ? ' (dry run, nothing written)' : ''}`
  );
  if (!dry && uploaded) {
    console.log('Next: set VITE_CS3D_ASSET_BASE to the bucket URL and redeploy the site.');
  }
}

main().catch((e) => fail(e?.message || e));

#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/cs3d-audit.mjs
// Does every file the packs claim actually exist, at the right size, where the
// browser goes looking for it?
//
// Written on 2026-08-19 after Anubis rendered with nine of its seventy-four
// geometry tiles missing and Dust 2 with holes of its own. The loader logged a
// warning per dropped tile and carried on, so the failure looked like a bug in
// the renderer when it was the delivery: `pub-*.r2.dev` is RATE LIMITED, and
// the burst a map load opens against it — four geometry workers, the texture
// bundle, the lightmap, the shadow mask, the probe grid, and the player,
// weapon, fx and bullet packs — is enough to earn a 429 or a dropped socket.
// The client side of that is fixed (src/cs3d/packFetch.js retries, and
// mapLoader takes a second pass at anything it still lost). This is the other
// half: proving the bytes are up there in the first place.
//
// It checks three different things, and they fail for three different reasons:
//
//   MISSING    the object 404s. Nothing will ever load it. Usually a pack that
//              was built but never uploaded — `bullets/` was in exactly this
//              state, which is why the site had no bullet holes and no tracers.
//   STALE      the object exists but its bytes differ from the local pack.
//              `npm run cs3d:split` rewrites geo/*.glb in place, so a split run
//              after the last upload leaves the live map without its doors.
//   THROTTLED  a 429. Not a fault in the pack at all: the audit itself tripped
//              the limit. Re-run with fewer --jobs, or read it as one more
//              reason to put a custom domain in front of the bucket.
//
// Usage:
//   node scripts/cs3d-audit.mjs                     # every map, against R2
//   node scripts/cs3d-audit.mjs --map anubis
//   node scripts/cs3d-audit.mjs --base http://localhost:8080/api/cs3d
//   node scripts/cs3d-audit.mjs --jobs 2            # gentler on the rate limit
//   node scripts/cs3d-audit.mjs --notes             # show the harmless notes too
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = path.resolve(process.env.CS3D_PACK_DIR || path.join(ROOT, 'server', 'data', 'cs3d', 'pack'));

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? String(args[i + 1] || '') : d;
};
const only = opt('--map', '');
/**
 * Four, not the eight an upload uses. This tool's whole job is to distinguish
 * a missing object from a throttled one, and hammering the origin turns every
 * answer into the second.
 */
const JOBS = Number(opt('--jobs', 4));
/** Print the informational notes too, not just the failures. */
const verbose = args.includes('--notes');

function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

const BASE = (
  opt('--base', '') ||
  process.env.VITE_CS3D_ASSET_BASE ||
  ''
).replace(/\/+$/, '');
if (!BASE) {
  console.error(
    'cs3d-audit: no asset base. Pass --base <url>, or set VITE_CS3D_ASSET_BASE in .env.local.'
  );
  process.exit(1);
}

/**
 * Every file a manifest refers to, with the size the manifest expects where it
 * records one. The shapes differ between blocks — some are `{file}`, some are a
 * bare string — so each is unwrapped rather than assumed.
 */
function filesOf(manifest) {
  const out = [];
  const add = (f, bytes = null) => {
    if (typeof f === 'string' && f) out.push({ file: f, bytes });
    else if (f?.file) out.push({ file: f.file, bytes: f.bytes ?? bytes });
  };
  add(manifest.phys || 'phys.glb');
  add(manifest.probeGrid);
  add(manifest.tex);
  add(manifest.lightmap);
  add(manifest.shadowMask);
  add(manifest.sky?.equirect);
  add(manifest.post?.lut);
  for (const g of manifest.groups || []) add(g.file, g.bytes);
  for (const g of manifest.sky3d?.groups || []) add(g.file, g.bytes);
  return out;
}

/**
 * Files a non-map pack's index names. The four asset packs each describe their
 * contents differently — fx has `sheets`, bullets has `atlas` plus `tracer`,
 * players and weapons list per-entry `file`s — so this walks the whole document
 * for anything that looks like a packed file name. A pack half-uploaded is the
 * same class of failure as one not uploaded at all, and neither shows up if the
 * audit only ever checks the index itself.
 */
function assetFilesOf(doc) {
  const out = new Set();
  const visit = (v) => {
    if (!v) return;
    if (typeof v === 'string') {
      if (/\.(glb|webp|png|ktx2|hdr|bin)$/i.test(v)) out.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (typeof v === 'object') for (const x of Object.values(v)) visit(x);
  };
  visit(doc);
  return [...out].map((file) => ({ file }));
}

/**
 * The fx pack's index is `fx.json`, not `manifest.json` — spriteCard.js fetches
 * it by that name. Without this line the one pack whose absence stops every
 * grenade drawing would be the one pack the audit skipped.
 */
const INDEX_NAME = { fx: 'fx.json' };

/** Map packs are the ones with a `groups` array; `fx/`, `players/` etc. are not. */
async function packDirs() {
  const out = [];
  for (const name of await fsp.readdir(PACK_DIR)) {
    if (only && name !== only) continue;
    const mf = path.join(PACK_DIR, name, INDEX_NAME[name] || 'manifest.json');
    if (!fs.existsSync(mf)) continue;
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(mf, 'utf8'));
    } catch (e) {
      out.push({ slug: name, error: `manifest unreadable: ${e.message}` });
      continue;
    }
    out.push({
      slug: name,
      manifest,
      index: INDEX_NAME[name] || 'manifest.json',
      isMap: Array.isArray(manifest.groups)
    });
  }
  return out;
}

/** HEAD, with the status and the length the origin reports. */
async function head(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return { status: res.status, length: Number(res.headers.get('content-length') ?? -1) };
  } catch (e) {
    return { status: 0, length: -1, error: e.message || String(e) };
  }
}

async function auditPack({ slug, manifest, index, isMap }) {
  const files = isMap ? filesOf(manifest) : [];
  // A non-map pack (fx, players, weapons, bullets) has no group list to walk,
  // so at minimum check that its index is reachable at all — which is the
  // exact failure `bullets/` was in. The fx pack's sheets are named in it, so
  // those are checked too: they are what a grenade is drawn out of.
  const targets = isMap ? [{ file: index }, ...files] : [{ file: index }, ...assetFilesOf(manifest)];
  const problems = [];
  // Informational only: these do not stop anything loading. Kept apart from
  // `problems` so a clean run reads as clean and the exit code means something.
  const notes = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const { file, bytes } = targets[next++];
      const local = path.join(PACK_DIR, slug, file);
      const localSize = fs.existsSync(local) ? fs.statSync(local).size : -1;
      const r = await head(`${BASE}/${slug}/${file}`);
      const notes2 = [];
      if (localSize < 0) notes2.push('not in the local pack');
      if (r.status === 404) notes2.push('MISSING from the host');
      else if (r.status === 429) notes2.push('THROTTLED (429) — re-run with fewer --jobs');
      else if (r.status === 0) notes2.push(`unreachable: ${r.error}`);
      else if (r.status !== 200) notes2.push(`HTTP ${r.status}`);
      else if (localSize >= 0 && r.length >= 0 && r.length !== localSize) {
        notes2.push(`STALE: host has ${r.length} B, local pack has ${localSize} B`);
      }
      if (notes2.length) problems.push(`  ${file}: ${notes2.join(' | ')}`);
      // Not a fault in the delivery: `cs3d:split` rewrites geo/*.glb after
      // `cs3d:pack` wrote the manifest, so the size it recorded is a few
      // hundred bytes out. Only the loading bar reads it.
      else if (bytes != null && localSize >= 0 && bytes !== localSize) {
        notes.push(`  ${file}: manifest says ${bytes} B, file is ${localSize} B (loading bar only)`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, JOBS) }, worker));
  problems.sort();
  notes.sort();
  return { slug, isMap, checked: targets.length, problems, notes };
}

const packs = await packDirs();
if (!packs.length) {
  console.error(`cs3d-audit: no packs under ${PACK_DIR}${only ? ` matching --map ${only}` : ''}`);
  process.exit(1);
}

console.log(`cs3d-audit: ${packs.length} pack(s) against ${BASE}\n`);
let bad = 0;
for (const pack of packs) {
  if (pack.error) {
    console.log(`${pack.slug}: ${pack.error}`);
    bad++;
    continue;
  }
  const r = await auditPack(pack);
  const label = `${r.slug}${r.isMap ? '' : ' (asset pack)'}`;
  if (!r.problems.length) {
    console.log(`  ok    ${label} — ${r.checked} files${r.notes.length ? ` (${r.notes.length} note(s))` : ''}`);
  } else {
    bad++;
    console.log(`  BAD   ${label} — ${r.problems.length} of ${r.checked} files`);
    for (const p of r.problems) console.log(p);
  }
  if (verbose) for (const n of r.notes) console.log(n);
}

if (bad) {
  console.log(
    `\n${bad} pack(s) with problems. MISSING or STALE is fixed by \`npm run cs3d:upload\`` +
      `${only ? ` -- --map ${only}` : ''}; THROTTLED is the host rate-limiting this tool, not a bad pack.`
  );
  process.exit(1);
}
console.log('\nEvery pack file is present and matches the local build.');

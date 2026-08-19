// ---------------------------------------------------------------------------
// scripts/cs3d-fetch.mjs
// Pull a cs3d pack OUT of the public bucket into server/data/cs3d/pack/.
//
// The counterpart to scripts/cs3d-upload.mjs, which only ever went one way. The
// pack directory is not in git and not in the image, so a fresh checkout serves
// whatever happens to be on that disk and 404s the rest — and the failure is
// quiet by design: no weapons pack means `viewModel.js` hides the gun and logs
// a warning, no players pack means placeholder bodies. Hours can go into
// "why is the viewmodel gone" before anyone checks the directory listing.
//
// PUBLIC bucket, no credentials. r2.dev serves the same objects cs3d-upload.mjs
// puts there, and this only ever reads, so it needs none of the R2 keys the
// upload script wants. It cannot LIST, though (r2.dev has no bucket listing),
// so the manifest is the index: every `{ file, bytes }` in it is fetched, which
// is exactly how the packs are laid out (flat, one directory per pack).
//
// That makes this right for the flat packs — `weapons`, `players`, `fx` — and
// NOT for a map pack, whose geometry groups and texture bundle are named by
// other rules. Map packs come from scripts/cs3d-pack.mjs locally.
//
// Usage:
//   node scripts/cs3d-fetch.mjs weapons players
//   node scripts/cs3d-fetch.mjs weapons --base https://example.r2.dev
//   node scripts/cs3d-fetch.mjs weapons --dry
//
// Base URL: --base, else CS3D_FETCH_BASE, else DEFAULT_BASE below.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = path.resolve(process.env.CS3D_PACK_DIR || path.join(ROOT, 'server', 'data', 'cs3d', 'pack'));

/** The site's own public bucket. Public on purpose: it is what every visitor already fetches. */
const DEFAULT_BASE = 'https://pub-2cbbca6c60604cc7a9fde25f012821d9.r2.dev';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const force = args.includes('--force');
const baseArg = args.indexOf('--base');
const BASE = (baseArg >= 0 ? args[baseArg + 1] : process.env.CS3D_FETCH_BASE || DEFAULT_BASE).replace(/\/$/, '');
// `baseArg + 1` is only a value to skip when `--base` was actually given;
// without it indexOf returns -1 and the guard would eat the first pack.
const packs = args.filter((a, i) => !a.startsWith('--') && !(baseArg >= 0 && i === baseArg + 1));

if (!packs.length) {
  console.error('usage: node scripts/cs3d-fetch.mjs <pack> [<pack>...] [--base URL] [--dry] [--force]');
  process.exit(1);
}

/** Every `file` a manifest names, wherever it is nested. */
function filesIn(manifest) {
  const out = new Set();
  (function walk(v) {
    if (!v || typeof v !== 'object') return;
    if (typeof v.file === 'string') out.add(v.file);
    for (const k of Object.keys(v)) walk(v[k]);
  })(manifest);
  return [...out];
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

for (const pack of packs) {
  // Every flat pack keys its index `manifest.json` except the effects sheets,
  // which predate the convention and use `fx.json`.
  const indexName = pack === 'fx' ? 'fx.json' : 'manifest.json';
  const dir = path.join(PACK_DIR, pack);
  let index;
  try {
    index = await get(`${BASE}/${pack}/${indexName}`);
  } catch (e) {
    console.error(`${pack}: no ${indexName} in the bucket (${e.message}) — skipped`);
    continue;
  }
  const manifest = JSON.parse(index.toString('utf8'));
  const files = filesIn(manifest);
  console.log(`${pack}: ${files.length} files`);
  if (dry) continue;

  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, indexName), index);

  let got = 0;
  let bytes = 0;
  let skipped = 0;
  for (const file of files) {
    const dest = path.join(dir, file);
    if (!force && fs.existsSync(dest)) {
      skipped++;
      continue;
    }
    try {
      const buf = await get(`${BASE}/${pack}/${file}`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
      got++;
      bytes += buf.length;
      process.stdout.write(`\r  ${got}/${files.length}  ${mb(bytes)}   `);
    } catch (e) {
      console.warn(`\n  ${file}: ${e.message}`);
    }
  }
  console.log(`\r  ${pack}: ${got} fetched (${mb(bytes)})${skipped ? `, ${skipped} already present` : ''}      `);
}

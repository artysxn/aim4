// ---------------------------------------------------------------------------
// server/cs3d/availability.js
// Which maps this host can actually render in 3D.
//
// The answer is per-HOST, not per-build: map packs are volume state, uploaded
// once per machine and deliberately absent from git and from the image (see
// server/cs3d/routes.js). So "is Nuke available" is a question about a
// directory, and a deploy does not change it. Today that is Nuke alone; the
// day another pack is uploaded this starts saying yes to it with no code
// change, which is the point of asking the disk rather than keeping a list.
//
// Cached briefly because the replay list asks once per demo per render, and
// the answer changes only when someone uploads a pack.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { PACK_DIR } from './routes.js';
import { CS3D_MAPS } from '../../shared/cs3d/maps.js';

const TTL_MS = 30_000;
const cache = new Map(); // slug -> { at, ok }

/** The 3D map for a 2D map code (NUK, INF, …), or null if there is none. */
export function cs3dMapByCode(code) {
  const want = String(code || '').toUpperCase();
  if (!want) return null;
  return CS3D_MAPS.find((m) => m.code === want) || null;
}

/**
 * Is this map's pack present on this host? A pack is usable when its
 * manifest is readable — the manifest is what the client fetches first, and
 * a directory without one is a half-finished upload.
 */
export async function hasCs3dPack(slug) {
  if (!slug) return false;
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  let ok = false;
  try {
    const stat = await fsp.stat(path.join(PACK_DIR, slug, 'manifest.json'));
    ok = stat.isFile() && stat.size > 0;
  } catch {
    ok = false;
  }
  cache.set(slug, { at: Date.now(), ok });
  return ok;
}

/** Every map with a pack on this host, for the library's badges. */
export async function availableCs3dMaps() {
  const out = [];
  for (const m of CS3D_MAPS) {
    if (await hasCs3dPack(m.slug)) out.push({ slug: m.slug, code: m.code, name: m.name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// src/agents/packBase.js
// Where the trainer looks for the CS2 asset packs, and the two three.js addons
// it loads them with.
//
// The packs are the ones the 3D map explorer already ships — the agent models
// (`players/`) and the weapon world/view models (`weapons/`), built by
// `npm run cs3d:models` / `cs3d:weapons`. Nothing here builds or owns them;
// the trainer is a second reader of the same bytes.
//
// Two things this file exists to keep separate from `src/cs3d/`:
//
//   1. **The renderer.** The explorer runs on `three/webgpu`; the trainer runs
//      on the WebGL build and must keep doing so (its EffectComposer bloom has
//      no WebGPU path). So the loader addons come in through the
//      `?three-webgl` ids vite.config.js resolves to a second copy bound to
//      plain `three` — importing `src/cs3d/playerModels.js` here would drag
//      1.2 MB of a second three core into the trainer bundle.
//   2. **The asset base.** `src/cs3d/mapLoader.js` owns `assetBase()` and
//      imports `three/webgpu` at module scope, so it cannot be imported here
//      either. The three lines it would have given us are below, reading the
//      same two env vars, and `packFetch` (which is three-free) is reused
//      as-is — including its CDN retry and its shared rate-limit cooldown.
// ---------------------------------------------------------------------------

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js?three-webgl';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { packFetch, loadWithRetry, PACK_CDN } from '../cs3d/packFetch.js';

export { PACK_CDN };

/** Where the packs live: VITE_CS3D_ASSET_BASE, else the API host's /api/cs3d. */
export function packBase() {
  const explicit = import.meta.env?.VITE_CS3D_ASSET_BASE;
  if (explicit) return String(explicit).replace(/\/$/, '');
  return `${String(import.meta.env?.VITE_API_URL || '').replace(/\/$/, '')}/api/cs3d`;
}

/** A GLTFLoader wired for the packs' meshopt + quantized geometry. */
export function packLoader() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/**
 * Read a pack's manifest, falling back to the public bucket.
 *
 * Localhost 404s these routinely — Vite's dev middleware serves only what is
 * on disk and deliberately passes the shared packs through to the API host,
 * which may not be running. Returns `{ manifest, base }` so the caller fetches
 * the rest of the pack from wherever the manifest actually came from.
 */
export async function readManifest(slug, wanted, base = packBase()) {
  const tried = [];
  for (const root of [base, `${PACK_CDN}`]) {
    const url = `${root}/${slug}/manifest.json`;
    if (tried.includes(url)) continue;
    tried.push(url);
    let res = null;
    try {
      res = await packFetch(url, { cache: 'no-cache' });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const manifest = await res.json();
    if (wanted != null && manifest.version !== wanted) {
      throw new Error(`${slug} pack is v${manifest.version}; this build reads v${wanted}. Re-run the packer.`);
    }
    return { manifest, base: `${root}/${slug}` };
  }
  throw new Error(`no ${slug} pack (tried ${tried.join(', ')})`);
}

/** `?v=` stamp so a re-pack is never served from the browser cache. */
export function packVersionQuery(manifest) {
  return `?v=${encodeURIComponent(manifest?.generated || String(manifest?.version ?? 0))}`;
}

/** Load one glb out of a pack, with packFetch's retry behind it. */
export function loadGlb(loader, url) {
  return loadWithRetry(loader, url);
}

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
//      `?three-webgl` ids the build resolves to a second copy bound to
//      plain `three` — importing `src/cs3d/playerModels.js` here would drag
//      1.2 MB of a second three core into the trainer bundle.
//   2. **The asset base.** `src/cs3d/mapLoader.js` owns `assetBase()` and
//      imports `three/webgpu` at module scope, so it cannot be imported here
//      either. The three lines it would have given us are below, reading the
//      same env var, and `packFetch` (which is three-free) is reused as-is.
// ---------------------------------------------------------------------------

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js?three-webgl';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { packFetch, loadWithRetry } from '../cs3d/packFetch.js';

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
 * Read a pack's manifest from the local asset base.
 *
 * There is exactly one place to look now. The packs live on this machine
 * (server/data/cs3d/pack, served by the local API host); if one is not there
 * it is missing, and the error names the path that was tried rather than
 * quietly going out to a bucket to look for it.
 */
export async function readManifest(slug, wanted, base = packBase()) {
  const root = base;
  const url = `${root}/${slug}/manifest.json`;
  const res = await packFetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`no ${slug} pack (${res.status} from ${url}); run the packer, or copy one into server/data/cs3d/pack`);
  }
  const manifest = await res.json();
  if (wanted != null && manifest.version !== wanted) {
    throw new Error(`${slug} pack is v${manifest.version}; this build reads v${wanted}. Re-run the packer.`);
  }
  return { manifest, base: `${root}/${slug}` };
}

/** `?v=` stamp so a re-pack is never served from the browser cache. */
export function packVersionQuery(manifest) {
  return `?v=${encodeURIComponent(manifest?.generated || String(manifest?.version ?? 0))}`;
}

/** Load one glb out of a pack, with packFetch's retry behind it. */
export function loadGlb(loader, url) {
  return loadWithRetry(loader, url);
}

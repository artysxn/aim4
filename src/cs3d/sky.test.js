// ---------------------------------------------------------------------------
// src/cs3d/sky.test.js
// What the sky is measured to be, which is what the whole map's brightness and
// the colour of its haze are calibrated from.
//
// The bug this pins: a CS2 sky cube's BOTTOM face is not sky. It is a flat
// bright fill the game never shows, because the map and its 3D skybox cover
// the lower hemisphere — 3.88 on Anubis, 5.1 on Inferno, against skies whose
// median is around 0.4. measureSky used to average the horizon band across
// rows 0.4–0.6 of the image, so more than half of the fog's colour came out of
// that fill, and fog.js paints every distant surface with it. Anubis' haze
// landed at 2.9× white on a map whose fog strength is also multiplied by four.
//
// Run: node src/cs3d/sky.test.js
// ---------------------------------------------------------------------------

// three/webgpu reads `self` at module scope for GPUShaderStage. Nothing here
// touches the GPU, so a shim is enough to get the module graph to load.
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const assert = (await import('node:assert/strict')).default;
const fs = (await import('node:fs')).default;
const path = (await import('node:path')).default;
const { fileURLToPath } = await import('node:url');
const THREE = await import('three/webgpu');
const { measureSky } = await import('./sky.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * An equirect shaped like the real thing: a plain sky above the horizon and,
 * below it, the bright flat fill the cube's bottom face actually holds.
 *
 * @param {number} skyLevel     luminance of the sky above the horizon
 * @param {number} bottomLevel  luminance of the never-seen lower hemisphere
 * @param {number} [hazeLevel]  a hot band in the lowest 10% of visible sky,
 *                              which is what Anubis' desert haze is
 */
function fakeSky(skyLevel, bottomLevel, hazeLevel = skyLevel) {
  const w = 256;
  const h = 128;
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = y / h;
    let v;
    if (f >= 0.5) v = bottomLevel;
    else if (f >= 0.4) v = hazeLevel;
    else v = skyLevel;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 1;
    }
  }
  return { image: { data, width: w, height: h }, type: THREE.FloatType };
}

// ---- the lower hemisphere is never sampled ---------------------------------
// A sky of 0.4 with a bottom face of 100 must measure as a sky of 0.4. Before
// the fix the horizon band was over half bottom-face and came out above 50.
{
  const m = measureSky(fakeSky(0.4, 100));
  assert.ok(m, 'measureSky returned nothing for a valid texture');
  assert.ok(lum(...m.mean) < 0.5, `mean picked up the bottom face: ${lum(...m.mean)}`);
  assert.ok(m.p75 < 0.5, `p75 picked up the bottom face: ${m.p75}`);
  assert.ok(
    lum(m.horizon.r, m.horizon.g, m.horizon.b) < 0.5,
    `the fog's horizon colour picked up the bottom face: ${lum(m.horizon.r, m.horizon.g, m.horizon.b)}`
  );
  assert.ok(lum(m.zenith.r, m.zenith.g, m.zenith.b) < 0.5, 'zenith picked up the bottom face');
}

// ---- the bottom face's brightness changes nothing --------------------------
// The strongest form of the same claim: two skies identical above the horizon
// must measure identically, however different their unseen halves are.
{
  const dim = measureSky(fakeSky(0.4, 0.05));
  const nuclear = measureSky(fakeSky(0.4, 5.1));
  for (const k of ['mean', 'p75']) {
    const a = k === 'mean' ? lum(...dim.mean) : dim.p75;
    const b = k === 'mean' ? lum(...nuclear.mean) : nuclear.p75;
    assert.ok(Math.abs(a - b) < 1e-3, `${k} moved with the unseen bottom face: ${a} vs ${b}`);
  }
  const hDim = lum(dim.horizon.r, dim.horizon.g, dim.horizon.b);
  const hNuc = lum(nuclear.horizon.r, nuclear.horizon.g, nuclear.horizon.b);
  assert.ok(Math.abs(hDim - hNuc) < 1e-3, `fog colour moved with the unseen bottom face: ${hDim} vs ${hNuc}`);
}

// ---- p75 is robust to a hot band, a mean is not ----------------------------
// This is why the calibration anchor changed. A sky whose lowest visible tenth
// is four times its median must not have the whole sky dimmed to compensate.
{
  const plain = measureSky(fakeSky(0.4, 0.4));
  const hazy = measureSky(fakeSky(0.4, 3.9, 2.1));
  assert.ok(
    Math.abs(hazy.p75 - plain.p75) < 0.2,
    `p75 was dragged by the haze band: ${hazy.p75} vs ${plain.p75}`
  );
  assert.ok(lum(...hazy.mean) > lum(...plain.mean), 'sanity: the mean IS dragged, which is why p75 is used');
}

// ---- against the real packs, when they are present -------------------------
// The packs are gitignored, so this half only runs on a machine that has them.
const PACK = path.join(ROOT, 'server', 'data', 'cs3d', 'pack');
let checked = 0;
if (fs.existsSync(PACK)) {
  const { RGBELoader } = await import('three/examples/jsm/loaders/RGBELoader.js');
  for (const slug of fs.readdirSync(PACK)) {
    const mfp = path.join(PACK, slug, 'manifest.json');
    const hdr = path.join(PACK, slug, 'sky', 'sky.hdr');
    if (!fs.existsSync(mfp) || !fs.existsSync(hdr)) continue;
    const manifest = JSON.parse(fs.readFileSync(mfp, 'utf8'));
    if (!Array.isArray(manifest.groups)) continue;

    const parsed = new RGBELoader().parse(fs.readFileSync(hdr).buffer.slice(0));
    const m = measureSky({
      image: { data: parsed.data, width: parsed.width, height: parsed.height },
      type: parsed.type
    });
    assert.ok(m, `${slug}: measureSky returned nothing`);

    // Reproduce the calibration exactly (sky.js SKY_TARGET / SKY_GAIN_*) and
    // check where the haze colour lands on screen. Over 1.0 is white paint.
    const SKY_TARGET = 0.65;
    const lmap = manifest.lightmap;
    const brightness = Number.isFinite(manifest.sun?.brightness) ? manifest.sun.brightness : 3;
    const ambientLum = lmap?.p50 ? lmap.p50 : lmap?.mean ? lum(...lmap.mean) : Math.max(0.05, 0.11 * brightness);
    const bakedSun = !!manifest.shadowMask;
    const sunColor = manifest.sun?.color || [1, 0.94, 0.85];
    const sunBase = bakedSun
      ? Math.max(0.2, brightness)
      : lmap?.p90 && lmap?.p50
        ? Math.max(0.2, (Math.PI * (lmap.p90 - lmap.p50)) / 0.9)
        : Math.max(0.2, brightness);
    const brightLum = bakedSun
      ? (lmap?.p90 ?? ambientLum) + (sunBase * lum(...sunColor)) / Math.PI
      : lmap?.p98 && lmap?.p90
        ? Math.sqrt(lmap.p90 * lmap.p98)
        : (lmap?.p98 ?? sunBase / Math.PI + ambientLum);
    const exposure = Math.min(4, Math.max(0.15, 1.15 / (0.9 * brightLum)));
    let bg =
      (Number.isFinite(manifest.skyBrightness) ? manifest.skyBrightness : 1) *
      Math.pow(2, Number.isFinite(manifest.sky?.exposureBias) ? manifest.sky.exposureBias : 0);
    const gain = Math.min(6, Math.max(0.5, SKY_TARGET / Math.max(1e-4, exposure * bg * Math.max(1e-3, m.p75))));
    bg *= gain;

    const fogLum = lum(m.horizon.r, m.horizon.g, m.horizon.b) * exposure * bg;
    // 1.5 rather than 1.0: Anubis' sky genuinely is hot near the skyline and
    // its haze is meant to read bright. What is not allowed is the 2.9 the
    // bottom face used to put there.
    assert.ok(fogLum < 1.5, `${slug}: fog haze is ${fogLum.toFixed(2)}× white — the map will look washed out`);
    const skyLum = m.p75 * exposure * bg;
    assert.ok(
      skyLum > 0.3 && skyLum < 1.0,
      `${slug}: visible sky p75 lands at ${skyLum.toFixed(2)}; wanted roughly ${SKY_TARGET}`
    );
    checked++;
  }
}

console.log(`sky.test.js OK${checked ? ` (${checked} packed maps measured)` : ' (no local packs; synthetic cases only)'}`);

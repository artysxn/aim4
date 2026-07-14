// ---------------------------------------------------------------------------
// graphicsConfig.js — canonical snapshot/normalize for AIM4G graphics codes.
// Ensures skybox + bloom sub-configs round-trip with exact numeric values.
// ---------------------------------------------------------------------------

import { resolveTargetGlowConfig } from './targetGlowConfig.js';
import { resolveSkyboxGlowConfig } from './skyboxGlowConfig.js';

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Normalize a partial graphics payload into a complete, shareable snapshot. */
export function normalizeGraphicsConfig(src = {}, defaults = {}) {
  const c = src && typeof src === 'object' && !Array.isArray(src) ? src : {};
  const d = defaults && typeof defaults === 'object' ? defaults : {};

  return {
    colors: structuredClone(c.colors ?? d.colors ?? {}),
    targetGlow: c.targetGlow === true,
    targetGlowConfig: structuredClone(resolveTargetGlowConfig(c.targetGlowConfig)),
    customSkybox: c.customSkybox === true,
    skyboxId: typeof c.skyboxId === 'string' && c.skyboxId ? c.skyboxId : (d.skyboxId ?? ''),
    skyboxHue: num(c.skyboxHue, 0),
    skyboxSaturation: num(c.skyboxSaturation, 100),
    skyboxBrightness: num(c.skyboxBrightness, 100),
    skyboxContrast: num(c.skyboxContrast, 100),
    skyboxOpacity: num(c.skyboxOpacity, 100),
    skyboxHeightOffset: num(c.skyboxHeightOffset, 0),
    skyboxPostFx: c.skyboxPostFx !== false,
    skyboxGlowConfig: structuredClone(resolveSkyboxGlowConfig(c.skyboxGlowConfig))
  };
}

/** Bloom + skybox fields embedded in replay files / replay-view overlays. */
export function replayBloomSettingsFrom(src = {}, defaults = {}) {
  const n = normalizeGraphicsConfig(src, defaults);
  return {
    targetGlow: n.targetGlow,
    targetGlowConfig: n.targetGlowConfig,
    customSkybox: n.customSkybox,
    skyboxId: n.skyboxId,
    skyboxHue: n.skyboxHue,
    skyboxSaturation: n.skyboxSaturation,
    skyboxBrightness: n.skyboxBrightness,
    skyboxContrast: n.skyboxContrast,
    skyboxOpacity: n.skyboxOpacity,
    skyboxHeightOffset: n.skyboxHeightOffset,
    skyboxPostFx: n.skyboxPostFx,
    skyboxGlowConfig: n.skyboxGlowConfig
  };
}

// ---------------------------------------------------------------------------
// skyboxGlowConfig.js — defaults + merge helper for in-shader sky bloom.
// ---------------------------------------------------------------------------

export const SKYBOX_GLOW_DEFAULTS = {
  strength: 4,
  radius: 3,
  threshold: 0,
  thresholdSoft: 0.29,
  verticalFill: 1 // 0 = horizon only, 1 = full sky dome
};

export function resolveSkyboxGlowConfig(cfg) {
  return { ...SKYBOX_GLOW_DEFAULTS, ...(cfg || {}) };
}

// ---------------------------------------------------------------------------
// skyboxGlowConfig.js — defaults + merge helper for in-shader sky bloom.
// ---------------------------------------------------------------------------

export const SKYBOX_GLOW_DEFAULTS = {
  strength: 1.4, // additive glow intensity
  radius: 0.055, // cubemap sample spread for the blur
  threshold: 0.18, // luminance where glow begins
  thresholdSoft: 0.55 // luminance where glow reaches full strength
};

export function resolveSkyboxGlowConfig(cfg) {
  return { ...SKYBOX_GLOW_DEFAULTS, ...(cfg || {}) };
}

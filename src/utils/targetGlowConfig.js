// ---------------------------------------------------------------------------
// targetGlowConfig.js — defaults + merge helper for target bloom tuning.
// ---------------------------------------------------------------------------

export const TARGET_GLOW_DEFAULTS = {
  bloomStrength: 0.68,
  bloomRadius: 0.28,
  bloomLift: 2.1,
  compositeGain: 0.82,
  bloomGamma: 1.45,
  coreWhiteness: 0.82,
  coreIntensity: 1.35
};

export function resolveTargetGlowConfig(cfg) {
  return { ...TARGET_GLOW_DEFAULTS, ...(cfg || {}) };
}

// ---------------------------------------------------------------------------
// targetGlowConfig.js — defaults + merge helper for target bloom tuning.
// ---------------------------------------------------------------------------

export const TARGET_GLOW_DEFAULTS = {
  bloomStrength: 1.2,
  bloomRadius: 0.45,
  bloomLift: 2.5,
  compositeGain: 1.15,
  bloomGamma: 1.15,
  compositeThreshold: 0.008,
  coreWhiteness: 0.82,
  coreIntensity: 1.35
};

export function resolveTargetGlowConfig(cfg) {
  return { ...TARGET_GLOW_DEFAULTS, ...(cfg || {}) };
}

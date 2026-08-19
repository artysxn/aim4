/**
 * CS2 stores three bloom strengths on the post volume. `m_flScreenBloomStrength`
 * is a SCREEN blend after tonemap (Nuke 0.011, Mirage 0.13). `m_flBloomStrength`
 * is an ADD after tonemap (Inferno 0.12, Ancient 0.16) with a threshold that
 * can sit at 0.6. That threshold is correct for LDR and nuclear in linear HDR,
 * where the sky's mean is already ~1. Three's bloom() is the compute pass, so
 * an ADD with a sub-1 threshold uses computeStrength / computeThreshold instead.
 */
export function mapBloomParams(b) {
  if (!b) return { strength: 0, radius: 0, threshold: 1 };
  const screen = Number(b.screenStrength) || 0;
  const add = Number(b.strength) || 0;
  const compute = Number(b.computeStrength) || 0;
  const ldrThr = Number(b.threshold);
  const computeThr = Number(b.computeThreshold) || 1;
  const radius = Number(b.computeRadius) || 0;

  if (screen > 0) {
    return { strength: screen, radius, threshold: Math.max(1, ldrThr || 1) };
  }
  if (add > 0 && Number.isFinite(ldrThr) && ldrThr < 1) {
    return { strength: compute, radius, threshold: Math.max(1, computeThr) };
  }
  const strength = add || compute;
  const threshold = Math.max(1, Number.isFinite(ldrThr) ? ldrThr : computeThr);
  return { strength, radius, threshold };
}

/**
 * CS2 stores three bloom strengths on the post volume. `m_flScreenBloomStrength`
 * is a SCREEN blend after tonemap (Nuke 0.011, Mirage 0.13). `m_flBloomStrength`
 * is an ADD after tonemap (Inferno 0.12, Ancient 0.16) with a threshold that
 * can sit at 0.6. That threshold is correct for LDR and nuclear in linear HDR,
 * where the sky's mean is already ~1. Three's bloom() is the compute pass, so
 * an ADD with a sub-1 threshold uses computeStrength / computeThreshold instead.
 *
 * Even with that mapping, threshold 1 still blooms the sky. Ordinary lit stone
 * sits under 1; the desert haze on Anubis and the sun corona on Cache / Inferno
 * / Dust2 sit at 1.2–2.0; only the sun disc itself goes past ~3 (see FX_BLOOM
 * in look.js). Flooring the threshold at 2.5 keeps the disc and drops the haze.
 * Capping strength stops Mirage's 0.13 screen blend (a CS2 compositor number)
 * from being used as an HDR add.
 */
export const HDR_BLOOM_FLOOR = 2.5;
export const BLOOM_STRENGTH_CAP = 0.06;

export function mapBloomParams(b) {
  if (!b) return { strength: 0, radius: 0, threshold: 1 };
  const screen = Number(b.screenStrength) || 0;
  const add = Number(b.strength) || 0;
  const compute = Number(b.computeStrength) || 0;
  const ldrThr = Number(b.threshold);
  const computeThr = Number(b.computeThreshold) || 1;
  const radius = Number(b.computeRadius) || 0;
  const floor = (thr) => Math.max(HDR_BLOOM_FLOOR, thr);
  const cap = (s) => Math.min(BLOOM_STRENGTH_CAP, s);

  if (screen > 0) {
    return { strength: cap(screen), radius, threshold: floor(Math.max(1, ldrThr || 1)) };
  }
  if (add > 0 && Number.isFinite(ldrThr) && ldrThr < 1) {
    return { strength: cap(compute), radius, threshold: floor(Math.max(1, computeThr)) };
  }
  const strength = add || compute;
  const threshold = Math.max(1, Number.isFinite(ldrThr) ? ldrThr : computeThr);
  return { strength: cap(strength), radius, threshold: floor(threshold) };
}

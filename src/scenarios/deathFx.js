// Shared death feedback: red overlay + upward view flick.
import { degToRad } from '../utils/MathUtils.js';

export const DM_DEATH_FX_DUR = 0.35;
export const DM_DEATH_FX_PITCH = degToRad(38) * 0.25;
export const DUEL_DEATH_FX_DUR = 0.55;
export const DUEL_DEATH_FX_PITCH = degToRad(38);
/** Seconds to reach full aim punch — front-loaded so the flick feels instant. */
export const DEATH_FLICK_RISE = 0.1;

/**
 * Advance one death-FX frame. Returns overlay strength, pitch offset, and whether finished.
 */
export function updateDeathFxFrame(fx, dt, { duration, flickAmount, flickRise = DEATH_FLICK_RISE }) {
  fx.t += dt;
  const p = Math.min(1, fx.t / duration);
  let red;
  if (p < 0.15) red = p / 0.15;
  else if (p > 0.4) red = Math.max(0, 1 - (p - 0.4) / 0.6);
  else red = 1;

  const flickT = Math.min(1, fx.t / flickRise);
  const flick = flickAmount * (1 - (1 - flickT) ** 2);
  return { red, flick, done: fx.t >= duration };
}

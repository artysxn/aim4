// Shared full-screen red flash (Duels-style overlay, no camera kick).

export const MISS_FLASH_DUR = 0.55;

/** Start a red overlay flash; returns state object for updateMissFlash(). */
export function startMissFlash() {
  return { t: 0, duration: MISS_FLASH_DUR };
}

/** Advance flash timer; drives engine.setDeathOverlay. Returns true when finished. */
export function updateMissFlash(engine, fx, dt) {
  if (!fx) return true;
  fx.t += dt;
  const p = Math.min(1, fx.t / fx.duration);
  let red;
  if (p < 0.2) red = p / 0.2;
  else if (p > 0.5) red = 1 - (p - 0.5) / 0.5;
  else red = 1;
  engine.setDeathOverlay(red);
  if (fx.t >= fx.duration) {
    engine.setDeathOverlay(0);
    return true;
  }
  return false;
}

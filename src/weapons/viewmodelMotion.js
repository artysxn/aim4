// ---------------------------------------------------------------------------
// src/weapons/viewmodelMotion.js
// The three motions a CS viewmodel has, as arithmetic: the bob, the sway, and
// the clip names each action answers to.
//
// Split out of AgentViewmodel.js so it can be read and tested without a
// renderer — nothing here imports three or the pack. Every constant is the
// game's own cvar default and matches src/cs3d/viewModel.js, which documents
// where each came from at length. Change them together.
// ---------------------------------------------------------------------------

/**
 * `CBaseViewModel::CalcViewModelBob`, cvar defaults.
 *
 * Not a sine on a fixed frequency: the PERIOD comes from the weapon's max
 * speed, so a knife bobs faster than an AWP and the two look different at the
 * same running speed. The lateral bob runs at HALF the vertical's frequency,
 * which is what gives a figure-of-eight rather than an up-down bounce.
 */
export const BOB = Object.freeze({
  /** `cl_bobcycle`, `cl_bobup`: the period scale, and where the peak sits. */
  cycle: 0.98,
  up: 0.5,
  /** `cl_bobamt_vert` / `cl_bobamt_lat`. */
  vert: 0.25,
  lat: 0.4,
  /** `cl_bob_lower_amt`: how far the gun drops as the player speeds up. */
  lowerAmount: 21,
  /** Speed is clamped here and slewed at 640 u/s² so a stop does not snap. */
  maxSpeed: 320,
  slew: 640,
  /** Amplitude scale on the ground and in the air. */
  groundMul: 0.00625,
  airMul: 0.00125
});

/**
 * `CBaseViewModel::CalcViewModelLag`, the CS override.
 *
 * The shape that matters: the gun does not lag by the CURRENT turn rate, it
 * lags toward where the view was `interp` seconds ago. So a flick and a slow
 * pan of the same total angle produce completely different motion, and a turn
 * that stops leaves the gun still catching up — which a rate-based spring
 * cannot do at all.
 */
export const SWAY = Object.freeze({
  /** `cl_wpn_sway_interp`: seconds of history to look back over. */
  interp: 0.1,
  /** `cl_wpn_sway_scale`. */
  scale: 1.6
});

/** `cl_gunlowerangle` / `cl_gunlowerspeed`: the gun drops in the air. */
export const GUN_LOWER_ANGLE = 2;
export const GUN_LOWER_SPEED = 0.1;

/** `viewmodel_recoil`, 1 by default. */
export const VIEWMODEL_RECOIL = 1.0;

/** Clip names the runtime looks for, in preference order, per action. */
export const CLIP_ALIASES = Object.freeze({
  draw: ['draw', 'draw_silenced', 'deploy'],
  // Knives author `idle1`/`idle2` and no plain `idle`.
  idle: ['idle', 'idle1', 'idle2'],
  // The Dual Berettas fire one pistol at a time and have no `shoot1` at all.
  fire: ['shoot1', 'shoot', 'shoot_right1', 'shoot_left1', 'shoot_empty'],
  reload: ['reload', 'reload_empty']
});

/**
 * The bob's phase shape: a triangle in TIME run through a sine, with the peak
 * at `cl_bobup` through the cycle rather than the middle.
 *
 * A plain sine gets the rhythm but not the gait — the asymmetry is the weight
 * coming down faster than it goes up, and it is what makes the walk read as
 * footfalls instead of a float.
 */
export function bobShape(t, period) {
  if (!(period > 0)) return 0;
  let c = t - Math.floor(t / period) * period;
  c /= period;
  return c < BOB.up ? (Math.PI * c) / BOB.up : Math.PI + (Math.PI * (c - BOB.up)) / (1 - BOB.up);
}

/** The bob's period for a weapon's max speed, seconds: (1000 − maxSpeed) / 3.5 ms. */
export function bobPeriod(maxSpeed = 250) {
  return (((1000 - maxSpeed) / 3.5) * 0.001) * BOB.cycle;
}

/** Shortest signed difference between two angles, degrees. */
export function wrapDeg(d) {
  let x = d % 360;
  if (x > 180) x -= 360;
  else if (x < -180) x += 360;
  return x;
}

/**
 * The view angles at `when`, out of a flat [t, pitch, yaw, ...] ring.
 *
 * Linear between the two samples that straddle it; the newest pair if `when`
 * is past the end, which is what happens for the first tenth of a second.
 */
export function sampleAngles(log, when, pitch, yaw) {
  if (log.length < 6) return { pitch, yaw };
  if (when <= log[0]) return { pitch: log[1], yaw: log[2] };
  for (let i = log.length - 3; i >= 3; i -= 3) {
    if (log[i - 3] <= when && when <= log[i]) {
      const span = log[i] - log[i - 3];
      const f = span > 1e-6 ? (when - log[i - 3]) / span : 0;
      return {
        pitch: log[i - 2] + wrapDeg(log[i + 1] - log[i - 2]) * f,
        yaw: log[i - 1] + wrapDeg(log[i + 2] - log[i - 1]) * f
      };
    }
  }
  return { pitch, yaw };
}

/** Source `AngleVectors(...).forward`, roll 0, degrees in. */
export function forwardOf(pitchDeg, yawDeg) {
  const DEG = Math.PI / 180;
  const p = pitchDeg * DEG;
  const y = yawDeg * DEG;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
}

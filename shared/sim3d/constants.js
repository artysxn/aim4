// ---------------------------------------------------------------------------
// shared/sim3d/constants.js
// Every number the 3D movement sim believes, with its provenance attached.
//
// The provenance discipline (CS3D-ENGINE-PLAN): a constant is only as good as
// where it came from, and the difference must stay visible in the code.
//
//   docs      a published CS2 convar default. Right until proven wrong.
//   measured  confirmed against this repo's demo corpus by scripts/cs3d-oracle.mjs
//             — the value the recorded ticks actually obey.
//   fitted    not directly recorded; recovered by regression from the corpus.
//   guessed   carried over from CSGO or community lore. Assume wrong until the
//             CS2-server instrument (CounterStrikeSharp, later phase) measures it.
//
// Units: Source units and seconds, z-up (shared/sim3d/units.js owns the
// scene conversion; nothing in the sim ever sees three.js coordinates).
// All values pre-rounded to f32 so the sim never mixes precisions.
// ---------------------------------------------------------------------------

import { fr } from './fp.js';

export const TICK_RATE = 64;
/** 1/64 is exact in binary: no accumulation error from the timestep itself. */
export const TICK_DT = fr(1 / TICK_RATE);

// ---- gravity + jumping ----------------------------------------------------

/**
 * [measured] sv_gravity. Oracle 2026-08-16: 393,184 airborne arcs across the
 * corpus fit g = 800.14, MAD 3.8 — the ¼-unit noise floor, centered on 800.
 */
export const GRAVITY = fr(800);

/**
 * [measured] Jump launch velocity — and NOT CSGO's 301.993377. Two
 * independent, subtick-phase-immune estimators agree across 158k pro jumps:
 * apex rise is 55.50u (MAD 0.25), never 57, and the energy method on the
 * fitted arcs gives ~298. CS2 retuned jump height 57 → 55.5 and this is the
 * same formula at the new height: sqrt(2·800·55.5). Final confirmation of
 * the exact convar default belongs to the CS2-server instrument; the demos
 * bound it to 298.0 ± 0.7.
 */
export const JUMP_IMPULSE = fr(Math.sqrt(2 * 800 * 55.5));

/**
 * [docs] Upward speed above which CategorizePosition refuses to glue the
 * player to the ground (NON_JUMP_VELOCITY): rising faster than this means
 * "left the ground on purpose".
 */
export const NON_JUMP_VELOCITY = fr(140);

// ---- ground movement ------------------------------------------------------

/**
 * [docs] sv_accelerate. The oracle's counter-strafe brake distribution
 * (D ≈ a·runSpeed) is consistent with 5.5 but wide; demos cannot pin it
 * because brake onset is hidden input. Server instrument confirms.
 */
export const ACCEL = fr(5.5);

/**
 * [docs] sv_friction. NOT demo-measurable: pro stops are counter-strafes,
 * and the brake's unknown onset tick is degenerate with f in every stop
 * curve (the oracle prints this caveat with its fit). Server instrument.
 */
export const FRICTION = fr(5.2);

/** [docs] sv_stopspeed — the kink where the stop turns crisp. */
export const STOP_SPEED = fr(80);

/** [docs] Per-axis velocity clamp, sv_maxvelocity. */
export const MAX_VELOCITY = fr(3500);

/** [docs] A surface is walkable ground when its normal.z is at least this. */
export const GROUND_NORMAL_MIN = fr(0.7);

// ---- air movement ---------------------------------------------------------

/** [measured] sv_airaccelerate. */
export const AIR_ACCEL = fr(12);

/** [measured] sv_air_max_wishspeed — the 30 u/s cap that shapes air-strafe. */
export const AIR_SPEED_CAP = fr(30);

// ---- speed modifiers ------------------------------------------------------
// Weapon run speeds themselves live in shared/sim/weapons.js (WEAPON_SIM);
// these are the multipliers CS2 stacks on top of the active weapon's speed.

/**
 * [docs] Ducked speed cap as a fraction of weapon run speed (215 → 73.1).
 * This corpus can't check it — its rounds predate the duck flag — so the
 * duck plateau stays unverified until a reparse or the server instrument.
 */
export const DUCK_SPEED_SCALE = fr(0.34);

/**
 * [measured] Shift slow-walk fraction. Oracle: every weapon's walk mode
 * sits at 0.52 of its run mode across the corpus (ak 111.8/215, knife
 * 130/250, awp 104/200, …).
 */
export const WALK_SPEED_SCALE = fr(0.52);

// ---- hull -----------------------------------------------------------------
// Same numbers as units.js HULL; restated here in f32 because the sim traces
// with them every tick. Origin is at the FEET (bottom-center), like CS2.

export const HULL_HALF_WIDE = fr(16);
export const HULL_STAND = fr(72);
export const HULL_DUCK = fr(54);
export const EYE_STAND = fr(64.06);
export const EYE_DUCK = fr(46.04);
export const STEP_HEIGHT = fr(18);

// ---- ducking --------------------------------------------------------------
// CS2's duck is a state machine: duck amount travels along a duck-speed that
// is itself state, decays under repeated crouches (2023 crouch fatigue) and
// recovers over time; unduck retries against headroom. NONE of that is
// recoverable from demos (FLAG_DUCKING is one bit per tick) or from any
// .vdata — the constants live in the game binary. Everything below is
// therefore [guessed] and quarantined behind DUCK: the sim treats duck as an
// instant hull/speed change until the server instrument measures the curve.

export const DUCK = Object.freeze({
  /** [guessed] seconds to fully duck at full duck speed (CSGO lineage). */
  TIME_TO_DUCK: fr(0.22),
  /** [guessed] seconds to fully unduck. */
  TIME_TO_UNDUCK: fr(0.28),
  /** [guessed] resting duck speed (m_flDuckSpeed default). */
  SPEED_DEFAULT: fr(8),
  /** [guessed] fatigue floor / recovery — placeholders, shape unknown. */
  SPEED_MIN: fr(2),
  RECOVERY_PER_SEC: fr(3)
});

// ---- stamina --------------------------------------------------------------
// CS2 kept jump/land fatigue. The shape is measurable from the corpus
// (successive bhop takeoff Δz ratios) but not yet measured, so the sim ships
// with it OFF; turning it on before the oracle confirms the curve would make
// jump chains wrong in a new way instead of wrong in a known way.

export const STAMINA = Object.freeze({
  ENABLED: false,
  /** [guessed] sv_staminamax lineage. */
  MAX: fr(80),
  /** [guessed] sv_staminajumpcost. */
  JUMP_COST: fr(0.08),
  /** [guessed] sv_staminalandcost. */
  LAND_COST: fr(0.05),
  /** [guessed] sv_staminarecoveryrate, per second. */
  RECOVERY_RATE: fr(60)
});

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
 * [docs] sv_jump_impulse. Leak default "301.993377" = sqrt(2*800*57).
 * Shared with jumpthrow inherit so walk jump and nade takeoff use one number.
 */
export const JUMP_IMPULSE = fr(301.993377);

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

/** [docs] CS_PLAYER_SPEED_DUCK_MODIFIER (cs_shareddefs). */
export const DUCK_SPEED_SCALE = fr(0.34);

/** [docs] CS_PLAYER_SPEED_WALK_MODIFIER. */
export const WALK_SPEED_SCALE = fr(0.52);

/** [docs] CS_PLAYER_SPEED_CLIMB_MODIFIER. */
export const CLIMB_MODIFIER = fr(0.34);

/** [docs] Hardcoded 250 in CCSGameMovement::Accelerate / sv_accelerate_use_weapon_speed. */
export const ACCEL_SPEED_REF = fr(250);

/** [docs] sv_accelerate_use_weapon_speed default. */
export const ACCELERATE_USE_WEAPON_SPEED = true;

/** [docs] Only cap walk once current speed is this close to the walk cap. */
export const WALK_DELAY_CAP_SLACK = fr(25);

/** [docs] sv_enablebunnyhopping 0 → crop to this × maxspeed before jump. */
export const BUNNYJUMP_MAX_SPEED_FACTOR = fr(1.1);

/** [docs] Ground velocity-modifier recovery (1/2.5 per second toward 1). */
export const VELOCITY_MODIFIER_RECOVERY = fr(1 / 2.5);

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
// CCSGameMovement::Duck / CheckParameters (cstrike15 leak).

export const DUCK = Object.freeze({
  /** [docs] CS_PLAYER_DUCK_SPEED_IDEAL. */
  SPEED_IDEAL: fr(8),
  /** [docs] Duck-in approaches at duckSpeed * 0.8. */
  IN_SCALE: fr(0.8),
  /** [docs] Unduck floor so semi-duck cannot linger. */
  UNDUCK_MIN_SPEED: fr(1.5),
  /** [docs] DuckingEnabled false below this duckSpeed. */
  ENABLED_MIN_SPEED: fr(1.5),
  /** [docs] sv_timebetweenducks. */
  TIME_BETWEEN: fr(0.4),
  /** [docs] get_sv_crouch_spam_penalty on press/release. */
  SPAM_PENALTY: fr(2),
  /** [docs] Approach toward ideal, per second. */
  RECOVERY_PER_SEC: fr(3),
  /** [docs] Extra recover when >64u from last full-speed crouch pos. */
  EXTRA_RECOVERY_PER_SEC: fr(6),
  /** [docs] Distance (units) that unlocks the extra recover. */
  EXTRA_RECOVERY_DIST: fr(64)
});

// ---- stamina --------------------------------------------------------------
// CCSGameMovement CheckParameters / ReduceTimers / OnJump / OnLand.

export const STAMINA = Object.freeze({
  /** [docs] STAMINA_RANGE: the divisor of the speed/jump scale. */
  RANGE: fr(100),
  /** [docs] sv_staminamax. */
  MAX: fr(80),
  /** [docs] sv_staminajumpcost. */
  JUMP_COST: fr(0.08),
  /** [docs] sv_staminalandcost. */
  LAND_COST: fr(0.05),
  /** [docs] sv_staminarecoveryrate, per second. */
  RECOVERY_RATE: fr(60)
});

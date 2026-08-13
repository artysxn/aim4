// ---------------------------------------------------------------------------
// shared/sim/constants.js
// Every frozen number the simulation runs on, in one file, behind one version.
//
// Three rules govern this file and none of them are negotiable:
//
//  1. RULES_VERSION is stamped into every match record. Game updates change
//     prices and speeds; a stored round is only interpretable against the rules
//     it ran under, so a bump here is a bump there (SIM-PLAN 14.34).
//  2. Everything is in SOURCE UNITS and SECONDS. The map data, the tick format,
//     the spawn points, and the duel model are all in units. SourceMovement.js
//     works in metres because the trainer's world is metric; converting per tick
//     inside the sim would be the exact train/serve skew this project exists to
//     avoid. movement2d.test.js proves the two agree.
//  3. A number that has not been checked against the game carries [verify], and
//     [verify] means "do not trust this in a calibration run". They are cheap to
//     leave in and expensive to leave out.
//
// DOM-free. Imported by the browser, the node server, and the trainer.
// ---------------------------------------------------------------------------

/** Bump whenever any number below changes. Recorded in every match config. */
export const RULES_VERSION = 1;

// ---------------------------------------------------------------------------
// Tick model (4.1)
// ---------------------------------------------------------------------------

/** Engine ticks per second. Fixed. There is no variable timestep anywhere. */
export const TICK_RATE = 64;
/** Seconds per tick, as a constant so nobody recomputes it in a hot loop. */
export const TICK_DT = 1 / TICK_RATE;
/** Decisions run at 8 Hz: one policy step every 8 engine ticks (6.3). */
export const DECISION_EVERY_TICKS = 8;
/** The aim motor runs faster than decisions and slower than physics (8.1). */
export const MOTOR_EVERY_TICKS = 1;

// ---------------------------------------------------------------------------
// Movement (4.4). Rates are dimensionless; speeds are units/second.
// ---------------------------------------------------------------------------

export const SV_ACCELERATE = 5.5;
export const SV_FRICTION = 5.2;
/** sv_stopspeed, in units/s. Below this, friction bites at a fixed rate. */
export const SV_STOPSPEED = 80;

/** Player collision disc, matching the creator's body exactly. */
export const BODY_RADIUS = 16;

/** Walk (shift) and crouch caps as a fraction of the weapon's run speed. */
export const WALK_FACTOR = 112 / 215;
export const CROUCH_FACTOR = 73 / 215;

/**
 * Per-weapon run speed in units/s, keyed by `bareWeapon()` stem so it lines up
 * with weaponTable.js without a second normalization pass. `[verify all]`
 */
export const WEAPON_SPEED = Object.freeze({
  knife: 250,
  taser: 220,

  // Pistols
  glock: 240,
  hkp2000: 240,
  usp_silencer: 240,
  p250: 240,
  elite: 240,
  fiveseven: 240,
  tec9: 240,
  cz75a: 240,
  revolver: 220,
  deagle: 230,

  // SMGs
  mac10: 240,
  ump45: 230,
  mp9: 240,
  bizon: 240,
  mp7: 220,
  mp5sd: 235,
  p90: 230,

  // Shotguns
  nova: 220,
  sawedoff: 210,
  mag7: 225,
  xm1014: 215,

  // Rifles
  galilar: 215,
  famas: 220,
  ak47: 215,
  m4a1_silencer: 225,
  sg556: 210,
  m4a1: 225,
  aug: 220,

  // Snipers
  ssg08: 230,
  awp: 200,
  g3sg1: 215,
  scar20: 215,

  // LMGs
  negev: 150,
  m249: 195
});

/** Fallback when a weapon is missing from the table above. */
export const DEFAULT_WEAPON_SPEED = 215;

/** Scoped snipers move at a crawl. `[verify]` */
export const SCOPED_SPEED = Object.freeze({ awp: 100, ssg08: 120, g3sg1: 120, scar20: 120 });

/**
 * Tagging: a bullet multiplies current speed and the slow decays back over
 * TAG_RECOVER_SECONDS. It matters enormously for exit frags and for running a
 * crossfire, so it is in v1 rather than deferred. `[verify exact curve]`
 */
export const TAG_SPEED_FACTOR = 0.5;
export const TAG_RECOVER_SECONDS = 0.5;

/**
 * Counter-strafe braking window, lifted from SourceMover1D.seek: press the
 * opposite direction once the remaining distance is under |v| * this. Bots
 * therefore stop like players rather than like a lerp.
 */
export const COUNTER_STRAFE_LOOKAHEAD = 0.16;

/** Ladders and other painted slow edges traverse at a fixed speed. */
export const LADDER_SPEED = 100;

// ---------------------------------------------------------------------------
// Round and match (4.6). Seconds.
// ---------------------------------------------------------------------------

export const FREEZE_SECONDS = 15;
export const ROUND_SECONDS = 115;
export const BOMB_SECONDS = 40;
export const PLANT_SECONDS = 3.2;
export const DEFUSE_SECONDS = 10;
export const DEFUSE_SECONDS_KIT = 5;
export const BUY_SECONDS = 20;

/** MR12: first to 13, halftime after 12, overtime MR3 at $10,000. */
export const ROUNDS_PER_HALF = 12;
export const ROUNDS_TO_WIN = 13;
export const OT_ROUNDS_PER_HALF = 3;
export const OT_START_MONEY = 10000;

// ---------------------------------------------------------------------------
// Utility (4.8). One value each, because the repo currently disagrees with
// itself on smoke duration (18 s in roundFacts, 22 s in utilityMarkers) and a
// simulation cannot hold two.
// ---------------------------------------------------------------------------

export const SMOKE_RADIUS = 144;
export const SMOKE_SECONDS = 20;
export const FIRE_RADIUS = 120;
export const FIRE_SECONDS = 7;
export const FIRE_DPS = 40; // `[verify]`
export const FIRE_IGNITE_DELAY = 0.3;
export const HE_MAX_DAMAGE = 98; // `[verify]`
export const HE_FALLOFF_RADIUS = 350;
export const FLASH_MAX_SECONDS = 4.9; // `[verify curve]`
export const MAX_GRENADES = 4;
export const MAX_FLASHES = 2;

/** A bot whose eyes carry more than this many flash seconds cannot see. */
export const FLASH_VISION_BLIND = 0.5;

/**
 * Ad-hoc reactive throws (4.8): a straight line, capped range, fixed fuse.
 * Mined lineups replace these for set executes; a molly at the feet and a
 * pop flash around a corner do not need a lineup and use this instead.
 */
export const ADHOC_THROW_SPEED = 300;
export const ADHOC_THROW_MAX = 900;
export const ADHOC_FUSE_SECONDS = 1.6;

/** How close a defuser must stand to the bomb, in units. `[verify]` */
export const DEFUSE_RADIUS = 62;
/** How close a T must walk to a dropped bomb to pick it up. `[verify]` */
export const BOMB_PICKUP_RADIUS = 48;

// ---------------------------------------------------------------------------
// Sound (4.7). Audible radii in units, measured along the nav lattice rather
// than as the crow flies, so sound does not cross solid walls. `[tune]`
// ---------------------------------------------------------------------------

export const SOUND_RADIUS = Object.freeze({
  footstep: 1100,
  landing: 1400,
  gunshot: 4000,
  gunshotSilenced: 1400,
  reload: 500,
  grenade: 800,
  plant: 1200,
  defuseKit: 1200
});

/** A running body emits a step every this many units of travel. */
export const FOOTSTEP_DISTANCE = 140;
/** Below this fraction of the weapon's run speed, running emits nothing. */
export const FOOTSTEP_SPEED_FRACTION = 0.34;

// ---------------------------------------------------------------------------
// Knowledge and comms (5.1, 5.7)
// ---------------------------------------------------------------------------

/** Team POV's contact hold, reused verbatim so the viewer cannot disagree. */
export const POV_MEMORY_SECONDS = 0.75;
/** Every call and relayed sound percept is delayed by a draw from this range. */
export const COMM_DELAY_MIN = 0.5;
export const COMM_DELAY_MAX = 1.5;

// ---------------------------------------------------------------------------
// Derived helpers. Small enough to live with the numbers they read.
// ---------------------------------------------------------------------------

/** Ticks for a duration in seconds, rounded to the nearest whole tick. */
export function ticksFor(seconds) {
  return Math.round(seconds * TICK_RATE);
}

/**
 * Run speed for a weapon, in units/s.
 * @param {string} weapon `bareWeapon()` stem
 * @param {boolean} [scoped]
 */
export function runSpeedFor(weapon, scoped = false) {
  if (scoped && SCOPED_SPEED[weapon] != null) return SCOPED_SPEED[weapon];
  return WEAPON_SPEED[weapon] ?? DEFAULT_WEAPON_SPEED;
}

/**
 * Speed cap for a weapon under a gait and stance, in units/s. Crouch wins over
 * walk because a crouch-walking player is slower than a shift-walking one.
 *
 * @param {string} weapon
 * @param {'run'|'walk'|'crouchwalk'} gait
 * @param {{scoped?: boolean}} [opts]
 */
export function speedCap(weapon, gait, opts = {}) {
  const base = runSpeedFor(weapon, opts.scoped);
  if (gait === 'crouchwalk') return base * CROUCH_FACTOR;
  if (gait === 'walk') return base * WALK_FACTOR;
  return base;
}

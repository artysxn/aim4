// ---------------------------------------------------------------------------
// shared/entitlements/catalogue.js
// The capability catalogue: what every plan can do, as plain data.
//
// Imported by both the browser bundle and the Node server, so this file has no
// imports of its own and touches neither `window` nor `process`. It is the one
// place a plan's abilities are written down. Feature code never compares tier
// names; it asks for a capability key and gets a value back.
//
// Four value shapes:
//   bool   has it or does not
//   limit  integer cap, -1 meaning unlimited, 0 meaning none
//   quota  uses per rolling 24h, -1 unlimited, 0 unavailable
//   enum   a named mode, ordered weakest to strongest in `order`
// ---------------------------------------------------------------------------

/** @typedef {'bool'|'limit'|'quota'|'enum'} Shape */

export const BOOL = 'bool';
export const LIMIT = 'limit';
export const QUOTA = 'quota';
export const ENUM = 'enum';

/** Unlimited, for limit and quota shapes. Reads better than a bare -1. */
export const UNLIMITED = -1;

export const PLAN_IDS = Object.freeze(['free', 'premium', 'team_premium', 'team_elite']);

/**
 * Rank drives every merge in resolve.js. Gaps of 10 leave room for a plan
 * between two existing ones without renumbering rows that are already in the
 * database.
 */
export const PLAN_RANKS = Object.freeze({
  free: 0,
  premium: 10,
  team_premium: 20,
  team_elite: 30
});

export const PLAN_NAMES = Object.freeze({
  free: 'Free',
  premium: 'Premium',
  team_premium: 'Team Premium',
  team_elite: 'Team Elite'
});

/** Seats a plan may lend out, and teams it may create. Mirrors plans table. */
export const PLAN_CAPACITY = Object.freeze({
  free: { seat_capacity: 0, team_capacity: 0 },
  premium: { seat_capacity: 1, team_capacity: 0 },
  team_premium: { seat_capacity: 7, team_capacity: 1 },
  team_elite: { seat_capacity: 14, team_capacity: 2 }
});

/**
 * Enum ladders, weakest first. Used both to merge two enum values and to hand
 * an admin the strongest one.
 */
const DRAWING_BOARD_MODES = Object.freeze(['none', 'nosave', 'limited', 'full']);
const AIM_REPLAY_MODES = Object.freeze(['none', 'best_and_recent', 'best_plus_10', 'full']);
const COSMETIC_MODES = Object.freeze(['none', 'presets', 'full']);

/**
 * The catalogue itself.
 *
 * `label` is user-facing: it appears in the 402 upgrade message and in locked
 * UI, so it follows the copy rules in CLAUDE.md (no em dashes, no filler).
 * `scope: 'per_map'` means the limit counts per map rather than per account,
 * which the enforcement layer needs in order to count the right rows.
 */
export const CAPABILITIES = Object.freeze({
  // --- Demos -------------------------------------------------------------
  'demos.ads_free': {
    shape: BOOL,
    label: 'Ad-free viewing',
    values: { free: false, premium: true, team_premium: true, team_elite: true }
  },
  'demos.full_recent_access': {
    shape: BOOL,
    label: 'Full access to recent demos',
    // Free accounts see only the first half of demos under a month old.
    values: { free: false, premium: true, team_premium: true, team_elite: true }
  },
  'demos.viewer': {
    shape: BOOL,
    label: 'Demo viewer',
    values: { free: true, premium: true, team_premium: true, team_elite: true }
  },
  'demos.macro_viewer': {
    shape: QUOTA,
    label: 'Macro viewer',
    values: { free: 1, premium: UNLIMITED, team_premium: UNLIMITED, team_elite: UNLIMITED }
  },
  'demos.upload_limit': {
    shape: LIMIT,
    label: 'Demo uploads',
    values: { free: 3, premium: 50, team_premium: UNLIMITED, team_elite: UNLIMITED }
  },
  'demos.map_control': {
    shape: QUOTA,
    label: 'Map control',
    values: { free: 0, premium: 0, team_premium: 1, team_elite: UNLIMITED }
  },
  'demos.round_win_prediction': {
    shape: QUOTA,
    label: 'Round win prediction',
    values: { free: 0, premium: 0, team_premium: 1, team_elite: UNLIMITED }
  },
  'demos.duel_win_prediction': {
    shape: QUOTA,
    label: 'Duel win prediction',
    values: { free: 0, premium: 0, team_premium: 1, team_elite: UNLIMITED }
  },
  'demos.auto_coach': {
    shape: QUOTA,
    label: 'Auto coach',
    values: { free: 1, premium: 4, team_premium: UNLIMITED, team_elite: UNLIMITED }
  },
  'demos.teamspeak_sync': {
    shape: BOOL,
    label: 'TeamSpeak sync',
    values: { free: false, premium: false, team_premium: false, team_elite: true }
  },
  'demos.comms_coach': {
    shape: BOOL,
    label: 'Comms coach',
    values: { free: false, premium: false, team_premium: false, team_elite: true }
  },
  drawing_board: {
    shape: ENUM,
    label: 'Drawing board',
    order: DRAWING_BOARD_MODES,
    // 'limited' is 5 saved drawings per map; the count lives in DRAWING_BOARD_CAP.
    values: { free: 'none', premium: 'nosave', team_premium: 'limited', team_elite: 'full' }
  },

  // --- Stats and analytics -----------------------------------------------
  'stats.single_game': {
    shape: BOOL,
    label: 'Single game stats',
    values: { free: false, premium: false, team_premium: true, team_elite: true }
  },
  'stats.team_statistics': {
    shape: BOOL,
    label: 'Team statistics',
    values: { free: false, premium: false, team_premium: true, team_elite: true }
  },
  'stats.metrics_player_full': {
    shape: BOOL,
    label: 'Full player metrics',
    // PSDT, DT, Accuracy.
    values: { free: false, premium: true, team_premium: true, team_elite: true }
  },
  'stats.metrics_team_full': {
    shape: BOOL,
    label: 'Full team metrics',
    // PRW, Poss%.
    values: { free: false, premium: false, team_premium: false, team_elite: true }
  },
  'stats.filters_full': {
    shape: BOOL,
    label: 'All filters',
    values: { free: false, premium: true, team_premium: true, team_elite: true }
  },
  'analytics.charts': {
    shape: QUOTA,
    label: 'Charts',
    // Free is also restricted to limited controls, gated by stats.filters_full.
    values: { free: 3, premium: UNLIMITED, team_premium: UNLIMITED, team_elite: UNLIMITED }
  },
  'analytics.pattern_finder': {
    shape: QUOTA,
    label: 'Pattern finder',
    values: { free: 3, premium: UNLIMITED, team_premium: UNLIMITED, team_elite: UNLIMITED }
  },

  // --- Teams --------------------------------------------------------------
  'team.create_limit': {
    shape: LIMIT,
    label: 'Teams',
    values: { free: 0, premium: 0, team_premium: 1, team_elite: 2 }
  },
  'team.join': {
    shape: BOOL,
    label: 'Joining a team',
    values: { free: false, premium: true, team_premium: true, team_elite: true }
  },
  'team.seat_capacity': {
    shape: LIMIT,
    label: 'Seats',
    // Per subscription, not per team. Elite's 14 is pooled across its 2 teams.
    values: { free: 0, premium: 1, team_premium: 7, team_elite: 14 }
  },
  'team.documents': {
    shape: LIMIT,
    label: 'Documents',
    values: { free: 0, premium: 10, team_premium: 10, team_elite: UNLIMITED }
  },
  'team.roles_positions': {
    shape: BOOL,
    label: 'Roles and positions',
    values: { free: false, premium: true, team_premium: true, team_elite: true }
  },
  'team.stratbook_access': {
    shape: BOOL,
    label: 'Stratbook',
    values: { free: false, premium: true, team_premium: true, team_elite: true }
  },
  'team.stratbook_limit': {
    shape: LIMIT,
    label: 'Strategies per map',
    scope: 'per_map',
    values: { free: 0, premium: 40, team_premium: 40, team_elite: UNLIMITED }
  },
  'team.utility_archive': {
    shape: LIMIT,
    label: 'Utility per map',
    scope: 'per_map',
    values: { free: 0, premium: 50, team_premium: 50, team_elite: UNLIMITED }
  },
  'team.strategy_creator_2d': {
    shape: LIMIT,
    label: '2D strategies per map',
    scope: 'per_map',
    values: { free: 0, premium: 2, team_premium: 2, team_elite: UNLIMITED }
  },
  'team.auto_round_winrates': {
    shape: BOOL,
    label: 'Automatic round winrates',
    values: { free: false, premium: false, team_premium: false, team_elite: true }
  },

  // --- Aim trainer --------------------------------------------------------
  'aim.trainer': {
    shape: BOOL,
    label: 'Aim trainer',
    values: { free: true, premium: true, team_premium: true, team_elite: true }
  },
  'aim.routines': {
    shape: BOOL,
    label: 'Routines',
    values: { free: true, premium: true, team_premium: true, team_elite: true }
  },
  'aim.advanced_analytics': {
    shape: BOOL,
    label: 'Advanced analytics',
    values: { free: false, premium: true, team_premium: true, team_elite: true }
  },
  'aim.replays': {
    shape: ENUM,
    label: 'Aim replays',
    order: AIM_REPLAY_MODES,
    values: {
      free: 'none',
      premium: 'best_and_recent',
      team_premium: 'best_plus_10',
      team_elite: 'full'
    }
  },
  'aim.custom_routines': {
    shape: LIMIT,
    label: 'Custom routines',
    values: { free: 0, premium: 3, team_premium: 10, team_elite: UNLIMITED }
  },
  'aim.cosmetics': {
    shape: ENUM,
    label: 'Cosmetics',
    order: COSMETIC_MODES,
    values: { free: 'none', premium: 'presets', team_premium: 'presets', team_elite: 'full' }
  }
});

/** Saved drawings per map when `drawing_board` resolves to 'limited'. */
export const DRAWING_BOARD_CAP = 5;

export const CAPABILITY_KEYS = Object.freeze(Object.keys(CAPABILITIES));

/**
 * True when a key exists. Typos are the main failure mode of a string-keyed
 * system, so every entry point checks rather than silently returning undefined.
 */
export function isCapability(key) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, key);
}

export function capabilityDef(key) {
  const def = CAPABILITIES[key];
  if (!def) throw new Error(`Unknown capability: ${key}`);
  return def;
}

/** The capability map for a single plan, e.g. what gets seeded into plans.capabilities. */
export function capabilitiesForPlan(planId) {
  if (!PLAN_IDS.includes(planId)) throw new Error(`Unknown plan: ${planId}`);
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of CAPABILITY_KEYS) out[key] = CAPABILITIES[key].values[planId];
  return out;
}

/** The strongest possible value for a capability. Used for the admin override. */
export function maxValue(key) {
  const def = capabilityDef(key);
  switch (def.shape) {
    case BOOL:
      return true;
    case LIMIT:
    case QUOTA:
      return UNLIMITED;
    case ENUM:
      return def.order[def.order.length - 1];
    default:
      throw new Error(`Unknown shape for ${key}: ${def.shape}`);
  }
}

/** Every capability at its strongest. The admin's resolved capability map. */
export function unlimitedCapabilities() {
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of CAPABILITY_KEYS) out[key] = maxValue(key);
  return out;
}

/**
 * Order two values of the same capability. Returns a negative number when `a`
 * is weaker than `b`, 0 when equal, positive when stronger.
 *
 * Unlimited (-1) is the strongest limit/quota value, which is the one place a
 * plain numeric compare gets the wrong answer.
 */
export function compareValues(key, a, b) {
  const def = capabilityDef(key);
  switch (def.shape) {
    case BOOL:
      return Number(Boolean(a)) - Number(Boolean(b));
    case LIMIT:
    case QUOTA: {
      const rank = (v) => (Number(v) === UNLIMITED ? Number.POSITIVE_INFINITY : Number(v) || 0);
      const ra = rank(a);
      const rb = rank(b);
      return ra === rb ? 0 : ra < rb ? -1 : 1;
    }
    case ENUM: {
      const ia = def.order.indexOf(a);
      const ib = def.order.indexOf(b);
      return ia - ib;
    }
    default:
      throw new Error(`Unknown shape for ${key}: ${def.shape}`);
  }
}

/** True when a resolved value means "you may do this at all". */
export function isEnabled(key, value) {
  const def = capabilityDef(key);
  switch (def.shape) {
    case BOOL:
      return value === true;
    case LIMIT:
    case QUOTA:
      return Number(value) === UNLIMITED || Number(value) > 0;
    case ENUM:
      return value != null && value !== def.order[0];
    default:
      return false;
  }
}

/**
 * The cheapest plan that enables a capability, so a 402 can name the tier the
 * user actually needs instead of always pointing at the most expensive one.
 * Null when no plan offers it.
 */
export function requiredPlanFor(key, value = undefined) {
  const def = capabilityDef(key);
  for (const planId of PLAN_IDS) {
    const planValue = def.values[planId];
    if (value === undefined ? isEnabled(key, planValue) : compareValues(key, planValue, value) >= 0) {
      return planId;
    }
  }
  return null;
}

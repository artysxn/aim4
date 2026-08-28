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
//
// ---------------------------------------------------------------------------
// The shape of the ladder
// ---------------------------------------------------------------------------
// Two ladders, one product. A team plan is the solo plan of the same band plus
// everything that only makes sense with a roster behind it. Four bands:
//
//   FREE    the trial of the product. Basics, no models.
//   LOW     solo_lite / team_tier3.  Every basic paid feature without limits,
//           and one use a day of the expensive ones.
//   MIDDLE  solo_premium / team_tier2. Three times the daily allowance, or
//           unlimited-but-capped where the feature is not metered.
//   HIGH    solo_elite / team_tier1.  Everything, unrestricted.
//
// "One a day" is deliberately one a day *for the whole subscription*, not one
// per seat: quota subjects resolve to the subscription that granted the
// capability (see resolve.js quotaSubjects), so a seven-seat Tier 3 team gets
// one anti-strat a day between them, not seven.
//
// Solo plans never carry the team keys (`team.*`, anti-strat, comms). That is
// the whole of the difference between the two ladders, and it is why a Tier 1
// team costs a multiple of a Solo Elite rather than the same money.
// ---------------------------------------------------------------------------

/** @typedef {'bool'|'limit'|'quota'|'enum'} Shape */

export const BOOL = 'bool';
export const LIMIT = 'limit';
export const QUOTA = 'quota';
export const ENUM = 'enum';

/** Unlimited, for limit and quota shapes. Reads better than a bare -1. */
export const UNLIMITED = -1;

/**
 * Ordered weakest to strongest, and that order is load-bearing:
 * `requiredPlanFor` walks this array and returns the FIRST plan that satisfies
 * a capability, so a 402 names the cheapest plan that unlocks the feature
 * rather than the most expensive one. The array is therefore in ascending
 * price order, which puts `team_tier1` last despite its name.
 */
export const PLAN_IDS = Object.freeze([
  'free',
  'solo_lite',
  'solo_premium',
  'solo_elite',
  'team_tier3',
  'team_tier2',
  'team_tier1'
]);

/** The solo ladder. Everything else that is not `free` is a team plan. */
export const SOLO_PLAN_IDS = Object.freeze(['solo_lite', 'solo_premium', 'solo_elite']);

/** The team ladder, weakest first. A team plan is what unlocks `team.*`. */
export const TEAM_PLAN_IDS = Object.freeze(['team_tier3', 'team_tier2', 'team_tier1']);

/** True when this plan carries the team toolkit at all. */
export function isTeamPlan(planId) {
  return TEAM_PLAN_IDS.includes(planId);
}

/**
 * Rank drives every merge in resolve.js and decides which plan name an account
 * is shown under. Gaps of 10 leave room for a plan between two existing ones
 * without renumbering rows that are already in the database.
 *
 * Rank follows price, so `team_tier3` outranks `solo_elite` even though Solo
 * Elite is stronger at several individual capabilities. That is safe because
 * resolve.js merges per capability and keeps the STRONGER value, never the
 * higher-ranked one; rank only breaks ties and picks the displayed name.
 */
export const PLAN_RANKS = Object.freeze({
  free: 0,
  solo_lite: 10,
  solo_premium: 20,
  solo_elite: 30,
  team_tier3: 40,
  team_tier2: 50,
  team_tier1: 60
});

export const PLAN_NAMES = Object.freeze({
  free: 'Free',
  solo_lite: 'Solo Lite',
  solo_premium: 'Solo Premium',
  solo_elite: 'Solo Elite',
  team_tier3: 'Team Tier 3',
  team_tier2: 'Team Tier 2',
  team_tier1: 'Team Tier 1'
});

/**
 * Which band a plan sits in. Used by the pricing page to line the two ladders
 * up next to each other, and by nothing that enforces anything.
 */
export const PLAN_BANDS = Object.freeze({
  free: 'free',
  solo_lite: 'low',
  team_tier3: 'low',
  solo_premium: 'middle',
  team_tier2: 'middle',
  solo_elite: 'high',
  team_tier1: 'high'
});

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * Headline price, EUR cents per month. Cents rather than euros because every
 * discounted total is computed from this and floating point euros drift: at
 * 699.99 * 12 * 0.72 the two spellings already disagree in the last cent.
 */
export const PLAN_PRICE_CENTS = Object.freeze({
  free: 0,
  solo_lite: 899,
  solo_premium: 2499,
  solo_elite: 6999,
  team_tier3: 8999,
  team_tier2: 24999,
  team_tier1: 69999
});

/** Billing terms, and how many months each one covers. */
export const TERM_MONTHS = Object.freeze({
  month: 1,
  quarter: 3,
  halfyear: 6,
  year: 12
});

export const TERM_IDS = Object.freeze(['month', 'quarter', 'halfyear', 'year']);

export const TERM_NAMES = Object.freeze({
  month: 'Monthly',
  quarter: '3 months',
  halfyear: '6 months',
  year: '12 months'
});

/**
 * The discount everyone gets for paying up front, by term.
 */
export const TERM_DISCOUNT = Object.freeze({
  month: 0,
  quarter: 0.08,
  halfyear: 0.13,
  year: 0.2
});

/**
 * The second discount, applied to what is left after the first one. It is
 * deliberately NOT additive: 20% and then 10% off €100 is €72, not €70.
 *
 * It scales with the tier because the point of it is to make the long term
 * worth signing on the plans where the annual commitment is worth most.
 * Solo Lite has no second discount: it is already the floor.
 */
export const PLAN_TERM_BONUS = Object.freeze({
  free: { quarter: 0, halfyear: 0, year: 0 },
  solo_lite: { quarter: 0, halfyear: 0, year: 0 },
  solo_premium: { quarter: 0.03, halfyear: 0.04, year: 0.05 },
  solo_elite: { quarter: 0.05, halfyear: 0.06, year: 0.07 },
  team_tier3: { quarter: 0.03, halfyear: 0.04, year: 0.05 },
  team_tier2: { quarter: 0.05, halfyear: 0.06, year: 0.07 },
  team_tier1: { quarter: 0.08, halfyear: 0.09, year: 0.1 }
});

/**
 * What one term of one plan costs.
 *
 * The two discounts compose multiplicatively, and the total is rounded once,
 * at the end, in cents. `perMonthCents` is derived from the rounded total so
 * that the monthly figure on a pricing card multiplied by the number of months
 * is the number the customer is actually charged.
 *
 * @param {string} planId
 * @param {string} term
 * @returns {{
 *   planId: string, term: string, months: number,
 *   monthlyCents: number, totalCents: number, perMonthCents: number,
 *   baseDiscount: number, bonusDiscount: number, savedPct: number, savedCents: number
 * }}
 */
export function priceForTerm(planId, term = 'month') {
  const monthlyCents = PLAN_PRICE_CENTS[planId] ?? 0;
  const months = TERM_MONTHS[term];
  if (!months) throw new Error(`Unknown term: ${term}`);

  const baseDiscount = TERM_DISCOUNT[term] || 0;
  const bonusDiscount = (PLAN_TERM_BONUS[planId] || {})[term] || 0;
  const multiplier = (1 - baseDiscount) * (1 - bonusDiscount);

  const undiscounted = monthlyCents * months;
  const totalCents = Math.round(undiscounted * multiplier);

  return {
    planId,
    term,
    months,
    monthlyCents,
    totalCents,
    perMonthCents: Math.round(totalCents / months),
    baseDiscount,
    bonusDiscount,
    savedPct: Math.round((1 - multiplier) * 1000) / 10,
    savedCents: undiscounted - totalCents
  };
}

/** "€249.99". The one place cents become money on screen. */
export function euros(cents) {
  return `€${(Number(cents || 0) / 100).toFixed(2)}`;
}

/**
 * Display prices in euros, kept for surfaces that only ever want the headline
 * monthly number. Derived, so it cannot drift from PLAN_PRICE_CENTS.
 */
export const PLAN_PRICES = Object.freeze(
  Object.fromEntries(
    PLAN_IDS.map((id) => [
      id,
      Object.freeze({
        monthly: PLAN_PRICE_CENTS[id] / 100,
        monthlyCents: PLAN_PRICE_CENTS[id],
        yearlyMonthly: priceForTerm(id, 'year').perMonthCents / 100
      })
    ])
  )
);

/** One line under each plan name on the pricing page. */
export const PLAN_TAGLINES = Object.freeze({
  free: 'Watch, browse, and try the tools.',
  solo_lite: 'Every paid basic without limits, and one look a day at the models.',
  solo_premium: 'Three times the daily model allowance, and the deeper metrics.',
  solo_elite: 'Everything one player can use, unlimited.',
  team_tier3: 'One team, seven seats, the whole team toolkit.',
  team_tier2: 'Two teams, fourteen seats, three times the allowance.',
  team_tier1: 'The whole product, unlimited, for the organisation.'
});

/** Seats a plan may lend out, and teams it may create. Mirrors plans table. */
export const PLAN_CAPACITY = Object.freeze({
  free: { seat_capacity: 0, team_capacity: 0 },
  solo_lite: { seat_capacity: 0, team_capacity: 0 },
  solo_premium: { seat_capacity: 0, team_capacity: 0 },
  solo_elite: { seat_capacity: 0, team_capacity: 0 },
  team_tier3: { seat_capacity: 7, team_capacity: 1 },
  team_tier2: { seat_capacity: 14, team_capacity: 2 },
  team_tier1: { seat_capacity: 20, team_capacity: 3 }
});

/**
 * Enum ladders, weakest first. Used both to merge two enum values and to hand
 * an admin the strongest one.
 */
const DRAWING_BOARD_MODES = Object.freeze(['none', 'nosave', 'limited', 'full']);
const AIM_REPLAY_MODES = Object.freeze(['none', 'best_and_recent', 'best_plus_10', 'full']);
const COSMETIC_MODES = Object.freeze(['none', 'presets', 'full']);

// ---------------------------------------------------------------------------
// Band helpers
//
// Every row below is written as a band, not as seven hand-typed values, so a
// row cannot accidentally be non-monotonic and Tier 2 cannot quietly end up
// weaker than Tier 3.
// ---------------------------------------------------------------------------

/** free / low / middle / high, applied to both ladders. */
function byBand(free, low, middle, high) {
  return {
    free,
    solo_lite: low,
    solo_premium: middle,
    solo_elite: high,
    team_tier3: low,
    team_tier2: middle,
    team_tier1: high
  };
}

/** A team-only row: every solo plan gets `none`, the team ladder gets a band. */
function teamOnly(none, low, middle, high) {
  return {
    free: none,
    solo_lite: none,
    solo_premium: none,
    solo_elite: none,
    team_tier3: low,
    team_tier2: middle,
    team_tier1: high
  };
}

/** Everyone. The free door: things that exist to get people in. */
function everyone(value) {
  return byBand(value, value, value, value);
}

/** Free is out, every paid plan is in. The "basic paid feature" row. */
function paidOnly(no, yes) {
  return byBand(no, yes, yes, yes);
}

/** 0 / 1 / 3 / unlimited. The cutting-edge daily allowance, per subscription. */
const MODEL_QUOTA = Object.freeze(byBand(0, 1, 3, UNLIMITED));

/** The same ladder, but only teams have the feature at all. */
const TEAM_MODEL_QUOTA = Object.freeze(teamOnly(0, 1, 3, UNLIMITED));

/**
 * The catalogue itself.
 *
 * `label` is user-facing: it appears in the 402 upgrade message and in locked
 * UI, so it follows the copy rules in CLAUDE.md (no em dashes, no filler).
 * `scope: 'per_map'` means the limit counts per map rather than per account,
 * which the enforcement layer needs in order to count the right rows.
 *
 * `shared: true` on a quota means the allowance belongs to the subscription
 * rather than to the person spending it, so a team's seats draw from one pot.
 * That is what "one anti-strat a day" means on a seven-man roster.
 */
export const CAPABILITIES = Object.freeze({
  // --- Demos -------------------------------------------------------------
  'demos.viewer': {
    shape: BOOL,
    label: 'Demo viewer',
    values: everyone(true)
  },
  'demos.ads_free': {
    shape: BOOL,
    label: 'Ad-free viewing',
    values: paidOnly(false, true)
  },
  'demos.full_recent_access': {
    shape: BOOL,
    label: 'Full access to recent demos',
    // Free accounts see only the first half of demos under a month old.
    values: paidOnly(false, true)
  },
  'demos.macro_viewer': {
    shape: QUOTA,
    // Named for the button the user actually clicks, so the 402 names
    // something findable.
    label: 'Analyzer',
    values: byBand(1, UNLIMITED, UNLIMITED, UNLIMITED)
  },
  'demos.upload_limit': {
    shape: LIMIT,
    label: 'Demo uploads',
    // Held at once, per account. Teams sit above the matching solo band
    // because a roster feeds one shared library.
    values: {
      free: 3,
      solo_lite: 25,
      solo_premium: 75,
      solo_elite: UNLIMITED,
      team_tier3: 100,
      team_tier2: 300,
      team_tier1: UNLIMITED
    }
  },
  'demos.map_control': {
    shape: QUOTA,
    shared: true,
    label: 'Map control',
    values: MODEL_QUOTA
  },
  'demos.round_win_prediction': {
    shape: QUOTA,
    shared: true,
    label: 'Round win prediction',
    values: MODEL_QUOTA
  },
  'demos.duel_win_prediction': {
    shape: QUOTA,
    shared: true,
    label: 'Duel win prediction',
    values: MODEL_QUOTA
  },
  'demos.auto_coach': {
    shape: QUOTA,
    shared: true,
    label: 'Auto coach',
    values: MODEL_QUOTA
  },
  'demos.teamspeak_sync': {
    shape: BOOL,
    label: 'TeamSpeak sync',
    values: teamOnly(false, true, true, true)
  },
  'demos.comms_coach': {
    shape: QUOTA,
    shared: true,
    label: 'Comms coach',
    values: TEAM_MODEL_QUOTA
  },
  drawing_board: {
    shape: ENUM,
    label: 'Drawing board',
    order: DRAWING_BOARD_MODES,
    // 'limited' is 5 saved drawings per map; the count lives in DRAWING_BOARD_CAP.
    // The board lives on a team page, so the team ladder starts one rung up: a
    // solo player may draw over a frame, a team may keep what they drew.
    values: {
      free: 'none',
      solo_lite: 'nosave',
      solo_premium: 'limited',
      solo_elite: 'full',
      team_tier3: 'limited',
      team_tier2: 'full',
      team_tier1: 'full'
    }
  },

  // --- Stats and analytics -----------------------------------------------
  // Performance Overview is deliberately absent: it is public, for everyone,
  // signed in or not. It is the shop window.
  'stats.performance_chapters': {
    shape: BOOL,
    label: 'Maps and Guns',
    values: paidOnly(false, true)
  },
  'stats.single_game': {
    shape: BOOL,
    label: 'Single game stats',
    values: paidOnly(false, true)
  },
  'stats.team_statistics': {
    shape: BOOL,
    label: 'Team statistics',
    values: paidOnly(false, true)
  },
  'stats.metrics_player_full': {
    shape: BOOL,
    label: 'Full player metrics',
    // PSDT, DT, Accuracy.
    values: paidOnly(false, true)
  },
  'stats.metrics_team_full': {
    shape: BOOL,
    label: 'Full team metrics',
    // PRW, Poss%. Model output, so it starts at the middle band.
    values: byBand(false, false, true, true)
  },
  'stats.filters_full': {
    shape: BOOL,
    label: 'All filters',
    values: paidOnly(false, true)
  },
  'analytics.charts': {
    shape: QUOTA,
    label: 'Charts',
    // Free is also restricted to limited controls, gated by stats.filters_full.
    values: byBand(3, UNLIMITED, UNLIMITED, UNLIMITED)
  },
  'analytics.pattern_finder': {
    shape: QUOTA,
    label: 'Pattern finder',
    values: byBand(3, UNLIMITED, UNLIMITED, UNLIMITED)
  },
  'analytics.antistrat': {
    shape: QUOTA,
    shared: true,
    label: 'Anti-strat',
    // The flagship team feature, and the clearest example of the band rule:
    // one report a day for the whole of a Tier 3 roster, three for Tier 2.
    values: TEAM_MODEL_QUOTA
  },

  // --- Teams --------------------------------------------------------------
  'team.create_limit': {
    shape: LIMIT,
    label: 'Teams',
    values: teamOnly(0, 1, 2, 3)
  },
  'team.join': {
    shape: BOOL,
    label: 'Joining a team',
    // Solo plans join teams; they just cannot run one. This is how a Tier 1
    // organisation seats players who also hold their own subscription.
    values: paidOnly(false, true)
  },
  'team.seat_capacity': {
    shape: LIMIT,
    label: 'Seats',
    // Per subscription, not per team. Tier 1's 20 are pooled across its teams.
    values: teamOnly(0, 7, 14, 20)
  },
  'team.documents': {
    shape: LIMIT,
    label: 'Documents',
    values: teamOnly(0, 10, 30, UNLIMITED)
  },
  'team.roles_positions': {
    shape: BOOL,
    label: 'Roles and positions',
    values: teamOnly(false, true, true, true)
  },
  'team.playlists': {
    shape: BOOL,
    label: 'Team playlists',
    values: teamOnly(false, true, true, true)
  },
  'team.comms': {
    shape: BOOL,
    label: 'Communication',
    // The Communication page, the recorder and attaching voice to a demo.
    // Any team tier, because a team is the only thing that has comms.
    values: teamOnly(false, true, true, true)
  },
  'team.stratbook_access': {
    shape: BOOL,
    label: 'Stratbook',
    values: teamOnly(false, true, true, true)
  },
  'team.stratbook_limit': {
    shape: LIMIT,
    label: 'Strategies per map',
    scope: 'per_map',
    values: teamOnly(0, 40, 120, UNLIMITED)
  },
  'team.utility_archive': {
    shape: LIMIT,
    label: 'Utility per map',
    scope: 'per_map',
    values: teamOnly(0, 50, 150, UNLIMITED)
  },
  'team.strategy_creator_2d': {
    shape: LIMIT,
    label: '2D strategies per map',
    scope: 'per_map',
    values: teamOnly(0, 3, 9, UNLIMITED)
  },
  'team.auto_round_winrates': {
    shape: BOOL,
    label: 'Automatic round winrates',
    // Model output over the team's own rounds, so it starts at Tier 2.
    values: teamOnly(false, false, true, true)
  },

  // --- Aim trainer --------------------------------------------------------
  'aim.trainer': {
    shape: BOOL,
    label: 'Aim trainer',
    values: everyone(true)
  },
  'aim.routines': {
    shape: BOOL,
    label: 'Routines',
    values: everyone(true)
  },
  'aim.map_practice': {
    shape: BOOL,
    label: 'Map practice',
    values: paidOnly(false, true)
  },
  'aim.advanced_analytics': {
    shape: BOOL,
    label: 'Advanced analytics',
    values: paidOnly(false, true)
  },
  'aim.replays': {
    shape: ENUM,
    label: 'Aim replays',
    order: AIM_REPLAY_MODES,
    values: byBand('none', 'best_and_recent', 'best_plus_10', 'full')
  },
  'aim.custom_routines': {
    shape: LIMIT,
    label: 'Custom routines',
    values: byBand(0, 5, 15, UNLIMITED)
  },
  'aim.cosmetics': {
    shape: ENUM,
    label: 'Cosmetics',
    order: COSMETIC_MODES,
    values: byBand('none', 'presets', 'presets', 'full')
  }
});

/** Saved drawings per map when `drawing_board` resolves to 'limited'. */
export const DRAWING_BOARD_CAP = 5;

export const CAPABILITY_KEYS = Object.freeze(Object.keys(CAPABILITIES));

/** Quota keys whose allowance belongs to the subscription, not to the seat. */
export const SHARED_QUOTA_KEYS = Object.freeze(
  CAPABILITY_KEYS.filter((key) => CAPABILITIES[key].shared === true)
);

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

// ---------------------------------------------------------------------------
// Self-checks. A catalogue that contradicts itself is worth failing at import
// for, in both runtimes, rather than discovering through a 402 that names the
// wrong plan.
// ---------------------------------------------------------------------------
{
  const problems = [];

  for (const planId of PLAN_IDS) {
    if (!(planId in PLAN_RANKS)) problems.push(`${planId} has no rank`);
    if (!(planId in PLAN_NAMES)) problems.push(`${planId} has no name`);
    if (!(planId in PLAN_TAGLINES)) problems.push(`${planId} has no tagline`);
    if (!(planId in PLAN_CAPACITY)) problems.push(`${planId} has no capacity`);
    if (!(planId in PLAN_PRICE_CENTS)) problems.push(`${planId} has no price`);
    if (!(planId in PLAN_TERM_BONUS)) problems.push(`${planId} has no term bonus`);
    if (!(planId in PLAN_BANDS)) problems.push(`${planId} has no band`);
  }

  // PLAN_IDS must stay in ascending price and ascending rank order, because
  // requiredPlanFor walks it and every "cheapest plan that unlocks this"
  // message depends on that.
  for (let i = 1; i < PLAN_IDS.length; i += 1) {
    const prev = PLAN_IDS[i - 1];
    const cur = PLAN_IDS[i];
    if (PLAN_PRICE_CENTS[cur] <= PLAN_PRICE_CENTS[prev]) {
      problems.push(`PLAN_IDS is not in ascending price order at ${cur}`);
    }
    if (PLAN_RANKS[cur] <= PLAN_RANKS[prev]) {
      problems.push(`PLAN_IDS is not in ascending rank order at ${cur}`);
    }
  }

  for (const [key, def] of Object.entries(CAPABILITIES)) {
    for (const planId of PLAN_IDS) {
      if (!(planId in def.values)) problems.push(`${key} has no value for ${planId}`);
    }
    if (def.shape === ENUM) {
      for (const planId of PLAN_IDS) {
        if (!def.order.includes(def.values[planId])) {
          problems.push(`${key}.${planId} is not one of its enum modes`);
        }
      }
    }
    if (def.shared && def.shape !== QUOTA) {
      problems.push(`${key} is marked shared but is not a quota`);
    }
    // Each ladder must be monotonic within itself. A middle plan that is
    // weaker than the low plan below it is always a typo.
    for (const ladder of [SOLO_PLAN_IDS, TEAM_PLAN_IDS]) {
      for (let i = 1; i < ladder.length; i += 1) {
        if (compareValues(key, def.values[ladder[i]], def.values[ladder[i - 1]]) < 0) {
          problems.push(`${key} goes backwards from ${ladder[i - 1]} to ${ladder[i]}`);
        }
      }
    }
    if (compareValues(key, def.values[SOLO_PLAN_IDS[0]], def.values.free) < 0) {
      problems.push(`${key} is weaker on solo_lite than on free`);
    }
  }

  if (problems.length) {
    throw new Error(`catalogue.js is inconsistent:\n  ${problems.join('\n  ')}`);
  }
}

// ---------------------------------------------------------------------------
// shared/entitlements/resolve.js
// Merge every source of entitlement into one answer. Pure, no I/O.
//
// Order, last write winning per capability:
//   1. Base tier      'free', always, for every account
//   2. Seat grant     a seat on someone else's plan
//   3. Own plan       their own subscription or trial
//   4. Admin grant    manual, optionally time-boxed
//   5. Admin override is_admin, everything unlimited
//
// Steps 2 and 3 merge by plan *rank*, not by recency, so a user holding both a
// personal Premium and a Team Elite seat is never worse off than holding either
// alone. Steps 3 and 4 are time-aware at read: an expired trial or grant stops
// applying the moment it lapses, whether or not the sweep job has run. That
// property is what stops "the cron was down for a day" from becoming "forty
// people had Premium for free".
// ---------------------------------------------------------------------------

import {
  CAPABILITY_KEYS,
  PLAN_RANKS,
  capabilitiesForPlan,
  compareValues,
  isCapability,
  unlimitedCapabilities
} from './catalogue.js';

/** Statuses that entitle. `past_due` deliberately does not: dunning is not access. */
const ACTIVE_STATUSES = new Set(['trialing', 'active']);

const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function toIso(value) {
  const ms = toMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

function rankOf(planId) {
  return PLAN_RANKS[planId] ?? 0;
}

/**
 * Is this subscription entitling right now?
 *
 * Note the period-end check runs at read time, which means a renewal whose
 * webhook has not landed yet reads as lapsed for those few seconds. That is the
 * correct trade: the alternative is honouring a subscription that has actually
 * ended. Billing extends `current_period_end` before the old one passes.
 */
export function subscriptionIsActive(sub, nowMs) {
  if (!sub || !ACTIVE_STATUSES.has(sub.status)) return false;
  if (sub.status === 'trialing') {
    const trialEnd = toMs(sub.trial_ends_at);
    if (trialEnd != null && nowMs >= trialEnd) return false;
  }
  const periodEnd = toMs(sub.current_period_end);
  if (periodEnd != null && nowMs >= periodEnd) return false;
  return true;
}

/** Is this grant live? Unrevoked, started, not yet expired. */
export function grantIsActive(grant, nowMs) {
  if (!grant || grant.revoked_at) return false;
  const startsAt = toMs(grant.starts_at);
  if (startsAt != null && nowMs < startsAt) return false;
  const expiresAt = toMs(grant.expires_at);
  if (expiresAt != null && nowMs >= expiresAt) return false;
  return true;
}

/** A seat entitles while it is unreleased and its lending subscription is live. */
export function seatIsActive(seat, nowMs) {
  if (!seat || seat.released_at) return false;
  return subscriptionIsActive(seat.subscription, nowMs);
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Merge a plan's capabilities over an accumulator, per capability, keeping
 * whichever value the higher-ranked plan supplies.
 *
 * Written per-capability rather than "just take the highest plan wholesale"
 * because the two only agree while the matrix is monotonic in rank. If a future
 * plan is ever better at one thing and worse at another, this keeps the stated
 * guarantee that holding two plans cannot make a user worse off.
 */
function mergePlan(acc, accRankByKey, planId) {
  const values = capabilitiesForPlan(planId);
  const rank = rankOf(planId);
  for (const key of CAPABILITY_KEYS) {
    if (rank >= (accRankByKey[key] ?? -1)) {
      acc[key] = values[key];
      accRankByKey[key] = rank;
    }
  }
}

/**
 * @param {object} input
 * @param {object|null} [input.subscription] the user's own subscription row
 * @param {object|object[]|null} [input.seat]  seat row(s), each with `.subscription`
 * @param {object[]} [input.grants]            entitlement_grants rows
 * @param {boolean} [input.isAdmin]            row present in site_admins
 * @param {Date|number|string} [input.now]
 * @returns {{
 *   tier: string, source: string, capabilities: Record<string, any>,
 *   expiresAt: string|null, trial: object|null, isAdmin: boolean,
 *   seat: {subscriptionId: string|null, teamId: string|null, planId: string}|null,
 *   appliedGrants: string[]
 * }}
 */
export function resolveEntitlements({
  subscription = null,
  seat = null,
  grants = [],
  isAdmin = false,
  now = Date.now()
} = {}) {
  const nowMs = toMs(now) ?? Date.now();

  // 1. Base.
  const capabilities = capabilitiesForPlan('free');
  /** @type {Record<string, number>} */
  const rankByKey = {};
  for (const key of CAPABILITY_KEYS) rankByKey[key] = 0;

  let tier = 'free';
  let source = 'free';
  let expiresAt = null;

  // 2. Seats. A user may sit on more than one plan; the best one wins.
  let bestSeat = null;
  for (const candidate of asArray(seat)) {
    if (!seatIsActive(candidate, nowMs)) continue;
    const planId = candidate.subscription?.plan_id;
    if (!planId || !(planId in PLAN_RANKS)) continue;
    if (!bestSeat || rankOf(planId) > rankOf(bestSeat.subscription.plan_id)) {
      bestSeat = candidate;
    }
  }
  if (bestSeat) {
    const planId = bestSeat.subscription.plan_id;
    mergePlan(capabilities, rankByKey, planId);
    tier = planId;
    source = 'seat';
    expiresAt = toIso(bestSeat.subscription.current_period_end);
  }

  // 3. Their own subscription.
  let trial = null;
  if (subscriptionIsActive(subscription, nowMs)) {
    const planId = subscription.plan_id;
    if (planId in PLAN_RANKS) {
      mergePlan(capabilities, rankByKey, planId);
      // On a tie, their own plan is the more useful thing to name in the UI.
      if (rankOf(planId) >= rankOf(tier)) {
        tier = planId;
        source = 'subscription';
        expiresAt = toIso(subscription.current_period_end);
      }
    }
    if (subscription.status === 'trialing') {
      const endsAtMs = toMs(subscription.trial_ends_at);
      trial = {
        planId: subscription.plan_id,
        startedAt: toIso(subscription.trial_started_at),
        endsAt: toIso(subscription.trial_ends_at),
        daysLeft: endsAtMs == null ? null : Math.max(0, Math.ceil((endsAtMs - nowMs) / DAY_MS)),
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        source: subscription.source || 'trial'
      };
    }
  }

  // 4. Admin grants. Oldest first so a later grant deliberately wins a tie.
  const appliedGrants = [];
  const live = asArray(grants)
    .filter((g) => grantIsActive(g, nowMs))
    .sort((a, b) => (toMs(a.created_at) ?? 0) - (toMs(b.created_at) ?? 0));

  for (const grant of live) {
    const override = grant.mode === 'override';
    let applied = false;

    if (grant.plan_id && grant.plan_id in PLAN_RANKS) {
      if (override) {
        // An override may move a user *down*, which is the point: it is how you
        // reproduce a Free user's experience while holding a paid plan.
        const values = capabilitiesForPlan(grant.plan_id);
        for (const key of CAPABILITY_KEYS) {
          capabilities[key] = values[key];
          rankByKey[key] = rankOf(grant.plan_id);
        }
        tier = grant.plan_id;
        source = 'grant';
        expiresAt = toIso(grant.expires_at);
        applied = true;
      } else if (rankOf(grant.plan_id) > rankOf(tier)) {
        mergePlan(capabilities, rankByKey, grant.plan_id);
        tier = grant.plan_id;
        source = 'grant';
        expiresAt = toIso(grant.expires_at);
        applied = true;
      }
    }

    if (grant.capability && isCapability(grant.capability)) {
      const value = grant.value;
      const current = capabilities[grant.capability];
      if (override || compareValues(grant.capability, value, current) > 0) {
        capabilities[grant.capability] = value;
        applied = true;
      }
    }

    if (applied) appliedGrants.push(grant.id);
  }

  // 5. Admin. Not a tier: the resolved tier is left alone so the panel can still
  // show what this account would have without the badge.
  if (isAdmin) {
    Object.assign(capabilities, unlimitedCapabilities());
    source = 'admin';
    expiresAt = null;
  }

  return {
    tier,
    source,
    capabilities,
    expiresAt,
    trial,
    isAdmin: Boolean(isAdmin),
    seat: bestSeat
      ? {
          subscriptionId: bestSeat.subscription_id ?? bestSeat.subscription?.id ?? null,
          teamId: bestSeat.team_id ?? null,
          planId: bestSeat.subscription.plan_id
        }
      : null,
    appliedGrants
  };
}

/** Non-throwing read of one capability out of a resolved map. */
export function capabilityValue(resolved, key) {
  if (!isCapability(key)) throw new Error(`Unknown capability: ${key}`);
  return resolved?.capabilities?.[key];
}

// ---------------------------------------------------------------------------
// server/entitlements/enforce.js
// The four calls feature code makes. Nothing else should read a tier name.
//
//   capability(user, key)             non-throwing read, for building payloads
//   checkLimit(user, key, current)    integer caps
//   consumeQuota(user, key)           N uses per rolling 24h, atomic
//   requireCapability(user, key)      throws a 402-shaped error
//
// Every refusal is the same shape on the wire (section 1.9 of the plan) so the
// client renders one upsell component rather than one per feature. 402 rather
// than 403 deliberately: 403 means "not yours", 402 means "not on your plan",
// and conflating them means an upgrade prompt appears when someone opens
// another player's private demo.
// ---------------------------------------------------------------------------

import {
  PLAN_NAMES,
  UNLIMITED,
  capabilityDef,
  compareValues,
  isCapability,
  isEnabled,
  requiredPlanFor
} from '../../shared/entitlements/catalogue.js';
import { consume, peek } from './quota.js';

export class UpgradeRequiredError extends Error {
  constructor({ capability, message, currentTier, requiredTier, quota = null, limit = null }) {
    super(message);
    this.name = 'UpgradeRequiredError';
    this.status = 402;
    this.capability = capability;
    this.currentTier = currentTier;
    this.requiredTier = requiredTier;
    this.quota = quota;
    this.limit = limit;
  }

  /** The 402 body. One shape, everywhere. */
  toJSON() {
    return {
      error: 'upgrade_required',
      capability: this.capability,
      message: this.message,
      currentTier: this.currentTier,
      requiredTier: this.requiredTier,
      ...(this.quota ? { quota: this.quota } : {}),
      ...(this.limit ? { limit: this.limit } : {})
    };
  }
}

export function isUpgradeRequired(err) {
  return err instanceof UpgradeRequiredError || err?.status === 402;
}

/**
 * Non-throwing read of one capability for a resolved user.
 *
 * Falls back to the free value rather than to undefined when a user object has
 * no entitlements attached, so a route that forgets to await whoami() denies
 * rather than silently allows.
 */
export function capability(user, key) {
  if (!isCapability(key)) throw new Error(`Unknown capability: ${key}`);
  const value = user?.entitlements?.capabilities?.[key];
  return value === undefined ? capabilityDef(key).values.free : value;
}

export function tierOf(user) {
  return user?.entitlements?.tier || 'free';
}

/** True when the user may do this at all. Ignores counts. */
export function can(user, key) {
  return isEnabled(key, capability(user, key));
}

function planLabel(planId) {
  return PLAN_NAMES[planId] || planId;
}

/**
 * Message for a blocked action. Names the cheapest plan that unlocks it, not
 * the most expensive one, because pointing a Free user at Team Elite for
 * something Premium already covers reads as a shakedown.
 */
function upgradeMessage(key, requiredTier) {
  const label = capabilityDef(key).label;
  if (!requiredTier) return `${label} is not available.`;
  return `${label} is available on ${planLabel(requiredTier)}.`;
}

/**
 * Integer caps. Returns rather than throws, because most call sites want to
 * report "40 / 40 used" in the UI as well as refuse the 41st.
 *
 * @returns {{allowed: boolean, current: number, limit: number, remaining: number, tier: string}}
 */
export function checkLimit(user, key, currentCount = 0) {
  const limit = Number(capability(user, key));
  const current = Number(currentCount) || 0;
  const unlimited = limit === UNLIMITED;
  return {
    allowed: unlimited || current < limit,
    current,
    limit,
    remaining: unlimited ? UNLIMITED : Math.max(0, limit - current),
    tier: tierOf(user)
  };
}

/** checkLimit, but throws the 402 when the cap is reached. */
export function requireLimit(user, key, currentCount = 0) {
  const result = checkLimit(user, key, currentCount);
  if (result.allowed) return result;

  // The cheapest plan that would allow one more than they currently hold.
  const requiredTier = requiredPlanFor(key, result.current + 1);
  throw new UpgradeRequiredError({
    capability: key,
    message: requiredTier
      ? `${capabilityDef(key).label}: you are at your limit of ${result.limit}. More is available on ${planLabel(requiredTier)}.`
      : `${capabilityDef(key).label}: you are at your limit of ${result.limit}.`,
    currentTier: result.tier,
    requiredTier,
    limit: { current: result.current, limit: result.limit }
  });
}

/**
 * Spend one use of a quota'd capability.
 *
 * Impersonation never consumes: an admin looking at an account must not burn
 * the quota that account paid for. The flag is threaded from whoami() rather
 * than checked at each call site, because "we forgot one" is the default
 * outcome otherwise.
 *
 * @returns {Promise<{allowed: boolean, used: number, limit: number, resetsAt: string|null, remaining: number}>}
 */
export async function consumeQuota(user, key) {
  const limit = Number(capability(user, key));

  if (user?.impersonating) {
    return await peek(user.id, key, limit);
  }
  return await consume(user?.id, key, limit);
}

/** consumeQuota, but throws the 402 when the allowance is spent. */
export async function requireQuota(user, key) {
  const result = await consumeQuota(user, key);
  if (result.allowed) return result;

  const requiredTier = requiredPlanFor(key, UNLIMITED) || requiredPlanFor(key);
  throw new UpgradeRequiredError({
    capability: key,
    message:
      Number(result.limit) <= 0
        ? upgradeMessage(key, requiredPlanFor(key))
        : `${capabilityDef(key).label}: you have used your ${result.limit} for today. More is available on ${planLabel(requiredTier)}.`,
    currentTier: tierOf(user),
    requiredTier: Number(result.limit) <= 0 ? requiredPlanFor(key) : requiredTier,
    quota: { used: result.used, limit: result.limit, resetsAt: result.resetsAt }
  });
}

/**
 * The general gate. Booleans and enums throw when the capability is missing or
 * below `atLeast`; limits and quotas delegate to the two above.
 *
 * @param {object} user
 * @param {string} key
 * @param {{current?: number, atLeast?: any, consume?: boolean}} [opts]
 */
export async function requireCapability(user, key, opts = {}) {
  const def = capabilityDef(key);
  const value = capability(user, key);

  switch (def.shape) {
    case 'limit':
      return requireLimit(user, key, opts.current || 0);

    case 'quota':
      // Callers that only want to know whether the feature exists on this tier
      // pass consume: false, so opening a page does not spend a use.
      if (opts.consume === false) {
        if (!isEnabled(key, value)) break;
        return { allowed: true };
      }
      return await requireQuota(user, key);

    case 'enum': {
      const needed = opts.atLeast ?? def.order[1];
      if (compareValues(key, value, needed) >= 0) return { allowed: true, value };
      const requiredTier = requiredPlanFor(key, needed);
      throw new UpgradeRequiredError({
        capability: key,
        message: upgradeMessage(key, requiredTier),
        currentTier: tierOf(user),
        requiredTier
      });
    }

    default:
      if (isEnabled(key, value)) return { allowed: true, value };
      break;
  }

  const requiredTier = requiredPlanFor(key);
  throw new UpgradeRequiredError({
    capability: key,
    message: upgradeMessage(key, requiredTier),
    currentTier: tierOf(user),
    requiredTier
  });
}

/**
 * Turn any error into a response. Returns null for errors that are not
 * entitlement refusals, so callers can rethrow.
 */
export function upgradeResponse(err) {
  return isUpgradeRequired(err) ? { status: 402, body: err.toJSON() } : null;
}

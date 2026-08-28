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
import { quotaSubject } from '../../shared/entitlements/resolve.js';
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
 * the most expensive one, because pointing a Free user at Team Tier 1 for
 * something Solo Lite already covers reads as a shakedown.
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
 * `incoming` is how many the caller is about to add, and it defaults to 1
 * because every call site that omits it is asking "may I add one more". It
 * exists because the interesting failure is not the 41st single item, it is one
 * request that adds fifty: a free account at 0 of 3 uploading an archive of a
 * hundred demos passed `0 < 3` and then created a hundred records. A cap that
 * only ever compares what is already there cannot refuse that.
 *
 * @param {object} user
 * @param {string} key
 * @param {number} [currentCount] how many they already hold
 * @param {number} [incoming]     how many this operation would add
 * @returns {{allowed: boolean, current: number, incoming: number, limit: number,
 *            remaining: number, accepted: number, tier: string}}
 */
export function checkLimit(user, key, currentCount = 0, incoming = 1) {
  const limit = Number(capability(user, key));
  const current = Math.max(0, Number(currentCount) || 0);
  const wanted = Math.max(0, Number(incoming) || 0);
  const unlimited = limit === UNLIMITED;
  const remaining = unlimited ? UNLIMITED : Math.max(0, limit - current);
  return {
    allowed: unlimited || current + wanted <= limit,
    current,
    incoming: wanted,
    limit,
    remaining,
    // How many of `incoming` would fit. Lets a batch land what it can and
    // refuse the rest, rather than being all-or-nothing.
    accepted: unlimited ? wanted : Math.min(wanted, remaining),
    tier: tierOf(user)
  };
}

/** checkLimit, but throws the 402 when the cap would be exceeded. */
export function requireLimit(user, key, currentCount = 0, incoming = 1) {
  const result = checkLimit(user, key, currentCount, incoming);
  if (result.allowed) return result;

  // The cheapest plan that would hold everything they are trying to have.
  const needed = result.current + result.incoming;
  const requiredTier = requiredPlanFor(key, needed);
  const label = capabilityDef(key).label;
  const atCap = result.remaining === 0;
  const detail = atCap
    ? `you are at your limit of ${result.limit}`
    : `that would take you to ${needed} of ${result.limit}`;
  throw new UpgradeRequiredError({
    capability: key,
    message: requiredTier
      ? `${label}: ${detail}. More is available on ${planLabel(requiredTier)}.`
      : `${label}: ${detail}.`,
    currentTier: result.tier,
    requiredTier,
    limit: { current: result.current, incoming: result.incoming, limit: result.limit }
  });
}

/**
 * Who a use of this capability is charged to.
 *
 * For the expensive capabilities the allowance belongs to the subscription, not
 * to the person spending it, so seven seats on one Tier 3 team share one
 * anti-strat a day rather than getting seven. resolve.js works out which
 * subscription supplied the value; this just reads its answer, and falls back
 * to the account for everything personal.
 */
export function quotaSubjectFor(user, key) {
  return quotaSubject(user?.entitlements, key, user?.id);
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
  const subject = quotaSubjectFor(user, key);

  if (user?.impersonating) {
    return await peek(subject, key, limit);
  }
  return await consume(subject, key, limit);
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
        : `${capabilityDef(key).label}: ${
            capabilityDef(key).shared ? 'this team has' : 'you have'
          } used ${result.limit} for today. More is available on ${planLabel(requiredTier)}.`,
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
 * @param {{current?: number, incoming?: number, atLeast?: any, consume?: boolean}} [opts]
 */
export async function requireCapability(user, key, opts = {}) {
  const def = capabilityDef(key);
  const value = capability(user, key);

  switch (def.shape) {
    case 'limit':
      return requireLimit(user, key, opts.current || 0, opts.incoming ?? 1);

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

// ---------------------------------------------------------------------------
// server/entitlements/load.js
// Fetch every entitlement source for one account and resolve it.
//
// Cached for the same 60s as whoami(), because whoami() is what calls it and a
// page that fires ten replay requests should cost one round trip, not ten. The
// cache is the reason invalidateUser() exists: without it a grant made in the
// admin panel would appear to do nothing for up to a minute, and the natural
// reaction to that is to click grant again.
// ---------------------------------------------------------------------------

import { resolveEntitlements } from '../../shared/entitlements/resolve.js';
import { db, isConfigured, isSiteAdmin } from './service.js';

const cache = new Map();
const CACHE_MS = 60 * 1000;
const MAX_CACHE = 500;

/** What an account resolves to when nothing is configured or nothing is held. */
export function freeEntitlements({ isAdmin = false } = {}) {
  return resolveEntitlements({ isAdmin, now: Date.now() });
}

/**
 * Read the three sources in parallel. Each is independently allowed to come
 * back empty: a user with no subscription, no seat and no grant is the common
 * case, not an error.
 */
async function fetchSources(userId) {
  const [subscription, seats, grants] = await Promise.all([
    db.selectOne('subscriptions', {
      select: '*',
      user_id: `eq.${userId}`,
      status: 'in.(trialing,active,past_due)',
      order: 'created_at.desc'
    }),
    db.select('subscription_seats', {
      select: '*,subscription:subscriptions(*)',
      user_id: `eq.${userId}`,
      released_at: 'is.null'
    }),
    db.select('entitlement_grants', {
      select: '*',
      user_id: `eq.${userId}`,
      revoked_at: 'is.null',
      order: 'created_at.asc'
    })
  ]);
  return { subscription, seats, grants };
}

/**
 * Resolved entitlements for one account.
 *
 * Never throws. A database outage resolves to free rather than to an error,
 * because the alternative is that Supabase being slow takes the demo library
 * down with it. Admin status fails closed for the same reason, in the other
 * direction.
 */
export async function loadEntitlements(userId, { fresh = false } = {}) {
  if (!userId) return freeEntitlements();

  if (!fresh) {
    const hit = cache.get(userId);
    if (hit && hit.expires > Date.now()) return hit.value;
  }

  let resolved;
  if (!isConfigured()) {
    resolved = freeEntitlements();
  } else {
    try {
      const [{ subscription, seats, grants }, isAdmin] = await Promise.all([
        fetchSources(userId),
        isSiteAdmin(userId)
      ]);
      resolved = resolveEntitlements({
        subscription,
        seat: seats,
        grants,
        isAdmin,
        now: Date.now()
      });
    } catch (err) {
      console.warn(`[entitlements] load failed for ${userId}: ${err.message}`);
      resolved = freeEntitlements();
    }
  }

  cache.set(userId, { value: resolved, expires: Date.now() + CACHE_MS });
  if (cache.size > MAX_CACHE) {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expires <= now) cache.delete(key);
    }
  }
  return resolved;
}

/** Call after any write that changes what a user is entitled to. */
export function invalidateUser(userId) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

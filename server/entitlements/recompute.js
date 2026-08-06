// ---------------------------------------------------------------------------
// server/entitlements/recompute.js
// The single writer of denormalised entitlement state.
//
// Two places cache a copy of what resolve.js decided:
//
//   profiles.effective_tier / effective_capabilities   read by RLS policies
//   teams.json  team.seatCapacity                       read by the sync team store
//
// Both exist because their readers cannot call resolve.js: an RLS policy is
// SQL, and publicTeam() is synchronous. Both are therefore stale by definition
// unless something keeps them fresh, and that something is this file and
// nothing else. Call recomputeUser() after any subscription, seat, grant or
// trial change, and after the sweep.
// ---------------------------------------------------------------------------

import { isOwner, seatCapacityOf, setTeamSeatCapacity, teamsOf } from '../replays/teamsStore.js';
import { invalidateUserIdentity } from '../replays/identity.js';
import { CAP } from '../../shared/entitlements/keys.js';
import { invalidateUser, loadEntitlements } from './load.js';
import { db, isConfigured } from './service.js';

/**
 * Recompute and persist everything derived from one account's entitlements.
 *
 * Best-effort by design: a failure to write the denormalised copy must not fail
 * the operation that triggered it, because the authoritative answer is still
 * resolve.js and every Node-side check already goes through it. The copies
 * catch up on the next recompute or the nightly sweep.
 *
 * @returns {Promise<object>} the freshly resolved entitlements
 */
export async function recomputeUser(userId) {
  if (!userId) return null;

  // Drop the cache first, then read through it, so the value written to the
  // database and the value the next request sees are the same one.
  invalidateUser(userId);
  invalidateUserIdentity(userId);
  const resolved = await loadEntitlements(userId, { fresh: true });

  if (isConfigured()) {
    try {
      await db.update(
        'profiles',
        { id: `eq.${userId}` },
        {
          effective_tier: resolved.tier,
          effective_capabilities: resolved.capabilities,
          entitlements_updated_at: new Date().toISOString()
        },
        { returning: false }
      );
    } catch (err) {
      console.warn(`[entitlements] could not write effective_* for ${userId}: ${err.message}`);
    }
  }

  await syncOwnedTeamCapacity(userId, resolved);
  return resolved;
}

/**
 * Push seat capacity onto every team this account owns.
 *
 * Capacity belongs to the subscription rather than to a team, so an Elite owner
 * with two teams gets the same number written to both. The pooled total is
 * enforced against subscription_seats, not against either team's roster; this
 * number is what the roster UI shows.
 */
export async function syncOwnedTeamCapacity(userId, resolved = null) {
  try {
    const entitlements = resolved || (await loadEntitlements(userId));
    const capacity = Number(entitlements?.capabilities?.[CAP.TEAM_SEAT_CAPACITY]);
    if (!Number.isFinite(capacity)) return;

    const teams = await teamsOf(userId);
    for (const team of teams) {
      if (!isOwner(team, userId)) continue;
      if (seatCapacityOf(team) === capacity) continue;
      await setTeamSeatCapacity(team.id, capacity);
    }
  } catch (err) {
    console.warn(`[entitlements] could not sync team capacity for ${userId}: ${err.message}`);
  }
}

/** Recompute several accounts, e.g. every member of a team whose plan changed. */
export async function recomputeUsers(userIds = []) {
  const unique = [...new Set(userIds.filter(Boolean))];
  const results = [];
  for (const id of unique) {
    results.push(await recomputeUser(id));
  }
  return results;
}

// ---------------------------------------------------------------------------
// server/entitlements/grants.js
// Manual, optionally time-boxed capability awards. Admin only.
//
// A grant is either a whole tier or a single capability, and carries a mode:
// 'upgrade' applies only if it ranks higher than what the user already has,
// 'override' applies regardless, including downwards. Downwards matters: it is
// how you reproduce a Free user's experience from an admin account without
// cancelling your own plan.
// ---------------------------------------------------------------------------

import { PLAN_IDS, isCapability } from '../../shared/entitlements/catalogue.js';
import { writeAudit } from './audit.js';
import { recomputeUser } from './recompute.js';
import { db } from './service.js';

const MODES = new Set(['upgrade', 'override']);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

/**
 * @param {{
 *   userId: string, planId?: string|null, capability?: string|null, value?: any,
 *   mode?: string, expiresAt?: string|null, reason?: string, grantedBy: string, req?: object
 * }} input
 */
export async function createGrant({
  userId,
  planId = null,
  capability = null,
  value = null,
  mode = 'upgrade',
  expiresAt = null,
  reason = '',
  grantedBy,
  req = null
}) {
  if (!userId) throw new ValidationError('userId is required.');
  if (!grantedBy) throw new ValidationError('grantedBy is required.');
  if (!planId && !capability) throw new ValidationError('Give a plan or a capability.');
  if (planId && !PLAN_IDS.includes(planId)) throw new ValidationError(`Unknown plan: ${planId}`);
  if (capability && !isCapability(capability)) {
    throw new ValidationError(`Unknown capability: ${capability}`);
  }
  if (capability && value === null) {
    throw new ValidationError('A capability grant needs a value.');
  }
  if (!MODES.has(mode)) throw new ValidationError(`Unknown mode: ${mode}`);
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    throw new ValidationError('expiresAt is not a date.');
  }

  const row = await db.insert('entitlement_grants', {
    user_id: userId,
    plan_id: planId,
    capability,
    value: capability ? value : null,
    mode,
    expires_at: expiresAt,
    reason: String(reason || '').slice(0, 500) || null,
    granted_by: grantedBy
  });

  await recomputeUser(userId);
  await writeAudit({
    actorId: grantedBy,
    action: 'grant.create',
    targetUser: userId,
    payload: { grantId: row?.id, planId, capability, value, mode, expiresAt, reason },
    req
  });
  return row;
}

/** Revoke by stamping revoked_at. The row is kept: the audit trail needs it. */
export async function revokeGrant({ grantId, actorId, req = null }) {
  if (!grantId) throw new ValidationError('grantId is required.');

  const existing = await db.selectOne('entitlement_grants', {
    select: '*',
    id: `eq.${grantId}`
  });
  if (!existing) throw new ValidationError('That grant does not exist.');

  const [updated] = await db.update(
    'entitlement_grants',
    { id: `eq.${grantId}`, revoked_at: 'is.null' },
    { revoked_at: new Date().toISOString() }
  );

  await recomputeUser(existing.user_id);
  await writeAudit({
    actorId,
    action: 'grant.revoke',
    targetUser: existing.user_id,
    payload: { grantId, before: existing },
    req
  });
  return updated || existing;
}

export async function listGrants(userId, { includeRevoked = false } = {}) {
  const params = {
    select: '*',
    user_id: `eq.${userId}`,
    order: 'created_at.desc'
  };
  if (!includeRevoked) params.revoked_at = 'is.null';
  return db.select('entitlement_grants', params);
}

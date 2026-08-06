// ---------------------------------------------------------------------------
// server/entitlements/subscriptions.js
// Create, cancel, expire, and lend seats.
//
// One live subscription per account, enforced by a partial unique index on
// (user_id) where status in (trialing, active, past_due). Rows are never
// deleted: trial eligibility is "has this account ever had a row with
// trial_started_at set", and deleting history would hand out infinite trials.
//
// Seat capacity is per subscription, not per team. Team Elite lends 14 seats
// across the 2 teams it may create, so the check counts unreleased seats on the
// subscription rather than members of a roster.
// ---------------------------------------------------------------------------

import { PLAN_IDS } from '../../shared/entitlements/catalogue.js';
import { writeAudit } from './audit.js';
import { ValidationError } from './grants.js';
import { recomputeUser } from './recompute.js';
import { db } from './service.js';

const TERMS = new Set(['month', 'quarter', 'year', 'lifetime']);
const LIVE_STATUSES = ['trialing', 'active', 'past_due'];

const DAY_MS = 24 * 60 * 60 * 1000;

export function trialDays() {
  return Math.max(1, Number(process.env.AIM4_TRIAL_DAYS || 7));
}

export function trialPlan() {
  // Team Premium is the useful trial for the team suite (create team, Autocoach /
  // Team Replays). Premium cannot create a team, so a gifted Premium trial left
  // those pages looking "locked".
  const plan = process.env.AIM4_TRIAL_PLAN || 'team_premium';
  return PLAN_IDS.includes(plan) ? plan : 'team_premium';
}

export function trialsEnabled() {
  const raw = process.env.AIM4_TRIAL_ENABLED;
  return raw === undefined || raw === '1' || raw === 'true';
}

/** The account's live subscription, if any. */
export async function activeSubscription(userId) {
  return db.selectOne('subscriptions', {
    select: '*',
    user_id: `eq.${userId}`,
    status: `in.(${LIVE_STATUSES.join(',')})`,
    order: 'created_at.desc'
  });
}

export async function listSubscriptions(userId) {
  return db.select('subscriptions', {
    select: '*',
    user_id: `eq.${userId}`,
    order: 'created_at.desc'
  });
}

/**
 * End whatever is live so a new row can be inserted without tripping the
 * partial unique index.
 */
async function closeLive(userId, status = 'expired') {
  await db.update(
    'subscriptions',
    { user_id: `eq.${userId}`, status: `in.(${LIVE_STATUSES.join(',')})` },
    { status, updated_at: new Date().toISOString() },
    { returning: false }
  );
}

/**
 * @param {{
 *   userId: string, planId: string, term?: string, periodEnd?: string|null,
 *   source?: string, actorId?: string|null, notes?: string, req?: object
 * }} input
 */
export async function createSubscription({
  userId,
  planId,
  term = 'month',
  periodEnd = null,
  source = 'admin',
  actorId = null,
  notes = '',
  req = null
}) {
  if (!userId) throw new ValidationError('userId is required.');
  if (!PLAN_IDS.includes(planId)) throw new ValidationError(`Unknown plan: ${planId}`);
  if (!TERMS.has(term)) throw new ValidationError(`Unknown term: ${term}`);
  if (periodEnd && Number.isNaN(Date.parse(periodEnd))) {
    throw new ValidationError('periodEnd is not a date.');
  }

  const previous = await activeSubscription(userId);
  await closeLive(userId, 'expired');

  const row = await db.insert('subscriptions', {
    user_id: userId,
    plan_id: planId,
    status: 'active',
    term,
    current_period_start: new Date().toISOString(),
    // Null is "never expires", which is what an admin grant of infinite Elite
    // needs: the sweep skips it rather than expiring it every night.
    current_period_end: periodEnd,
    source,
    granted_by: actorId,
    notes: String(notes || '').slice(0, 1000) || null
  });

  await recomputeUser(userId);
  await writeAudit({
    actorId: actorId || userId,
    action: 'subscription.create',
    targetUser: userId,
    payload: { planId, term, periodEnd, source, replaced: previous?.id || null },
    req
  });
  return row;
}

/**
 * Cancel. Access continues to the end of the paid period by default.
 *
 * Revoking at the moment of cancellation is the single most common
 * cancellation antipattern: the user paid for the time, taking it away
 * generates chargebacks, and in the EU it is not defensible.
 */
export async function cancelSubscription({
  subscriptionId,
  userId,
  atPeriodEnd = true,
  actorId = null,
  req = null
}) {
  const existing = subscriptionId
    ? await db.selectOne('subscriptions', { select: '*', id: `eq.${subscriptionId}` })
    : await activeSubscription(userId);
  if (!existing) throw new ValidationError('No subscription to cancel.');

  const patch = atPeriodEnd
    ? { cancel_at_period_end: true, updated_at: new Date().toISOString() }
    : { status: 'cancelled', cancel_at_period_end: true, updated_at: new Date().toISOString() };

  const [updated] = await db.update('subscriptions', { id: `eq.${existing.id}` }, patch);
  await recomputeUser(existing.user_id);
  await writeAudit({
    actorId: actorId || existing.user_id,
    action: 'subscription.cancel',
    targetUser: existing.user_id,
    payload: { subscriptionId: existing.id, atPeriodEnd },
    req
  });
  return updated;
}

export async function setSubscriptionStatus({ subscriptionId, status, patch = {}, actorId = null }) {
  const [updated] = await db.update(
    'subscriptions',
    { id: `eq.${subscriptionId}` },
    { status, ...patch, updated_at: new Date().toISOString() }
  );
  if (updated) await recomputeUser(updated.user_id);
  if (updated && actorId) {
    await writeAudit({
      actorId,
      action: 'subscription.status',
      targetUser: updated.user_id,
      payload: { subscriptionId, status }
    });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Trials
// ---------------------------------------------------------------------------

/**
 * One trial per account, ever.
 *
 * Derived from history rather than from a flag, so it cannot be reset by
 * cancelling. Also refused when the account already has Premium or better,
 * because offering a trial of something someone already pays for is a support
 * ticket.
 */
export async function trialEligibility(userId, resolved = null) {
  if (!trialsEnabled()) return { eligible: false, reason: 'trials_disabled' };

  const history = await db.select('subscriptions', {
    select: 'id,trial_started_at',
    user_id: `eq.${userId}`,
    trial_started_at: 'not.is.null',
    limit: 1
  });
  if (history.length) return { eligible: false, reason: 'already_trialed' };

  const live = await activeSubscription(userId);
  if (live) return { eligible: false, reason: 'already_subscribed' };

  if (resolved && resolved.tier !== 'free') {
    return { eligible: false, reason: 'already_entitled' };
  }
  return { eligible: true, reason: null };
}

/**
 * @param {{userId: string, planId?: string, days?: number, source?: string,
 *          actorId?: string|null, skipEligibility?: boolean, req?: object}} input
 */
export async function startTrial({
  userId,
  planId = null,
  days = null,
  source = 'trial',
  actorId = null,
  skipEligibility = false,
  req = null
}) {
  if (!userId) throw new ValidationError('userId is required.');

  if (!skipEligibility) {
    const { eligible, reason } = await trialEligibility(userId);
    if (!eligible) {
      const err = new ValidationError(
        reason === 'already_trialed'
          ? 'This account has already used its trial.'
          : reason === 'trials_disabled'
            ? 'Trials are not available right now.'
            : 'This account already has a plan.'
      );
      err.reason = reason;
      throw err;
    }
  }

  const plan = planId && PLAN_IDS.includes(planId) ? planId : trialPlan();
  const length = Math.max(1, Number(days) || trialDays());
  const now = new Date();
  const endsAt = new Date(now.getTime() + length * DAY_MS);

  // An admin-granted trial can be handed to someone who already has a plan, so
  // close whatever is live first rather than letting the unique index reject it.
  await closeLive(userId, 'expired');

  const row = await db.insert('subscriptions', {
    user_id: userId,
    plan_id: plan,
    status: 'trialing',
    term: 'month',
    current_period_start: now.toISOString(),
    current_period_end: endsAt.toISOString(),
    trial_started_at: now.toISOString(),
    trial_ends_at: endsAt.toISOString(),
    source,
    granted_by: actorId
  });

  await recomputeUser(userId);
  await writeAudit({
    actorId: actorId || userId,
    action: 'trial.start',
    targetUser: userId,
    payload: { planId: plan, days: length, endsAt: endsAt.toISOString(), source },
    req
  });
  return row;
}

export async function cancelTrial({ userId, actorId = null, req = null }) {
  const live = await activeSubscription(userId);
  if (!live || live.status !== 'trialing') throw new ValidationError('No trial to cancel.');
  return cancelSubscription({
    subscriptionId: live.id,
    atPeriodEnd: true,
    actorId: actorId || userId,
    req
  });
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

export async function listSeats(subscriptionId) {
  return db.select('subscription_seats', {
    select: '*',
    subscription_id: `eq.${subscriptionId}`,
    released_at: 'is.null',
    order: 'assigned_at.asc'
  });
}

export async function seatCapacity(subscriptionId) {
  const sub = await db.selectOne('subscriptions', {
    select: 'id,plan_id,plans(seat_capacity)',
    id: `eq.${subscriptionId}`
  });
  const capacity = Number(sub?.plans?.seat_capacity);
  return Number.isFinite(capacity) ? capacity : 0;
}

/**
 * Lend a seat. Counts seats on the *subscription*, which is what makes Elite's
 * 14 a pool across its two teams rather than 7 fixed per team.
 */
export async function assignSeat({ subscriptionId, userId, teamId = null, actorId = null, req = null }) {
  if (!subscriptionId || !userId) throw new ValidationError('subscriptionId and userId are required.');

  const [capacity, seats] = await Promise.all([
    seatCapacity(subscriptionId),
    listSeats(subscriptionId)
  ]);

  if (seats.some((s) => s.user_id === userId)) {
    throw new ValidationError('That account already holds a seat on this plan.');
  }
  if (capacity >= 0 && seats.length >= capacity) {
    throw new ValidationError(`This plan has ${capacity} seats and they are all taken.`);
  }

  const row = await db.insert('subscription_seats', {
    subscription_id: subscriptionId,
    user_id: userId,
    team_id: teamId,
    assigned_at: new Date().toISOString()
  });

  await recomputeUser(userId);
  await writeAudit({
    actorId: actorId || userId,
    action: 'seat.assign',
    targetUser: userId,
    payload: { subscriptionId, teamId, seatId: row?.id, used: seats.length + 1, capacity },
    req
  });
  return row;
}

/** Release a seat. The row is kept, stamped, so a cooldown can be enforced. */
export async function releaseSeat({ seatId, actorId = null, req = null }) {
  const existing = await db.selectOne('subscription_seats', { select: '*', id: `eq.${seatId}` });
  if (!existing) throw new ValidationError('That seat does not exist.');
  if (existing.released_at) return existing;

  const [updated] = await db.update(
    'subscription_seats',
    { id: `eq.${seatId}` },
    { released_at: new Date().toISOString() }
  );

  if (existing.user_id) await recomputeUser(existing.user_id);
  await writeAudit({
    actorId: actorId || existing.user_id,
    action: 'seat.release',
    targetUser: existing.user_id,
    payload: { seatId, subscriptionId: existing.subscription_id },
    req
  });
  return updated;
}

/** Seats this account currently sits on, with the lending plan. */
export async function seatsHeldBy(userId) {
  return db.select('subscription_seats', {
    select: '*,subscription:subscriptions(*)',
    user_id: `eq.${userId}`,
    released_at: 'is.null'
  });
}

// ---------------------------------------------------------------------------
// server/entitlements/sweep.js
// The periodic job: convert or expire trials, lapse subscriptions, warn, tidy.
//
// Note what the sweep is NOT responsible for. Entitlement resolution is already
// time-aware at read, so an expired trial stops granting access the moment it
// ends whether or not this job has run. The sweep exists to move rows into
// their final state, send the notices, and keep the denormalised copies fresh.
// A sweep that has not run for a day is a reporting problem, not a security one.
// ---------------------------------------------------------------------------

import { PLAN_NAMES } from '../../shared/entitlements/catalogue.js';
import { markNotified, notify, wasNotified } from './notify.js';
import { sweepCounters } from './quota.js';
import { recomputeUser } from './recompute.js';
import { db, isConfigured } from './service.js';

const SWEEP_INTERVAL_MS = Number(process.env.AIM4_SWEEP_INTERVAL_MS || 15 * 60 * 1000);
const WARN_BEFORE_MS = 48 * 60 * 60 * 1000;

const planName = (id) => PLAN_NAMES[id] || id;

/**
 * Trials whose end date has passed.
 *
 * Two outcomes, and the split is on whether a provider is actually running the
 * trial rather than on whether billing is configured at all.
 *
 * A trial with a provider subscription behind it is left alone: the provider
 * charges when the trial ends and tells us over the webhook. A trial without
 * one has no payment method to charge, so it EXPIRES. It must never silently
 * become an active paid plan, or every trial user turns into a permanent free
 * Premium user with no way to tell them from real customers afterwards.
 */
async function convertTrials(now) {
  const due = await db.select('subscriptions', {
    select: '*',
    status: 'eq.trialing',
    trial_ends_at: `lte.${now.toISOString()}`,
    limit: 500
  });

  let expired = 0;
  let deferred = 0;

  for (const sub of due) {
    if (sub.cancel_at_period_end) {
      await setStatus(sub, 'expired', { lapsed_at: now.toISOString() });
      await notify({ userId: sub.user_id, kind: 'trial.expired', data: { planName: planName(sub.plan_id) } });
      expired++;
      continue;
    }

    // A trial the provider is running converts itself. Paddle charges when the
    // trial period ends and sends subscription.updated, which applyEvent
    // writes; doing anything here would race that webhook.
    //
    // This used to be an `if (billingConfigured())` branch that called
    // provider.cancelSubscription with `sub.id` and, on success, marked the row
    // active. Three things were wrong with it. Cancelling is not charging.
    // Marking a row active right after cancelling it is backwards. And `sub.id`
    // is our local uuid, not a provider subscription id, so the call could only
    // ever fail and drop every ending trial into `past_due` with no notice
    // sent and no lapsed_at recorded. It was unreachable while no provider
    // existed, which is why it survived this long.
    if (sub.provider_subscription_id) {
      deferred++;
      continue;
    }

    // Everything below here has no payment method behind it: an admin grant or
    // a manual trial. There is nothing to charge, so it expires. That holds
    // whether or not a provider is configured.

    await setStatus(sub, 'expired', { lapsed_at: now.toISOString() });
    await notify({
      userId: sub.user_id,
      kind: 'trial.expired',
      data: { planName: planName(sub.plan_id) }
    });
    expired++;
  }

  return { expired, deferred };
}

/** The 48 hour warning. Sent once, recorded so a restart cannot repeat it. */
async function warnEndingTrials(now) {
  const horizon = new Date(now.getTime() + WARN_BEFORE_MS).toISOString();
  const soon = await db.select('subscriptions', {
    select: '*',
    status: 'eq.trialing',
    trial_ends_at: `lte.${horizon}`,
    cancel_at_period_end: 'is.false',
    limit: 500
  });

  let warned = 0;
  for (const sub of soon) {
    if (wasNotified(sub, 'trial.ending')) continue;
    if (Date.parse(sub.trial_ends_at) <= now.getTime()) continue;
    await notify({
      userId: sub.user_id,
      kind: 'trial.ending',
      data: { planName: planName(sub.plan_id), endsAt: String(sub.trial_ends_at).slice(0, 10) }
    });
    await markNotified(sub.id, 'trial.ending');
    warned++;
  }
  return warned;
}

/** Paid periods that have run out. */
async function lapseSubscriptions(now) {
  const due = await db.select('subscriptions', {
    select: '*',
    status: 'eq.active',
    current_period_end: `lte.${now.toISOString()}`,
    limit: 500
  });

  let lapsed = 0;
  for (const sub of due) {
    await setStatus(sub, 'expired', { lapsed_at: now.toISOString() });
    await notify({
      userId: sub.user_id,
      kind: 'subscription.lapsed',
      data: {
        planName: planName(sub.plan_id),
        retentionDays: Number(process.env.AIM4_RETENTION_DAYS || 90)
      }
    });
    lapsed++;
  }
  return lapsed;
}

/**
 * Grants that expired since the last run. Resolution already ignores them, so
 * this exists only to refresh profiles.effective_* for the RLS-side readers.
 */
async function refreshAfterExpiredGrants(now) {
  const expired = await db.select('entitlement_grants', {
    select: 'user_id,expires_at',
    revoked_at: 'is.null',
    expires_at: `lte.${now.toISOString()}`,
    limit: 500
  });
  const users = [...new Set(expired.map((g) => g.user_id))];
  for (const userId of users) await recomputeUser(userId);
  return users.length;
}

async function setStatus(sub, status, patch) {
  await db.update(
    'subscriptions',
    { id: `eq.${sub.id}` },
    { status, ...patch, updated_at: new Date().toISOString() },
    { returning: false }
  );
  await recomputeUser(sub.user_id);
}

/** One pass. Exported so it can be run by hand or from a test. */
export async function runSweep() {
  if (!isConfigured()) return { skipped: 'not_configured' };
  const now = new Date();
  const result = { at: now.toISOString() };

  try {
    Object.assign(result, await convertTrials(now));
    result.warned = await warnEndingTrials(now);
    result.lapsed = await lapseSubscriptions(now);
    result.grantsRefreshed = await refreshAfterExpiredGrants(now);
    result.countersDeleted = await sweepCounters();
  } catch (err) {
    result.error = err.message;
    console.error(`[sweep] ${err.message}`);
  }
  return result;
}

let timer = null;

export function startSweep() {
  if (timer || !isConfigured()) return null;
  // Once shortly after boot so a restart catches anything missed while down,
  // then on the interval.
  const first = setTimeout(() => {
    runSweep().catch(() => {});
  }, 30_000);
  first.unref?.();

  timer = setInterval(() => {
    runSweep().catch(() => {});
  }, SWEEP_INTERVAL_MS);
  // Never a reason to hold the process open.
  timer.unref?.();
  return timer;
}

export function stopSweep() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------------------------------------------------------------------------
// server/billing/routes.js
// /api/billing/{checkout,portal,webhook}
//
// The webhook route exists from day one even though no provider is wired up,
// for two reasons. The URL can be registered with a provider before any
// provider code is written. And the raw-body handling gets proven early: once
// a JSON body parser is in the request chain it is very easy to end up
// verifying a signature against re-serialised JSON, which works in testing and
// fails on the first payload with different key ordering or a unicode escape.
//
// server/index.js caps bodies at 64 KB and JSON-parses everything, so this
// module reads the body itself, as bytes, before any of that can happen.
// ---------------------------------------------------------------------------

import { PLAN_IDS, TERM_IDS } from '../../shared/entitlements/catalogue.js';
import { BillingNotConfiguredError, billingConfigured, provider } from './provider.js';
import { whoami } from '../replays/identity.js';
import { writeAudit } from '../entitlements/audit.js';
import { recomputeUser } from '../entitlements/recompute.js';
import { db, isConfigured } from '../entitlements/service.js';

const MAX_WEBHOOK_BYTES = 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Stripe-Signature, Paddle-Signature',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

/** The exact bytes. Never parsed, never re-encoded, never touched. */
export function readRawBody(req, maxBytes = MAX_WEBHOOK_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Pause rather than destroy: the 413 still has to reach the sender, and
        // tearing the socket down here means they see a connection reset and
        // retry forever instead of reading the reason. The socket is closed
        // once the response has flushed.
        req.pause();
        const err = new Error('Payload too large');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Events already handled, so a provider's retry does not apply the same change
 * twice. Providers retry aggressively on any non-2xx, and a duplicate
 * "subscription created" would leave two live rows.
 *
 * Postgres is the real store (see 0014_billing_events.sql): the primary key on
 * the event id is the check, so two instances racing the same retry cannot
 * both decide they are first. The Map below is only the fallback for a process
 * with no database configured, where it is the best that can be done.
 */
const seenEvents = new Map();
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @returns {Promise<boolean>} true when this event has already been applied.
 */
export async function alreadyHandled(eventId, eventType = null) {
  if (!eventId) return false;

  if (isConfigured()) {
    try {
      await db.insert(
        'billing_events',
        [{ id: eventId, provider: provider.name, event_type: eventType }],
        { returning: false }
      );
      return false;
    } catch (err) {
      // 23505 is a unique violation: someone got here first.
      if (err?.status === 409 || err?.details?.code === '23505') return true;
      // Any other database failure must not silently disable the guard, and
      // must not drop the event either. Say so, then fall back to memory.
      console.error(`[billing] idempotency store unavailable (${err?.message}), using memory`);
    }
  }

  return seenInMemory(eventId);
}

/**
 * Give the claim back, so a provider's retry is allowed to try again.
 *
 * alreadyHandled() records an event before it is applied, which is what stops
 * two instances racing the same delivery. The cost is that a failure would
 * otherwise leave the id recorded and the work undone: the retry that exists
 * precisely for this case would come back as "duplicate" and the payment would
 * never be written. Releasing on failure keeps the race protection and lets
 * the retry work.
 */
export async function releaseEvent(eventId) {
  if (!eventId) return;
  seenEvents.delete(eventId);
  if (!isConfigured()) return;
  try {
    await db.remove('billing_events', { id: `eq.${eventId}` });
  } catch (err) {
    // The claim outlives the failure. Say so loudly: this is the case where a
    // retry will be wrongly refused and someone has to look.
    console.error(
      `[billing] could not release event ${eventId} (${err?.message}). ` +
        `A retry of it will be treated as a duplicate.`
    );
  }
}

function seenInMemory(eventId) {
  const now = Date.now();
  for (const [id, at] of seenEvents) {
    if (now - at > EVENT_TTL_MS) seenEvents.delete(id);
  }
  if (seenEvents.has(eventId)) return true;
  seenEvents.set(eventId, now);
  return false;
}

export function _resetSeenEvents() {
  seenEvents.clear();
}

/**
 * Map a provider status onto ours. Exported so the mapping is testable before
 * there is anything to test it against.
 */
export function mapProviderStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'trialing':
      return 'trialing';
    case 'active':
    case 'paid':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'incomplete_expired':
    case 'expired':
    // Paddle pauses a subscription rather than cancelling it in some dunning
    // and customer-portal flows. It is not cancelled and nothing is owed, but
    // it must stop granting entitlements while it is paused, and `expired` is
    // the status that already means exactly that everywhere downstream.
    case 'paused':
      return 'expired';
    default:
      return null;
  }
}

/**
 * @returns {Promise<boolean>} true when this request was a billing route.
 */
export async function handleBillingRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/billing')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  // ---- webhook ------------------------------------------------------------
  if (req.method === 'POST' && p === '/api/billing/webhook') {
    let raw;
    try {
      raw = await readRawBody(req);
    } catch (err) {
      res.setHeader('Connection', 'close');
      res.once('finish', () => req.destroy());
      json(res, 413, { error: err.message });
      return true;
    }

    const signature =
      req.headers['stripe-signature'] || req.headers['paddle-signature'] || '';

    if (!billingConfigured()) {
      // 200 rather than an error: an unconfigured endpoint that returns 4xx
      // gets retried forever and eventually disabled by the provider. Log and
      // drop, so the URL can be registered before the integration exists.
      console.log(`[billing] webhook received while unconfigured (${raw.length} bytes), dropped`);
      json(res, 200, { received: true, handled: false, reason: 'billing_not_configured' });
      return true;
    }

    const event = provider.verifyWebhook(raw, signature);
    if (!event) {
      json(res, 400, { error: 'invalid_signature' });
      return true;
    }
    if (await alreadyHandled(event.id, event.type)) {
      json(res, 200, { received: true, handled: false, reason: 'duplicate' });
      return true;
    }

    let handled;
    try {
      handled = await applyEvent(event);
    } catch (err) {
      // The claim taken above has to go back, or the retry Paddle is about to
      // send is refused as a duplicate and the payment is lost.
      await releaseEvent(event.id);
      // 500 so it IS retried. Paddle gives up after about three days and shows
      // the failure in the dashboard, which is the right outcome for "someone
      // paid and we could not record it": retried, then loud.
      console.error(`[billing] applying ${event.id} (${event.type}) failed: ${err?.message}`);
      // Never the database's own words. A constraint name in a response body
      // tells an attacker the schema and tells Paddle nothing useful.
      json(res, 500, { error: 'apply_failed', eventId: event.id });
      return true;
    }
    json(res, 200, { received: true, handled });
    return true;
  }

  // ---- checkout and portal ------------------------------------------------
  if (
    req.method === 'POST' &&
    (p === '/api/billing/checkout' || p === '/api/billing/portal' || p === '/api/billing/change-plan')
  ) {
    const me = await whoami(req);
    if (!me.signedIn) {
      json(res, 401, { error: 'Sign in first.' });
      return true;
    }
    if (!billingConfigured()) {
      json(res, 501, {
        error: 'billing_not_configured',
        // The account page reads this and hides the payment controls rather
        // than rendering a button that cannot work.
        message: 'Payment is not available yet.'
      });
      return true;
    }
    try {
      const body = await readRawBody(req, 16 * 1024);
      const parsed = body.length ? JSON.parse(body.toString('utf8')) : {};
      let session;
      if (p === '/api/billing/checkout') {
        // Validated here rather than inside the provider. Whatever provider
        // lands will map (planId, term) to one of its own price ids, and a
        // typo that reaches that lookup fails as "no such price" at the point
        // where a customer is trying to pay. Refusing it at the door instead
        // keeps the failure legible, and it is the only check that exists
        // while the provider is still a stub.
        const planId = String(parsed.planId || '');
        const term = String(parsed.term || 'month');
        if (!PLAN_IDS.includes(planId) || planId === 'free') {
          json(res, 400, { error: `Unknown plan: ${parsed.planId}` });
          return true;
        }
        if (!TERM_IDS.includes(term)) {
          json(res, 400, { error: `Unknown term: ${parsed.term}` });
          return true;
        }
        // A customer who already has a subscription must never be sold a
        // second one. Two live subscriptions bill in parallel: the entitlement
        // side copes (applyEvent displaces the old row) but the customer pays
        // twice, which no amount of downstream cleverness fixes. Paddle changes
        // the plan on the subscription they already have, prorated.
        const current = await provider.activeSubscriptionFor(me.id);
        if (current) {
          // Preview only. The change bills the card on file with no checkout
          // screen, so the page has to show the amount and get a yes first.
          session = await provider.previewPlanChange({ userId: me.id, planId, term });
        } else {
          session = await provider.createCheckoutSession({ userId: me.id, planId, term });
        }
      } else if (p === '/api/billing/change-plan') {
        const planId = String(parsed.planId || '');
        const term = String(parsed.term || 'month');
        if (!PLAN_IDS.includes(planId) || planId === 'free') {
          json(res, 400, { error: `Unknown plan: ${parsed.planId}` });
          return true;
        }
        if (!TERM_IDS.includes(term)) {
          json(res, 400, { error: `Unknown term: ${parsed.term}` });
          return true;
        }
        // The client has to say it showed the customer a price and got a yes.
        // Applying a charge because a request arrived is how people get billed
        // by a stray double-click.
        if (parsed.confirm !== true) {
          json(res, 400, { error: 'confirm_required' });
          return true;
        }
        session = await provider.applyPlanChange({ userId: me.id, planId, term });
      } else {
        session = await provider.createPortalSession({ userId: me.id });
      }
      json(res, 200, session);
    } catch (err) {
      const status = err instanceof BillingNotConfiguredError ? 501 : 400;
      json(res, status, { error: err.message });
    }
    return true;
  }

  if (req.method === 'GET' && p === '/api/billing/status') {
    // The client token and environment come from here rather than from a VITE_
    // build variable so that moving sandbox -> live is a server env change and
    // a restart, not a rebuild and redeploy of the browser bundle. It also
    // keeps one source of truth: the same process that talks to Paddle decides
    // which Paddle the page talks to.
    const client = provider.clientConfig();
    json(res, 200, {
      configured: billingConfigured() && client.ok,
      provider: provider.name,
      environment: client.environment || null,
      clientToken: client.clientToken || null,
      // Only ever a configuration complaint, never a Paddle error body.
      error: client.ok ? null : client.error
    });
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}

/**
 * Map the status, write the row, recompute.
 *
 * Three paths, in order. A subscription we already track is updated. A
 * subscription we have never seen before, for a user who already has a live
 * row, takes that row over: a trial converting to paid is the same
 * subscription to the customer, and subscriptions_one_active_per_user is a
 * partial unique index that would reject a second live row anyway. Anything
 * else is a fresh insert.
 *
 * The first paid event arrives with no local row at all, because checkout
 * happens entirely on Paddle's side. Without the second and third paths a
 * customer pays and is granted nothing.
 */
export async function applyEvent(event, deps = {}) {
  // The seam exists so the three-path dispatch below can be tested without a
  // database. Production always uses the defaults; nothing passes `deps` except
  // webhook.test.js, and writing invented subscriptions into a real table just
  // to prove the dispatch works would be a poor trade.
  const {
    db: store = db,
    provider: prov = provider,
    recomputeUser: recompute = recomputeUser,
    writeAudit: audit = writeAudit,
    configured = isConfigured
  } = deps;

  if (!configured()) return false;
  const status = mapProviderStatus(event?.data?.status);
  const providerSubscriptionId = event?.data?.subscriptionId;
  if (!status || !providerSubscriptionId) return false;

  const d = event.data;
  const now = new Date().toISOString();
  const LIVE = '(trialing,active,past_due)';

  // What the customer is actually being billed for, which is not necessarily
  // what they first bought. A tier change inside Paddle keeps the original
  // custom_data, so the price ids on the event are the truth and custom_data
  // is only the fallback for events that carry no items.
  const billed = await prov.planForPriceIds(d.priceIds).catch(() => null);
  const planId = billed?.planId || d.planId;
  const term = billed?.term || d.term;
  const planIsUsable = PLAN_IDS.includes(planId) && planId !== 'free' && TERM_IDS.includes(term);

  const patch = {
    status,
    provider_status: d.status,
    current_period_end: d.currentPeriodEnd || null,
    updated_at: now
  };
  if (typeof d.cancelAtPeriodEnd === 'boolean') patch.cancel_at_period_end = d.cancelAtPeriodEnd;
  // Without this an upgrade made in Paddle charges the new price and leaves
  // the old entitlements in place, which is the worst of both for the customer.
  if (planIsUsable) {
    patch.plan_id = planId;
    patch.term = term;
  }

  // 1. Already tracked.
  const [known] = await store.update(
    'subscriptions',
    { provider_subscription_id: `eq.${providerSubscriptionId}` },
    patch
  );
  // No "was this a tier change?" flag here on purpose. A PATCH comes back as
  // the row after the write, so the old plan is already gone by this point,
  // and a SELECT on every webhook to recover it would buy nothing the audit
  // log does not already give: each entry records the plan it settled on, so
  // a change is two consecutive entries that disagree.
  if (known) return finish(known, 'updated');

  // Past this point the event is about a subscription we do not track. Only a
  // subscription that is actually granting may take a live row over.
  //
  // Without this, a `canceled` event for an OLD subscription displaced the
  // customer's CURRENT one: the row was rewritten to the dead subscription and
  // marked cancelled, so someone who had just paid was entitled to nothing.
  // Cancelling a superseded subscription is routine, which made it routine to
  // revoke the wrong plan. A terminal event for something we never tracked
  // grants nothing and must change nothing.
  if (status !== 'active' && status !== 'trialing') {
    console.log(
      `[billing] ${providerSubscriptionId} is ${status} and is not the tracked ` +
        `subscription for this account, so there is nothing to grant. Ignored.`
    );
    return false;
  }

  // Attribution comes from custom_data, which createCheckoutSession set and
  // the signature check just vouched for. Without a user id there is nothing
  // to grant, and guessing by email would let a forged address take over an
  // account.
  const userId = d.userId;
  if (!userId || !planIsUsable) {
    console.warn(
      `[billing] ${providerSubscriptionId} cannot be attributed ` +
        `(user=${userId || '-'} plan=${planId || '-'} term=${term || '-'}), dropped`
    );
    return false;
  }

  const claim = {
    ...patch,
    plan_id: planId,
    term,
    provider: prov.name,
    provider_customer_id: d.customerId || null,
    provider_subscription_id: providerSubscriptionId,
    current_period_start: d.currentPeriodStart || now,
    source: 'billing'
  };

  // 2. The user has a live row already. Take it over rather than racing the
  //    partial unique index, but look at what is there first: adopting a trial
  //    and quietly discarding a second paid subscription are very different
  //    things, and a blind PATCH cannot tell them apart.
  const live = await store.selectOne('subscriptions', {
    select: 'id,provider_subscription_id,plan_id,source',
    user_id: `eq.${userId}`,
    status: `in.${LIVE}`
  });

  if (live) {
    const displaced = live.provider_subscription_id;
    const isSecondPaid = Boolean(displaced) && displaced !== providerSubscriptionId;

    if (isSecondPaid) {
      // Two live Paddle subscriptions for one account, so the customer is
      // being charged twice. Granting the new one is still right, because they
      // paid for it and refusing would repeat the "paid for nothing" failure.
      // What must not happen is losing the reference to the old one: it is
      // still billing, and cancelling it is a money decision for a person, not
      // something to fire off from a webhook handler.
      console.error(
        `[billing] user ${userId} now has two live Paddle subscriptions. ` +
          `Granting ${providerSubscriptionId}; ${displaced} is still billing and needs cancelling.`
      );
      claim.notes = `Displaced ${displaced} on ${now}. Still live in Paddle, cancel it.`;
    }

    const [adopted] = await store.update('subscriptions', { id: `eq.${live.id}` }, claim);
    if (adopted) {
      return finish(adopted, isSecondPaid ? 'displaced' : 'adopted', { displaced: displaced || null });
    }
  }

  // 3. Nothing to take over. db.insert returns the row itself, not an array.
  const created = await store.insert('subscriptions', [{ user_id: userId, ...claim }]);
  if (!created?.user_id) return false;
  return finish(created, 'created');

  async function finish(row, outcome, extra = null) {
    await recompute(row.user_id);
    await audit({
      actorId: row.user_id,
      action: 'billing.webhook',
      targetUser: row.user_id,
      payload: {
        eventId: event.id,
        eventType: event.type || null,
        outcome,
        status,
        planId: row.plan_id,
        term: row.term,
        // Which source decided the plan. 'price' means it was read off what
        // Paddle is billing; 'custom_data' means the event carried no items
        // and the checkout's own claim was used instead.
        planFrom: billed ? 'price' : 'custom_data',
        providerSubscriptionId,
        ...(extra || {})
      }
    });
    return true;
  }
}

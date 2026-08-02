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
 * In memory, which is right for a single backend process. A multi-instance
 * deploy needs this in Postgres before it can be trusted.
 */
const seenEvents = new Map();
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;

export function alreadyHandled(eventId) {
  if (!eventId) return false;
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
    if (alreadyHandled(event.id)) {
      json(res, 200, { received: true, handled: false, reason: 'duplicate' });
      return true;
    }

    const handled = await applyEvent(event);
    json(res, 200, { received: true, handled });
    return true;
  }

  // ---- checkout and portal ------------------------------------------------
  if (req.method === 'POST' && (p === '/api/billing/checkout' || p === '/api/billing/portal')) {
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
      const session =
        p === '/api/billing/checkout'
          ? await provider.createCheckoutSession({
              userId: me.id,
              planId: parsed.planId,
              term: parsed.term
            })
          : await provider.createPortalSession({ userId: me.id });
      json(res, 200, session);
    } catch (err) {
      const status = err instanceof BillingNotConfiguredError ? 501 : 400;
      json(res, status, { error: err.message });
    }
    return true;
  }

  if (req.method === 'GET' && p === '/api/billing/status') {
    json(res, 200, { configured: billingConfigured(), provider: provider.name });
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}

/**
 * The whole of the future integration: map the status, write the row,
 * recompute. Written now so the shape is settled.
 */
async function applyEvent(event) {
  if (!isConfigured()) return false;
  const status = mapProviderStatus(event?.data?.status);
  const providerSubscriptionId = event?.data?.subscriptionId;
  if (!status || !providerSubscriptionId) return false;

  const [row] = await db.update(
    'subscriptions',
    { provider_subscription_id: `eq.${providerSubscriptionId}` },
    {
      status,
      provider_status: event.data.status,
      current_period_end: event.data.currentPeriodEnd || null,
      updated_at: new Date().toISOString()
    }
  );
  if (!row) return false;

  await recomputeUser(row.user_id);
  await writeAudit({
    actorId: row.user_id,
    action: 'billing.webhook',
    targetUser: row.user_id,
    payload: { eventId: event.id, status, providerSubscriptionId }
  });
  return true;
}

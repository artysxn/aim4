// ---------------------------------------------------------------------------
// server/billing/paddle.js
// The Paddle side of the billing hole described in provider.js.
//
// provider.js imports this statically, because routes.js verifies a webhook
// signature synchronously and cannot await an adapter. Importing it is free
// though: nothing here reads env or touches the network until it is called, so
// a deploy without Paddle credentials behaves exactly as it did before this
// file existed. provider.name stays null and every route answers 501.
//
// Price ids are NOT hardcoded. They live in plans.provider_price_ids, written
// by scripts/sync-paddle-prices.mjs from whatever catalogue the target Paddle
// account actually holds. Sandbox and live have different ids for the same
// plan, so a constant here would be wrong in one environment or the other.
//
// Env:
//   PADDLE_API_KEY          server-side key. sandbox and live keys differ.
//   PADDLE_WEBHOOK_SECRET   the notification destination's secret, ntfset_...
//   PADDLE_ENV              'sandbox' | 'live'. No default, on purpose.
//   PADDLE_CLIENT_TOKEN     browser token for Paddle.js. Public by design.
//   PADDLE_CHECKOUT_URL     approved domain for the hosted payment link.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

import { authAdmin, db, isConfigured } from '../entitlements/service.js';

const API_BASE = {
  sandbox: 'https://sandbox-api.paddle.com',
  live: 'https://api.paddle.com'
};

/** Paddle signs `ts:rawBody`. Anything older than this is a replay. */
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/**
 * 'sandbox' | 'live', and never a guess.
 *
 * Defaulting this would mean an unset or fat-fingered variable silently picks
 * an account, and the two accounts have different money in them. A deploy that
 * means to charge people and quietly runs against sandbox looks like it works
 * until someone checks the bank. Refusing to start is the cheaper failure.
 */
export function paddleEnv() {
  const raw = process.env.PADDLE_ENV;
  if (raw !== 'sandbox' && raw !== 'live') {
    throw new PaddleError(
      `PADDLE_ENV must be exactly 'sandbox' or 'live' (got ${raw ? `'${raw}'` : 'nothing'})`,
      500
    );
  }
  return raw;
}

function apiBase() {
  return API_BASE[paddleEnv()];
}

/**
 * PADDLE_API_KEY is the one that matters. The per-environment names are
 * accepted too because sandbox and live keys are different secrets that people
 * reasonably keep side by side rather than swapping one variable back and
 * forth, and picking the wrong one up is a charge against the wrong account.
 */
export function apiKey() {
  const specific =
    paddleEnv() === 'live' ? process.env.PADDLE_LIVE_API_KEY : process.env.PADDLE_SANDBOX_API_KEY;
  return process.env.PADDLE_API_KEY || specific || '';
}

export class PaddleError extends Error {
  constructor(message, status = 400, detail = null) {
    super(message);
    this.name = 'PaddleError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * One request to the Paddle API. Thin on purpose: the interesting logic is the
 * mapping either side of it, and a wrapper that hides the status code makes a
 * failed charge harder to diagnose, not easier.
 */
async function api(path, { method = 'GET', body } = {}) {
  const key = apiKey();
  if (!key) throw new PaddleError('PADDLE_API_KEY is not set', 500);

  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new PaddleError(`Paddle returned non-JSON (${res.status})`, 502, text.slice(0, 500));
  }

  if (!res.ok) {
    const err = payload?.error || {};
    throw new PaddleError(err.detail || err.code || `Paddle ${res.status}`, res.status, err);
  }
  return payload?.data ?? null;
}

// ---------------------------------------------------------------------------
// Price lookup
// ---------------------------------------------------------------------------

/**
 * plan_id -> { month, quarter, halfyear, year } -> pri_...
 *
 * Cached for a minute. A checkout that races a price sync should fail loudly
 * on Paddle's side ("no such price") rather than quietly charge an old amount,
 * which is why this cache is short and holds ids rather than amounts.
 */
let priceCache = null;
let priceCacheAt = 0;
const PRICE_TTL_MS = 60 * 1000;

export function _resetPriceCache() {
  priceCache = null;
  priceCacheAt = 0;
}

async function priceMap() {
  const now = Date.now();
  if (priceCache && now - priceCacheAt < PRICE_TTL_MS) return priceCache;
  if (!isConfigured()) throw new PaddleError('Database is not configured', 500);

  const rows = await db.select('plans', { select: 'id,provider_price_ids,billing_provider' });
  const map = {};
  for (const row of rows) {
    if (row.billing_provider && row.billing_provider !== 'paddle') continue;
    if (row.provider_price_ids && Object.keys(row.provider_price_ids).length) {
      map[row.id] = row.provider_price_ids;
    }
  }
  priceCache = map;
  priceCacheAt = now;
  return map;
}

/**
 * The reverse lookup: which plan and term do these price ids name?
 *
 * This is what a subscription event actually bills, so it beats the
 * custom_data written at checkout. After a tier change inside Paddle the
 * custom_data still says whatever the customer first bought, and trusting it
 * would leave someone paying for Elite on Lite entitlements.
 *
 * @param {string[]} priceIds
 * @returns {Promise<{planId: string, term: string} | null>}
 */
export async function planForPriceIds(priceIds) {
  if (!Array.isArray(priceIds) || !priceIds.length) return null;
  const map = await priceMap();
  for (const [planId, terms] of Object.entries(map)) {
    for (const [term, id] of Object.entries(terms)) {
      if (priceIds.includes(id)) return { planId, term };
    }
  }
  return null;
}

export async function priceIdFor(planId, term) {
  const map = await priceMap();
  const forPlan = map[planId];
  if (!forPlan) {
    throw new PaddleError(
      `No Paddle prices for plan ${planId}. Run scripts/sync-paddle-prices.mjs --push.`,
      503
    );
  }
  const priceId = forPlan[term];
  if (!priceId) {
    throw new PaddleError(`No Paddle price for ${planId} on the ${term} term.`, 503);
  }
  return priceId;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * The Paddle customer for one of our users, created on first checkout.
 *
 * Paddle rejects a second customer with the same email, so a create that fails
 * that way is resolved by looking the existing one up rather than surfacing a
 * conflict to someone trying to pay.
 */
async function customerFor({ userId, email }) {
  const existing = await db.selectOne('subscriptions', {
    select: 'provider_customer_id',
    user_id: `eq.${userId}`,
    provider: 'eq.paddle',
    provider_customer_id: 'not.is.null',
    order: 'created_at.desc'
  });
  if (existing?.provider_customer_id) return existing.provider_customer_id;

  // whoami() does not carry an email, and widening it for one caller is worse
  // than one lookup on a path that is about to do several network round trips.
  let address = email;
  if (!address) {
    const user = await authAdmin.getUser(userId).catch(() => null);
    address = user?.email || '';
  }
  if (!address) throw new PaddleError('An email address is required to check out', 400);

  try {
    const created = await api('/customers', {
      method: 'POST',
      body: { email: address, custom_data: { user_id: userId } }
    });
    return created.id;
  } catch (err) {
    if (err instanceof PaddleError && err.status === 409) {
      const found = await api(`/customers?email=${encodeURIComponent(address)}&per_page=1`);
      if (found?.[0]?.id) return found[0].id;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The provider surface
// ---------------------------------------------------------------------------

/**
 * A transaction in `ready` state, which Paddle.js opens as an overlay
 * checkout. `checkoutUrl` is the hosted fallback for anywhere Paddle.js is not
 * loaded.
 */
export async function createCheckoutSession({ userId, planId, term, email }) {
  const priceId = await priceIdFor(planId, term);
  const customerId = await customerFor({ userId, email });

  const body = {
    customer_id: customerId,
    collection_mode: 'automatic',
    items: [{ price_id: priceId, quantity: 1 }],
    // Read back in verifyWebhook. Paddle echoes custom_data onto the
    // subscription it creates, which is the only link between a Paddle
    // subscription and one of our users that survives a checkout the user
    // completes days later on another device.
    custom_data: { user_id: userId, plan_id: planId, term }
  };
  if (process.env.PADDLE_CHECKOUT_URL) {
    body.checkout = { url: process.env.PADDLE_CHECKOUT_URL };
  }

  const tx = await api('/transactions', { method: 'POST', body });
  return {
    provider: 'paddle',
    transactionId: tx.id,
    checkoutUrl: tx.checkout?.url || null,
    customerId,
    priceId,
    planId,
    term
  };
}

export async function createPortalSession({ userId }) {
  if (!isConfigured()) throw new PaddleError('Database is not configured', 500);

  const sub = await db.selectOne('subscriptions', {
    select: 'provider_customer_id,provider_subscription_id',
    user_id: `eq.${userId}`,
    provider: 'eq.paddle',
    provider_customer_id: 'not.is.null',
    order: 'created_at.desc'
  });
  if (!sub?.provider_customer_id) {
    throw new PaddleError('No Paddle customer for this account yet', 404);
  }

  const body = sub.provider_subscription_id
    ? { subscription_ids: [sub.provider_subscription_id] }
    : {};
  const session = await api(`/customers/${sub.provider_customer_id}/portal-sessions`, {
    method: 'POST',
    body
  });

  return {
    provider: 'paddle',
    url: session.urls?.general?.overview || null,
    subscriptionUrls: session.urls?.subscriptions || []
  };
}

/**
 * Telling Paddle is the part that matters. The local row is updated by the
 * webhook Paddle sends back, not here, so that a cancellation applied in the
 * Paddle dashboard and one applied here converge on the same path.
 */
export async function cancelSubscription({ subscriptionId, atPeriodEnd = true }) {
  if (!subscriptionId) throw new PaddleError('subscriptionId is required', 400);
  const data = await api(`/subscriptions/${subscriptionId}/cancel`, {
    method: 'POST',
    body: { effective_from: atPeriodEnd ? 'next_billing_period' : 'immediately' }
  });
  return {
    provider: 'paddle',
    subscriptionId,
    atPeriodEnd,
    status: data?.status ?? null,
    scheduledChange: data?.scheduled_change ?? null
  };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Parse `ts=1671552777;h1=<hex>` into its parts. Paddle may add further hN
 * versions later; unknown keys are ignored rather than rejected so that a new
 * algorithm being added does not take the endpoint down.
 */
export function parseSignatureHeader(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

/**
 * True when `h1` is a correct HMAC-SHA256 of `ts:rawBody` under the secret.
 *
 * rawBody must be the exact bytes received. routes.js reads the body before
 * anything can parse it for precisely this reason.
 */
export function signatureIsValid(rawBody, header, secret = process.env.PADDLE_WEBHOOK_SECRET, now = Date.now()) {
  if (!secret) return false;
  const { ts, h1 } = parseSignatureHeader(header);
  if (!ts || !h1) return false;

  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return false;
  if (Math.abs(now - seconds * 1000) > MAX_SIGNATURE_AGE_MS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${ts}:`)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'))
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(h1), 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // nothing useful but still an exception on a hot path.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verify, then flatten Paddle's event into the shape applyEvent consumes.
 * Returns null when the signature cannot be trusted, which routes.js answers
 * with a 400 rather than a retry-forever 5xx.
 */
export function verifyWebhook(rawBody, signature) {
  if (!signatureIsValid(rawBody, signature)) return null;

  let event;
  try {
    event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    return null;
  }

  const d = event?.data || {};
  const custom = d.custom_data || {};
  const isSubscription = String(event?.event_type || '').startsWith('subscription.');

  return {
    id: event?.event_id || event?.id || null,
    type: event?.event_type || null,
    occurredAt: event?.occurred_at || null,
    data: {
      // applyEvent reads these three.
      status: d.status ?? null,
      subscriptionId: isSubscription ? d.id ?? null : d.subscription_id ?? null,
      currentPeriodEnd: d.current_billing_period?.ends_at ?? null,
      // Everything below is for creating a row that does not exist yet.
      currentPeriodStart: d.current_billing_period?.starts_at ?? null,
      customerId: d.customer_id ?? null,
      cancelAtPeriodEnd: d.scheduled_change?.action === 'cancel',
      priceIds: Array.isArray(d.items) ? d.items.map((i) => i?.price?.id).filter(Boolean) : [],
      userId: custom.user_id ?? null,
      planId: custom.plan_id ?? null,
      term: custom.term ?? null
    }
  };
}

/**
 * What the browser needs to open a checkout, and nothing else.
 *
 * The client-side token is public by design: it is scoped to opening checkouts
 * and is meant to sit in a page. PADDLE_API_KEY is not, and must never be
 * returned from here or reach any file under src/.
 *
 * Returned as data rather than thrown so that a misconfigured billing setup
 * degrades to a disabled Upgrade button instead of taking the whole account
 * page down with a 500.
 */
export function clientConfig() {
  try {
    const environment = paddleEnv();
    const token = process.env.PADDLE_CLIENT_TOKEN || '';
    if (!token) {
      return { ok: false, error: 'PADDLE_CLIENT_TOKEN is not set' };
    }
    // A live token on sandbox, or the reverse, opens a checkout against the
    // wrong account and fails somewhere much less obvious than here.
    const expected = environment === 'live' ? 'live_' : 'test_';
    if (!token.startsWith(expected)) {
      return {
        ok: false,
        error: `PADDLE_CLIENT_TOKEN should start with '${expected}' on ${environment}`
      };
    }
    return { ok: true, environment, clientToken: token };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export const paddle = {
  name: 'paddle',
  createCheckoutSession,
  createPortalSession,
  cancelSubscription,
  verifyWebhook,
  clientConfig,
  planForPriceIds
};

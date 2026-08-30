// ---------------------------------------------------------------------------
// server/billing/provider.js
// The billing hole, and the one provider that now fills it.
//
// Everything a provider needs already existed in the schema and was unused:
// plans.billing_provider, plans.provider_price_ids, subscriptions.provider*,
// current_period_end, cancel_at_period_end, and subscriptions.source telling
// admin / trial / billing apart.
//
// Selection is by env, and the default is still null. A deploy that sets
// nothing behaves exactly as it did before this file grew a provider: every
// billing route answers 501 and the account page hides its payment controls.
//
//   AIM4_BILLING_PROVIDER=paddle   plus PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET
//
// Stripe is still a hole. It would slot in beside `paddle` below.
// ---------------------------------------------------------------------------

import { paddle } from './paddle.js';

export class BillingNotConfiguredError extends Error {
  constructor() {
    super('billing_not_configured');
    this.name = 'BillingNotConfiguredError';
    this.status = 501;
  }
}

/**
 * Adapters by name. `verifyWebhook` has to stay synchronous because routes.js
 * verifies before it does anything else with the request, so the adapter is
 * imported statically rather than loaded on demand.
 */
const ADAPTERS = { paddle };

const NAME = process.env.AIM4_BILLING_PROVIDER || null;
const ACTIVE = NAME ? ADAPTERS[NAME] || null : null;

if (NAME && !ACTIVE) {
  console.warn(
    `[billing] AIM4_BILLING_PROVIDER=${NAME} is not a provider this build knows about. ` +
      `Known: ${Object.keys(ADAPTERS).join(', ')}. Billing stays disabled.`
  );
}

export const provider = {
  /** 'paddle' | null. Null when unset, or set to something unrecognised. */
  name: ACTIVE ? NAME : null,

  async createCheckoutSession({ userId, planId, term, email }) {
    if (!ACTIVE) throw new BillingNotConfiguredError();
    return ACTIVE.createCheckoutSession({ userId, planId, term, email });
  },

  async createPortalSession({ userId }) {
    if (!ACTIVE) throw new BillingNotConfiguredError();
    return ACTIVE.createPortalSession({ userId });
  },

  /**
   * Cancellation worked before any provider existed: the local path sets
   * cancel_at_period_end and the sweep does the rest. With a provider wired up
   * the provider has to be told too, or the customer keeps being charged.
   *
   * The local row is deliberately NOT written here. Paddle answers a cancel
   * with a webhook, and letting that webhook be the only writer means a
   * cancellation made in the Paddle dashboard and one made here converge on
   * one code path instead of two that can disagree.
   */
  async cancelSubscription({ subscriptionId, atPeriodEnd = true }) {
    if (!ACTIVE) return { local: true, subscriptionId, atPeriodEnd, provider: null };
    return ACTIVE.cancelSubscription({ subscriptionId, atPeriodEnd });
  },

  /**
   * Verify a webhook signature over the exact bytes received.
   * Returns the parsed event, or null when it cannot be trusted.
   */
  verifyWebhook(rawBody, signature) {
    if (!ACTIVE) return null;
    return ACTIVE.verifyWebhook(rawBody, signature);
  },

  /**
   * Public, browser-safe configuration. Never contains a server API key.
   * `{ ok: false, error }` when the provider is misconfigured, so the caller
   * can disable the buy button and say why rather than fail opaquely.
   */
  clientConfig() {
    if (!ACTIVE) return { ok: false, error: 'billing_not_configured' };
    return ACTIVE.clientConfig ? ACTIVE.clientConfig() : { ok: false, error: 'unsupported' };
  },

  /**
   * Which plan and term a set of provider price ids names, or null.
   * Lets the webhook read the plan off what is actually being billed rather
   * than off the custom_data written when the customer first checked out.
   */
  async planForPriceIds(priceIds) {
    if (!ACTIVE?.planForPriceIds) return null;
    return ACTIVE.planForPriceIds(priceIds);
  }
};

export function billingConfigured() {
  return Boolean(provider.name);
}

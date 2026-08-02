// ---------------------------------------------------------------------------
// server/billing/provider.js
// The billing-shaped hole, with real signatures.
//
// No provider is wired up. Everything a provider needs already exists in the
// schema and is simply unused: plans.billing_provider, plans.provider_price_ids,
// subscriptions.provider*, current_period_end, cancel_at_period_end, and
// subscriptions.source telling admin / trial / billing apart.
//
// When a provider does land, the only new logic is: webhook receives event,
// map its status to subscriptions.status, write the row, recomputeUser(). Every
// downstream consumer already works, because they read entitlements rather than
// Stripe.
// ---------------------------------------------------------------------------

export class BillingNotConfiguredError extends Error {
  constructor() {
    super('billing_not_configured');
    this.name = 'BillingNotConfiguredError';
    this.status = 501;
  }
}

export const provider = {
  /** 'stripe' | 'paddle' | null. Null is the whole point right now. */
  name: process.env.AIM4_BILLING_PROVIDER || null,

  async createCheckoutSession({ userId, planId, term }) {
    throw new BillingNotConfiguredError();
  },

  async createPortalSession({ userId }) {
    throw new BillingNotConfiguredError();
  },

  /**
   * Cancellation is the one operation that works today: the local path sets
   * cancel_at_period_end and the sweep does the rest. When a provider exists
   * this also has to tell it, or the customer keeps being charged.
   */
  async cancelSubscription({ subscriptionId, atPeriodEnd = true }) {
    return { local: true, subscriptionId, atPeriodEnd, provider: provider.name };
  },

  /**
   * Verify a webhook signature over the exact bytes received.
   * Returns the parsed event, or null when it cannot be trusted.
   */
  verifyWebhook(rawBody, signature) {
    return null;
  }
};

export function billingConfigured() {
  return Boolean(provider.name);
}

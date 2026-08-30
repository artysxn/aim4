// ---------------------------------------------------------------------------
// server/billing/promoCodes.js
// Promo codes, which are Paddle discounts.
//
// Deliberately no local table. A promo code changes what someone pays, so it
// only has any effect at checkout, and checkout is Paddle's. Paddle applies the
// discount, counts redemptions, enforces the usage limit and the expiry, and
// restricts it to chosen products. A mirror of that here would be a second
// source of truth about money, and the copy that drifted would be the one
// deciding what a customer is charged.
//
// So this file is a thin translation: our plan ids in, Paddle discounts out.
// Admins pick plans; the mapping to Paddle product ids happens here.
// ---------------------------------------------------------------------------

import { PLAN_IDS, PLAN_NAMES } from '../../shared/entitlements/catalogue.js';
import { paddleRequest, priceIdsForPlans } from './paddle.js';

export class PromoError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PromoError';
    this.status = status;
  }
}

/** What a promo code can do, in the shapes Paddle supports. */
export const PROMO_TYPES = Object.freeze({
  // "20% off" -- the usual launch or influencer code.
  percentage: { label: 'Percentage off', unit: '%' },
  // "€10 off", in cents. Currency is the account's, EUR here.
  flat: { label: 'Fixed amount off', unit: 'cents' }
});

/**
 * Create a discount in Paddle.
 *
 * `recur` plus `maximumRecurringIntervals` is how "free for the first N
 * periods, then the normal price" is expressed: a 100% discount that recurs
 * for N billing periods. Paddle then bills normally from period N+1, which is
 * the "some free time then a subscription" case without any local scheduling.
 *
 * @param {object} args
 * @param {'percentage'|'flat'} args.type
 * @param {string} args.amount        '20' for 20%, or '1000' for EUR 10.00
 * @param {string[]} [args.planIds]   restrict to these plans; empty = all
 * @param {number} [args.usageLimit]  total redemptions across everyone
 * @param {boolean} [args.recur]      applies to renewals too
 * @param {number} [args.maximumRecurringIntervals]  how many periods it recurs
 */
export async function createPromoCode({
  code,
  description,
  type = 'percentage',
  amount,
  planIds = [],
  usageLimit = null,
  expiresAt = null,
  recur = false,
  maximumRecurringIntervals = null
}) {
  if (!PROMO_TYPES[type]) throw new PromoError(`Unknown discount type: ${type}`);
  if (!amount) throw new PromoError('An amount is required.');
  if (type === 'percentage') {
    const pct = Number(amount);
    if (!(pct > 0 && pct <= 100)) throw new PromoError('A percentage must be above 0 and at most 100.');
  } else if (!(Number(amount) > 0)) {
    throw new PromoError('A fixed amount must be above zero.');
  }
  for (const id of planIds) {
    if (!PLAN_IDS.includes(id) || id === 'free') throw new PromoError(`Unknown plan: ${id}`);
  }
  if (maximumRecurringIntervals !== null && !recur) {
    throw new PromoError('A recurring interval count only means something on a recurring discount.');
  }

  const body = {
    description:
      String(description || '').slice(0, 500) ||
      `${amount}${type === 'percentage' ? '%' : ' cents'} off ${
        planIds.length ? planIds.map((p) => PLAN_NAMES[p] || p).join(', ') : 'any plan'
      }`,
    type,
    amount: String(amount),
    enabled_for_checkout: true,
    recur: Boolean(recur)
  };
  if (code) body.code = code;
  if (usageLimit) body.usage_limit = Number(usageLimit);
  if (expiresAt) body.expires_at = expiresAt;
  if (recur && maximumRecurringIntervals) {
    body.maximum_recurring_intervals = Number(maximumRecurringIntervals);
  }
  // Restricting by price is what makes a code tier-specific. Paddle accepts
  // product or price ids; prices are the finer grain and let a code apply to,
  // say, only the yearly term of one plan.
  if (planIds.length) {
    const priceIds = await priceIdsForPlans(planIds);
    if (!priceIds.length) {
      throw new PromoError('No Paddle prices found for those plans. Run the price sync first.');
    }
    body.restrict_to = priceIds;
  }

  return paddleRequest('/discounts', { method: 'POST', body });
}

/** Active discounts, newest first. Paddle is the list. */
export async function listPromoCodes({ status = 'active', limit = 100 } = {}) {
  const query = new URLSearchParams({ per_page: String(limit), order_by: 'created_at[DESC]' });
  if (status) query.set('status', status);
  const rows = await paddleRequest(`/discounts?${query}`);
  return (rows || []).map((d) => ({
    id: d.id,
    code: d.code,
    description: d.description,
    type: d.type,
    amount: d.amount,
    status: d.status,
    recur: d.recur,
    maximumRecurringIntervals: d.maximum_recurring_intervals,
    usageLimit: d.usage_limit,
    timesUsed: d.times_used,
    expiresAt: d.expires_at,
    restrictTo: d.restrict_to || []
  }));
}

/** Archive a discount so it stops working. Paddle keeps it for history. */
export async function archivePromoCode(discountId) {
  if (!discountId) throw new PromoError('A discount id is required.');
  return paddleRequest(`/discounts/${discountId}`, {
    method: 'PATCH',
    body: { status: 'archived' }
  });
}

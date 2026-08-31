// ---------------------------------------------------------------------------
// server/affiliates/commissions.js
// What a referral is worth, and the ledger that records it.
//
// The one number that matters here is which figure a percentage is taken of.
// Paddle sends three on every completed transaction and they are far apart:
//
//   total     what the customer's card was charged, tax included
//   subtotal  the same, before tax
//   earnings  subtotal minus Paddle's fee, which is what reaches the balance
//
// Commission comes off `earnings`. Tax was never ours (Paddle is merchant of
// record and remits it), and the fee was never ours either. Twenty percent of
// `total` on a Norwegian sale at 25% VAT with a ~5% fee is about twenty-seven
// percent of what the business actually received, and it gets worse in higher
// tax jurisdictions. A percentage of gross is a promise to pay out of money
// that does not exist.
//
// Nothing in this file moves money. It writes rows an admin reads and settles
// by hand; see the payouts section at the bottom for why that is not a gap.
// ---------------------------------------------------------------------------

import { db } from '../entitlements/service.js';
import { writeAudit } from '../entitlements/audit.js';
import { AffiliateError, affiliateForCode, affiliateForUser, normaliseCode } from './codes.js';
import { BASE_LEVEL, levelFor, nextLevel } from './levels.js';

/**
 * How long a commission sits at `pending` before it may be paid.
 *
 * This is the refund and chargeback window. Paying the day a payment lands
 * means paying out on charges that are later reversed, and clawing money back
 * from a person is a support problem the hold avoids having.
 */
export const HOLD_DAYS = Number(process.env.AIM4_AFFILIATE_HOLD_DAYS || 30);

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- the math ---------------------------------------------------------------

/**
 * A percentage of an integer amount, in the same minor units.
 *
 * Rounded to the nearest unit rather than floored: over thousands of small
 * commissions a floor is a systematic shave in the house's favour, which is
 * both unfair and the kind of thing an affiliate eventually notices and
 * publishes. A negative base cannot produce a commission.
 */
export function commissionAmount(baseAmount, pct) {
  const base = Number(baseAmount);
  const rate = Number(pct);
  if (!Number.isFinite(base) || !Number.isFinite(rate)) return 0;
  if (base <= 0 || rate <= 0) return 0;
  return Math.round((base * rate) / 100);
}

/**
 * The money out of a transaction.completed payload.
 *
 * `payout_totals` is preferred because it is already converted into the
 * currency the balance is actually held in, so a ledger built from it can be
 * summed without an exchange rate. It is null until Paddle has processed the
 * payout, hence the fallback to `totals`, whose currency is whatever the
 * customer paid in.
 *
 * @returns {{amount: number, currency: string, source: string}|null}
 */
export function earningsFrom(details) {
  const read = (totals, source) => {
    if (!totals) return null;
    const raw = totals.earnings;
    // `null` earnings means Paddle has not worked the fee out yet. That is not
    // zero, and treating it as zero would write a 0.00 commission that no
    // later event corrects.
    if (raw === null || raw === undefined || raw === '') return null;
    const amount = Number(raw);
    if (!Number.isFinite(amount)) return null;
    const currency = String(totals.currency_code || '').toUpperCase();
    if (!currency) return null;
    return { amount, currency, source };
  };
  return read(details?.payout_totals, 'payout_totals') || read(details?.totals, 'totals');
}

/**
 * Is this transaction a renewal rather than the first payment?
 *
 * Paddle's `origin` says so directly for the recurring case. The fallback is
 * "we have already paid this referral once", which is what matters for a
 * non-recurring affiliate even when the origin is something unexpected.
 */
export function isRenewalTransaction(origin, priorCommissions = 0) {
  const o = String(origin || '');
  if (o === 'subscription_recurring') return true;
  if (o === 'web' || o === 'subscription_charge') return priorCommissions > 0;
  return priorCommissions > 0;
}

/**
 * Whether this payment earns anything, and why not when it does not.
 *
 * Pure, and exported, because every one of these branches is a way to pay the
 * wrong person or pay twice, and none of them should need a database and a
 * live webhook to test.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function commissionEligibility({
  affiliate,
  referral,
  payerUserId,
  isRenewal,
  occurredAt,
  nowMs = Date.now()
}) {
  if (!affiliate) return { ok: false, reason: 'no_affiliate' };
  if (!referral) return { ok: false, reason: 'no_referral' };
  if (affiliate.status !== 'active') return { ok: false, reason: 'affiliate_suspended' };

  // The guard that matters most. Someone buying through their own code is not
  // a referral, it is a discount they wrote themselves, and paying commission
  // on it turns the rate into a permanent self-serve rebate.
  if (payerUserId && affiliate.user_id === payerUserId) {
    return { ok: false, reason: 'self_referral' };
  }

  if (isRenewal && !affiliate.recurring) return { ok: false, reason: 'not_recurring' };

  if (isRenewal && affiliate.max_months) {
    const since = Date.parse(referral.attributed_at || '');
    const at = Date.parse(occurredAt || '') || nowMs;
    if (Number.isFinite(since)) {
      // Calendar months from attribution, so "12 months of commission" means a
      // year of the customer's life rather than twelve payments that a plan
      // change could turn into fourteen.
      const end = new Date(since);
      end.setUTCMonth(end.getUTCMonth() + affiliate.max_months);
      if (at >= end.getTime()) return { ok: false, reason: 'past_max_months' };
    }
  }
  return { ok: true };
}

// ---- attribution ------------------------------------------------------------

/**
 * Record who referred a user. First touch wins, and it is never overwritten.
 *
 * Called at checkout rather than at payment: the code is known then, and
 * writing it early means a later payment is attributable even if Paddle's
 * custom_data goes missing on a renewal.
 *
 * Returns null rather than throwing when the code is unusable. A bad or
 * self-referring code must never stop someone buying: the sale is worth more
 * than the attribution, and an exception here would surface as a failed
 * checkout.
 */
export async function attributeReferral({ userId, code, transactionId = null, req = null }) {
  const wanted = normaliseCode(code);
  if (!userId || !wanted) return null;

  const affiliate = await affiliateForCode(wanted).catch(() => null);
  if (!affiliate || affiliate.status !== 'active') return null;
  if (affiliate.user_id === userId) return null; // buying through your own code

  const existing = await db
    .selectOne('affiliate_referrals', { select: '*', user_id: `eq.${userId}` })
    .catch(() => null);
  if (existing) return existing;

  try {
    const row = await db.insert('affiliate_referrals', [
      {
        affiliate_id: affiliate.id,
        user_id: userId,
        code: affiliate.code,
        first_transaction_id: transactionId
      }
    ]);
    await writeAudit({
      actorId: userId,
      action: 'affiliate.attribute',
      targetUser: userId,
      payload: { code: affiliate.code, affiliateId: affiliate.id, transactionId },
      req
    });
    return row;
  } catch (err) {
    // Unique violation on user_id: two checkouts raced and the other won.
    // Whichever landed first is the first touch, which is the rule anyway.
    if (err?.status === 409 || err?.details?.code === '23505') {
      return db
        .selectOne('affiliate_referrals', { select: '*', user_id: `eq.${userId}` })
        .catch(() => null);
    }
    console.warn(`[affiliate] could not attribute ${wanted} to ${userId}: ${err?.message}`);
    return null;
  }
}

/** The referral row for a customer, or null. */
export async function referralForUser(userId) {
  if (!userId) return null;
  return db.selectOne('affiliate_referrals', { select: '*', user_id: `eq.${userId}` });
}

// ---- the ledger -------------------------------------------------------------

/**
 * Turn one completed transaction into a commission row, or decide it earns
 * nothing and say why.
 *
 * Idempotent through the unique index on (provider, provider_transaction_id):
 * Paddle retries aggressively, and one payment must produce one commission
 * however many times it is announced. The insert is what decides, not a read
 * before it, because two deliveries can be in flight at once.
 *
 * @returns {Promise<{recorded: boolean, reason?: string, commission?: object}>}
 */
export async function recordCommission({
  transactionId,
  subscriptionId = null,
  payerUserId,
  affiliateCode = null,
  details,
  origin = null,
  occurredAt = null,
  req = null
}) {
  if (!transactionId) return { recorded: false, reason: 'no_transaction_id' };

  const money = earningsFrom(details);
  if (!money) return { recorded: false, reason: 'no_earnings_yet' };
  // Credits and fully discounted transactions reach here legitimately: a 100%
  // discount code, or a prorated downgrade. Nothing was earned, so nothing is
  // owed, and a zero row would only be noise in the ledger.
  if (money.amount <= 0) return { recorded: false, reason: 'no_earnings' };

  // The referral is the record of who gets paid. custom_data is only a
  // fallback for a checkout whose attribution write did not land.
  let referral = await referralForUser(payerUserId);
  if (!referral && affiliateCode) {
    referral = await attributeReferral({
      userId: payerUserId,
      code: affiliateCode,
      transactionId,
      req
    });
  }
  if (!referral) return { recorded: false, reason: 'no_referral' };

  const affiliate = await db.selectOne('affiliates', {
    select: '*',
    id: `eq.${referral.affiliate_id}`
  });

  const prior = await db
    .select('affiliate_commissions', {
      select: 'id',
      referral_id: `eq.${referral.id}`,
      limit: 1
    })
    .catch(() => []);
  const isRenewal = isRenewalTransaction(origin, prior?.length || 0);

  const verdict = commissionEligibility({
    affiliate,
    referral,
    payerUserId,
    isRenewal,
    occurredAt
  });
  if (!verdict.ok) return { recorded: false, reason: verdict.reason };

  // The rate they have EARNED, not a number sitting on the row from signup.
  const standing = await standingFor(affiliate).catch(() => ({
    level: BASE_LEVEL,
    rate: BASE_LEVEL.rate
  }));
  const amount = commissionAmount(money.amount, standing.rate);
  if (amount <= 0) return { recorded: false, reason: 'rounds_to_zero' };

  const at = occurredAt || new Date().toISOString();
  const payableAt = new Date((Date.parse(at) || Date.now()) + HOLD_DAYS * DAY_MS).toISOString();

  try {
    const row = await db.insert('affiliate_commissions', [
      {
        affiliate_id: affiliate.id,
        referral_id: referral.id,
        user_id: payerUserId || null,
        provider: 'paddle',
        provider_transaction_id: transactionId,
        provider_subscription_id: subscriptionId,
        base_amount: Math.round(money.amount),
        commission_amount: amount,
        currency: money.currency,
        // Frozen at the rate in force now. A later promotion pays more from
        // the next sale and must not restate what was already earned.
        commission_pct: standing.rate,
        status: 'pending',
        is_renewal: isRenewal,
        occurred_at: at,
        payable_at: payableAt
      }
    ]);
    await writeAudit({
      actorId: affiliate.user_id,
      action: 'affiliate.commission',
      targetUser: affiliate.user_id,
      payload: {
        transactionId,
        code: affiliate.code,
        base: money.amount,
        currency: money.currency,
        pct: affiliate.commission_pct,
        amount,
        isRenewal
      },
      req
    });
    return { recorded: true, commission: row };
  } catch (err) {
    if (err?.status === 409 || err?.details?.code === '23505') {
      return { recorded: false, reason: 'duplicate' };
    }
    throw err;
  }
}

// ---- reading ----------------------------------------------------------------

/**
 * What one affiliate has earned, by status, in each currency they earned it.
 *
 * Grouped by currency rather than summed into one figure: adding NOK to EUR
 * with a rate picked at read time produces a number that changes every time
 * the page is opened, and it would be the number someone is owed.
 */
export async function affiliateStats(affiliateId) {
  if (!affiliateId) return null;
  const rows = await db.select('affiliate_commissions', {
    select: 'status,commission_amount,currency,is_renewal',
    affiliate_id: `eq.${affiliateId}`,
    limit: 10000
  });
  const byCurrency = new Map();
  for (const r of rows || []) {
    const cur = r.currency || 'EUR';
    const bucket = byCurrency.get(cur) || {
      currency: cur,
      pending: 0,
      approved: 0,
      paid: 0,
      reversed: 0,
      total: 0
    };
    const amount = Number(r.commission_amount) || 0;
    if (bucket[r.status] !== undefined) bucket[r.status] += amount;
    // Reversed money was never earned, so it is not part of the lifetime
    // figure the affiliate sees.
    if (r.status !== 'reversed') bucket.total += amount;
    byCurrency.set(cur, bucket);
  }

  const referrals = await db
    .select('affiliate_referrals', { select: 'id', affiliate_id: `eq.${affiliateId}`, limit: 10000 })
    .catch(() => []);

  // Distinct customers who have actually paid: first payments, not payments.
  // A referral who never bought is not a customer, and one customer on a
  // monthly plan is twelve payments a year, so neither of the other two counts
  // means what "customers" has to mean for the level ladder to be honest.
  const customers = (rows || []).filter((r) => !r.is_renewal && r.status !== 'reversed').length;

  return {
    currencies: [...byCurrency.values()],
    referrals: referrals?.length || 0,
    customers,
    payments: rows?.length || 0
  };
}

/**
 * The rate this affiliate has earned, and the standing behind it.
 *
 * Read at the moment of a sale rather than stored, so a promotion takes effect
 * on the next payment without anything having to run to grant it. The rate is
 * then FROZEN onto the row that is written, so it is looked up once per sale
 * and never restates one already recorded.
 *
 * `affiliates.commission_pct` overrides the ladder when it has been set to
 * something other than the default. That is the campaign deal escape hatch the
 * column was added for, and an override below the earned rate would be a pay
 * cut nobody agreed to, so it only ever applies upward.
 */
export async function standingFor(affiliate) {
  const stats = await affiliateStats(affiliate?.id);
  // Lifetime earnings across currencies, summed as though one. A mixed
  // currency affiliate is approximated here, and only ever in their favour:
  // the sum can promote slightly early, never hold a level back.
  const earned = (stats?.currencies || []).reduce((a, c) => a + (c.total || 0), 0);
  const customers = stats?.customers ?? stats?.referrals ?? 0;
  const level = levelFor({ earned, customers });
  const override = Number(affiliate?.commission_pct);
  const rate = Number.isFinite(override) && override > level.rate ? override : level.rate;
  return { level, rate, earned, customers, next: nextLevel({ earned, customers }) };
}

/** Commission rows for one affiliate, newest first. */
export async function listCommissions({ affiliateId, status = null, limit = 200 } = {}) {
  const params = { select: '*', order: 'occurred_at.desc', limit };
  if (affiliateId) params.affiliate_id = `eq.${affiliateId}`;
  if (status) params.status = `eq.${status}`;
  return db.select('affiliate_commissions', params);
}

// ---- settling ---------------------------------------------------------------
// Deliberately manual, and not a gap waiting to be filled by an API call.
// Paddle pays the seller; it has no way to pay the seller's affiliates. So a
// payout is a bank transfer a person makes, and the most this system can
// honestly do is say who is owed what and record that it was sent.

/**
 * Move commissions past their hold from `pending` to `approved`.
 *
 * Run on a schedule or from the admin page. Separate from paying so that the
 * "what is owed" number is settled before anyone acts on it.
 */
export async function approveDueCommissions({ actorId = null, req = null } = {}) {
  const now = new Date().toISOString();
  const rows = await db.update(
    'affiliate_commissions',
    { status: 'eq.pending', payable_at: `lte.${now}` },
    { status: 'approved' }
  );
  if (rows?.length && actorId) {
    await writeAudit({
      actorId,
      action: 'affiliate.approve',
      payload: { count: rows.length },
      req
    });
  }
  return rows || [];
}

/**
 * Record a payout that has already been made, and close the rows it covers.
 *
 * The commissions are named explicitly rather than "everything approved for
 * this affiliate": the money was sent for a specific set of rows, and letting
 * this function decide the set would mean anything approved in the seconds
 * between the transfer and the click gets marked paid without being paid.
 */
export async function recordPayout({
  affiliateId,
  commissionIds = [],
  method = null,
  reference = null,
  note = null,
  actorId,
  req = null
}) {
  if (!actorId) throw new AffiliateError('actorId is required.', 500);
  if (!affiliateId) throw new AffiliateError('An affiliate id is required.');
  if (!commissionIds.length) throw new AffiliateError('Pick the commissions this payout covers.');

  const rows = await db.select('affiliate_commissions', {
    select: '*',
    id: `in.(${commissionIds.join(',')})`,
    affiliate_id: `eq.${affiliateId}`,
    limit: 10000
  });
  if (!rows?.length) throw new AffiliateError('None of those commissions belong to that affiliate.');

  const unpayable = rows.filter((r) => r.status !== 'approved');
  if (unpayable.length) {
    throw new AffiliateError(
      `${unpayable.length} of those are not approved yet. Approve them first.`
    );
  }
  const currencies = [...new Set(rows.map((r) => r.currency))];
  if (currencies.length > 1) {
    // One payout, one currency. A mixed total is a number nobody can transfer.
    throw new AffiliateError(`Those commissions are in ${currencies.join(' and ')}. Pay one currency at a time.`);
  }

  const amount = rows.reduce((sum, r) => sum + (Number(r.commission_amount) || 0), 0);
  const payout = await db.insert('affiliate_payouts', [
    {
      affiliate_id: affiliateId,
      amount,
      currency: currencies[0],
      method: method || null,
      reference: reference || null,
      note: note || null,
      created_by: actorId
    }
  ]);

  await db.update(
    'affiliate_commissions',
    { id: `in.(${rows.map((r) => r.id).join(',')})` },
    { status: 'paid', paid_at: new Date().toISOString(), payout_id: payout.id },
    { returning: false }
  );

  await writeAudit({
    actorId,
    action: 'affiliate.payout',
    payload: { affiliateId, amount, currency: currencies[0], count: rows.length, reference },
    req
  });
  return { payout, count: rows.length, amount, currency: currencies[0] };
}

/**
 * Take a commission back: refunded, charged back, or fraudulent.
 *
 * Never deleted. What was owed and then was not is exactly the history that
 * gets argued about later.
 */
export async function reverseCommission({ commissionId, reason = null, actorId, req = null }) {
  if (!actorId) throw new AffiliateError('actorId is required.', 500);
  const [row] = await db.update(
    'affiliate_commissions',
    { id: `eq.${commissionId}` },
    {
      status: 'reversed',
      reversed_at: new Date().toISOString(),
      reversed_reason: String(reason || '').slice(0, 500) || null
    }
  );
  if (!row) throw new AffiliateError('No such commission.', 404);
  await writeAudit({
    actorId,
    action: 'affiliate.reverse',
    payload: { commissionId, reason: reason || null, amount: row.commission_amount },
    req
  });
  return row;
}

// ---------------------------------------------------------------------------
// server/affiliates/commissions.test.js
//   node --test server/affiliates/commissions.test.js
//
// The commission math, the eligibility rules, and the code rules. All of it is
// pure on purpose: every branch below is a way to pay the wrong person, pay
// twice, or pay out of money the business never received, and none of them
// should need a live webhook and a real card to prove.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commissionAmount,
  commissionEligibility,
  earningsFrom,
  isRenewalTransaction
} from './commissions.js';
import { codeProblem, normaliseCode, suggestCode } from './codes.js';

// ---- what a percentage is taken of ------------------------------------------

test('commission comes off earnings, not off what the customer paid', () => {
  // Paddle's own worked example: a 65215 charge is 59900 subtotal plus 5315
  // tax, and after a 3311 fee the earnings are 56589.
  const details = {
    totals: {
      subtotal: '59900',
      tax: '5315',
      total: '65215',
      fee: '3311',
      earnings: '56589',
      currency_code: 'USD'
    }
  };
  const money = earningsFrom(details);
  assert.equal(money.amount, 56589, 'the base is earnings');

  const paid = commissionAmount(money.amount, 20);
  assert.equal(paid, 11318, '20% of 56589, rounded');

  // The whole point, stated as the comparison it protects against: a naive
  // percentage of the gross would hand over 13043, which is 1725 more than
  // 20% of what actually arrived. The tax was never ours and neither was the
  // fee.
  const naive = commissionAmount(Number(details.totals.total), 20);
  assert.equal(naive, 13043);
  assert.ok(naive > paid, 'gross always overpays, and by more as tax rises');
});

test('rounding is to the nearest unit, in both directions', () => {
  assert.equal(commissionAmount(1000, 20), 200);
  assert.equal(commissionAmount(999, 20), 200, '199.8 rounds up');
  assert.equal(commissionAmount(1002, 20), 200, '200.4 rounds down');
  // A floor would shave a cent off most commissions, which over thousands of
  // payments is a systematic underpayment in the house's favour.
  assert.equal(commissionAmount(1234, 12.5), 154, 'fractional rates work');
});

test('nothing is owed on nothing', () => {
  assert.equal(commissionAmount(0, 20), 0);
  assert.equal(commissionAmount(-5000, 20), 0, 'a credit is not a negative commission');
  assert.equal(commissionAmount(5000, 0), 0);
  assert.equal(commissionAmount('nonsense', 20), 0);
  assert.equal(commissionAmount(5000, null), 0);
});

// ---- reading the money off the event ----------------------------------------

test('payout totals win, because they are already in the payout currency', () => {
  const money = earningsFrom({
    totals: { earnings: '10000', currency_code: 'USD' },
    payout_totals: { earnings: '9200', currency_code: 'EUR' }
  });
  assert.deepEqual(money, { amount: 9200, currency: 'EUR', source: 'payout_totals' });
});

test('transaction totals are the fallback before the payout is processed', () => {
  const money = earningsFrom({
    totals: { earnings: '10000', currency_code: 'usd' },
    payout_totals: null
  });
  assert.equal(money.amount, 10000);
  assert.equal(money.currency, 'USD', 'currency is normalised');
  assert.equal(money.source, 'totals');
});

test('earnings Paddle has not worked out yet is not zero', () => {
  // null earnings means the fee is still being processed. Treating it as zero
  // would write a 0.00 commission that nothing later corrects.
  assert.equal(earningsFrom({ totals: { earnings: null, currency_code: 'EUR' } }), null);
  assert.equal(earningsFrom({ totals: { earnings: '100' } }), null, 'no currency, no money');
  assert.equal(earningsFrom({}), null);
  assert.equal(earningsFrom(null), null);
});

// ---- first payment or renewal -----------------------------------------------

test('a recurring origin is a renewal, and so is a second payment', () => {
  assert.equal(isRenewalTransaction('subscription_recurring', 0), true);
  assert.equal(isRenewalTransaction('web', 0), false, 'the first checkout is not a renewal');
  assert.equal(isRenewalTransaction('web', 1), true, 'we already paid this referral once');
  assert.equal(isRenewalTransaction(null, 0), false);
  assert.equal(isRenewalTransaction(null, 3), true);
});

// ---- who earns, and who does not --------------------------------------------

const affiliate = (over = {}) => ({
  id: 'aff-1',
  user_id: 'alice',
  code: 'ALICE',
  commission_pct: 20,
  recurring: true,
  max_months: null,
  status: 'active',
  ...over
});
const referral = (over = {}) => ({
  id: 'ref-1',
  affiliate_id: 'aff-1',
  user_id: 'bob',
  attributed_at: '2026-01-01T00:00:00Z',
  ...over
});

test('a straightforward referral earns', () => {
  const v = commissionEligibility({
    affiliate: affiliate(),
    referral: referral(),
    payerUserId: 'bob',
    isRenewal: false,
    occurredAt: '2026-01-01T00:00:00Z'
  });
  assert.deepEqual(v, { ok: true });
});

test('nobody earns commission on their own purchase', () => {
  // The rule that stops the rate becoming a permanent self-serve rebate.
  const v = commissionEligibility({
    affiliate: affiliate({ user_id: 'bob' }),
    referral: referral(),
    payerUserId: 'bob',
    isRenewal: false
  });
  assert.deepEqual(v, { ok: false, reason: 'self_referral' });
});

test('a suspended affiliate earns nothing further', () => {
  const v = commissionEligibility({
    affiliate: affiliate({ status: 'suspended' }),
    referral: referral(),
    payerUserId: 'bob',
    isRenewal: false
  });
  assert.deepEqual(v, { ok: false, reason: 'affiliate_suspended' });
});

test('a non-recurring affiliate is paid once and not on renewals', () => {
  const one = affiliate({ recurring: false });
  assert.equal(
    commissionEligibility({ affiliate: one, referral: referral(), payerUserId: 'bob', isRenewal: false }).ok,
    true,
    'the first payment still earns'
  );
  assert.deepEqual(
    commissionEligibility({ affiliate: one, referral: referral(), payerUserId: 'bob', isRenewal: true }),
    { ok: false, reason: 'not_recurring' }
  );
});

test('a month limit is counted from attribution, in calendar months', () => {
  const capped = affiliate({ max_months: 12 });
  const at = (iso) =>
    commissionEligibility({
      affiliate: capped,
      referral: referral(),
      payerUserId: 'bob',
      isRenewal: true,
      occurredAt: iso
    });
  assert.equal(at('2026-06-01T00:00:00Z').ok, true, 'inside the window');
  assert.equal(at('2026-12-31T00:00:00Z').ok, true, 'the last day still earns');
  assert.deepEqual(at('2027-01-01T00:00:00Z'), { ok: false, reason: 'past_max_months' });
  // The limit is about renewals; a first payment is never past it.
  assert.equal(
    commissionEligibility({
      affiliate: capped,
      referral: referral(),
      payerUserId: 'bob',
      isRenewal: false,
      occurredAt: '2030-01-01T00:00:00Z'
    }).ok,
    true
  );
});

test('no affiliate and no referral both earn nothing', () => {
  assert.deepEqual(
    commissionEligibility({ affiliate: null, referral: referral(), payerUserId: 'bob' }),
    { ok: false, reason: 'no_affiliate' }
  );
  assert.deepEqual(
    commissionEligibility({ affiliate: affiliate(), referral: null, payerUserId: 'bob' }),
    { ok: false, reason: 'no_referral' }
  );
});

// ---- the codes themselves ---------------------------------------------------

test('codes are normalised the way people type them', () => {
  assert.equal(normaliseCode('  danny  '), 'DANNY');
  assert.equal(normaliseCode('my code!'), 'MYCODE');
  assert.equal(normaliseCode('a-b_c'), 'A-B_C', 'dashes and underscores survive');
  assert.equal(normaliseCode(null), '');
});

test('a code cannot impersonate the site', () => {
  // The reason this list exists: DANNY-from-Discord and ADMIN read very
  // differently to someone being asked to type one into a checkout.
  for (const reserved of ['admin', 'AIM4', 'support', 'Official', 'billing']) {
    assert.match(codeProblem(reserved), /reserved/, `${reserved} should be refused`);
  }
});

test('a code has to be a usable shape', () => {
  assert.equal(codeProblem('DANNY'), null);
  assert.equal(codeProblem('s1mple'), null);
  assert.match(codeProblem('ab'), /at least 3/);
  assert.match(codeProblem(''), /Pick a code/);
  assert.match(codeProblem('-lead'), /start with/);
  assert.equal(codeProblem('A'.repeat(24)), null, '24 is the ceiling');
  // Longer input is trimmed to the ceiling rather than refused, so a paste
  // does not become an error message.
  assert.equal(codeProblem('A'.repeat(40)), null);
});

test('a suggestion is always usable as a code', () => {
  assert.equal(suggestCode('danny'), 'DANNY');
  assert.match(suggestCode('ed'), /^ED\d{4}$/, 'too short gets padded, not rejected');
  assert.notEqual(suggestCode('admin'), 'ADMIN', 'a reserved word is never suggested');
  assert.equal(codeProblem(suggestCode('admin')), null);
  assert.equal(codeProblem(suggestCode('x')), null);
});

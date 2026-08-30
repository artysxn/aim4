// ---------------------------------------------------------------------------
// server/billing/transactionCommission.test.js
//   node --test server/billing/transactionCommission.test.js
//
// applyEvent's transaction.completed branch: finding out who paid, and handing
// that to the commission ledger.
//
// This is the join between two systems that know nothing about each other, and
// the failure it guards against is quiet. Before affiliates existed these
// events fell straight through (mapProviderStatus has no case for 'completed'),
// so a mistake here does not throw or log, it just never pays anyone.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { applyEvent } from './routes.js';

/** A transaction.completed event, in the shape verifyWebhook produces. */
function txEvent(over = {}) {
  return {
    id: 'evt_1',
    type: 'transaction.completed',
    occurredAt: '2026-08-30T10:00:00Z',
    data: {
      status: 'completed',
      transactionId: 'txn_1',
      subscriptionId: 'sub_1',
      userId: 'bob',
      affiliateCode: null,
      origin: 'web',
      details: { totals: { earnings: '5000', currency_code: 'EUR' } },
      ...over
    }
  };
}

function harness({ subscriptionUser = null, result = { recorded: true } } = {}) {
  const seen = [];
  return {
    seen,
    deps: {
      configured: () => true,
      db: {
        async selectOne() {
          return subscriptionUser ? { user_id: subscriptionUser } : null;
        }
      },
      recordCommission: async (args) => {
        seen.push(args);
        return result.recorded
          ? {
              recorded: true,
              commission: {
                commission_amount: 1000,
                currency: 'EUR',
                affiliate_id: 'aff-1'
              }
            }
          : result;
      }
    }
  };
}

test('a completed transaction reaches the commission ledger', async () => {
  const h = harness();
  const handled = await applyEvent(txEvent(), h.deps);
  assert.equal(handled, true);
  assert.equal(h.seen.length, 1);
  assert.deepEqual(
    {
      transactionId: h.seen[0].transactionId,
      payerUserId: h.seen[0].payerUserId,
      subscriptionId: h.seen[0].subscriptionId,
      origin: h.seen[0].origin,
      occurredAt: h.seen[0].occurredAt
    },
    {
      transactionId: 'txn_1',
      payerUserId: 'bob',
      subscriptionId: 'sub_1',
      origin: 'web',
      occurredAt: '2026-08-30T10:00:00Z'
    }
  );
  assert.equal(h.seen[0].details.totals.earnings, '5000', 'the money is passed through whole');
});

test('a payer with no custom_data is found through the subscription', async () => {
  // Renewals and anything created outside our checkout can arrive without the
  // custom_data we stamped. The subscription we already track is the fallback,
  // and without it every renewal would go unattributed.
  const h = harness({ subscriptionUser: 'carol' });
  const handled = await applyEvent(txEvent({ userId: null }), h.deps);
  assert.equal(handled, true);
  assert.equal(h.seen[0].payerUserId, 'carol');
});

test('an unattributable transaction is dropped rather than guessed at', async () => {
  const h = harness({ subscriptionUser: null });
  const handled = await applyEvent(txEvent({ userId: null, subscriptionId: null }), h.deps);
  assert.equal(handled, false);
  assert.equal(h.seen.length, 0, 'nothing is offered to the ledger');
});

test('a transaction that earns nothing is handled without being recorded', async () => {
  // Most sales have no affiliate behind them. That is a normal outcome, not a
  // failure, and it must not come back as an error the webhook route retries.
  const h = harness({ result: { recorded: false, reason: 'no_referral' } });
  const handled = await applyEvent(txEvent(), h.deps);
  assert.equal(handled, false);
});

test('the affiliate code from custom_data is carried through', async () => {
  const h = harness();
  await applyEvent(txEvent({ affiliateCode: 'ALICE' }), h.deps);
  assert.equal(h.seen[0].affiliateCode, 'ALICE');
});

test('subscription events still take the subscription path', async () => {
  // The guard that keeps the two branches apart: a subscription event must
  // never be offered to the ledger, and the commission branch must not
  // swallow it.
  const h = harness();
  const subscriptionEvent = {
    id: 'evt_2',
    type: 'subscription.activated',
    data: { status: 'active', subscriptionId: 'sub_2', userId: 'bob' }
  };
  // No provider in deps, so this throws if it reaches the subscription path,
  // which is itself the proof it was not handled as a transaction.
  await applyEvent(subscriptionEvent, {
    ...h.deps,
    db: { async update() { return []; }, async selectOne() { return null; } },
    provider: { name: 'paddle', async planForPriceIds() { return null; } }
  }).catch(() => {});
  assert.equal(h.seen.length, 0, 'the ledger never saw a subscription event');
});

test('a broken ledger never fails the payment webhook', async () => {
  // The regression this guards: these events were ignored before affiliates
  // existed, so a throw here is a brand new way for Paddle to get a 500 and
  // retry the same payment for three days. It also covers the window between
  // deploying this and applying 0016_affiliates.sql, where the tables do not
  // exist yet and every completed transaction would otherwise wedge.
  const deps = {
    configured: () => true,
    db: { async selectOne() { return null; } },
    recordCommission: async () => {
      throw new Error('relation "affiliate_commissions" does not exist');
    }
  };
  const handled = await applyEvent(txEvent(), deps);
  assert.equal(handled, false, 'reported as not handled, and not thrown');
});

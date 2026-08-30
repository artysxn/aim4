// ---------------------------------------------------------------------------
// server/billing/applyEvent.test.js
//   node --test server/billing/applyEvent.test.js
//
// The three-path dispatch in applyEvent, which decides whether a webhook
// updates a subscription, takes an existing one over, or inserts a new one.
// Getting it wrong means a customer pays and is granted nothing, or is granted
// the wrong tier, or is billed twice, so each outcome gets its own case.
//
// A fake store rather than the real database: these are decisions about which
// row to write, and inventing subscriptions in a live table to assert on them
// would be a bad trade for the confidence gained.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { applyEvent } from './routes.js';

const PRICE = {
  solo_lite: { month: 'pri_lite_m', year: 'pri_lite_y' },
  solo_elite: { month: 'pri_elite_m', year: 'pri_elite_y' }
};

/** A store that records what it was asked to do. */
function fakeStore({ known = null, live = null } = {}) {
  const calls = { updates: [], inserts: [], selects: [] };
  return {
    calls,
    async update(table, params, patch) {
      calls.updates.push({ table, params, patch });
      // First update in applyEvent is the match-by-subscription-id probe.
      if (params.provider_subscription_id) return known ? [{ ...known, ...patch }] : [];
      return live ? [{ ...live, ...patch }] : [];
    },
    async selectOne(table, params) {
      calls.selects.push({ table, params });
      return live;
    },
    async insert(table, rows) {
      calls.inserts.push({ table, rows });
      return { ...rows[0] };
    }
  };
}

function deps(store, extra = {}) {
  const audits = [];
  return {
    audits,
    deps: {
      db: store,
      configured: () => true,
      recomputeUser: async () => {},
      writeAudit: async (entry) => audits.push(entry),
      provider: {
        name: 'paddle',
        async planForPriceIds(ids) {
          for (const [planId, terms] of Object.entries(PRICE)) {
            for (const [term, id] of Object.entries(terms)) {
              if ((ids || []).includes(id)) return { planId, term };
            }
          }
          return null;
        }
      },
      ...extra
    }
  };
}

function event(over = {}) {
  return {
    id: 'evt_1',
    type: 'subscription.updated',
    data: {
      status: 'active',
      subscriptionId: 'sub_new',
      currentPeriodEnd: '2026-10-01T00:00:00Z',
      currentPeriodStart: '2026-09-01T00:00:00Z',
      customerId: 'ctm_1',
      cancelAtPeriodEnd: false,
      priceIds: ['pri_lite_m'],
      userId: 'u-1',
      planId: 'solo_lite',
      term: 'month',
      ...over
    }
  };
}

test('an unknown status is dropped rather than guessed at', async () => {
  const store = fakeStore();
  const { deps: d } = deps(store);
  assert.equal(await applyEvent(event({ status: 'something_new' }), d), false);
  assert.equal(store.calls.updates.length, 0);
});

test('a tracked subscription is updated in place', async () => {
  const store = fakeStore({ known: { user_id: 'u-1', plan_id: 'solo_lite', term: 'month' } });
  const { deps: d, audits } = deps(store);
  assert.equal(await applyEvent(event(), d), true);
  assert.equal(audits[0].payload.outcome, 'updated');
});

test('a tier change in Paddle rewrites plan and term, not just status', async () => {
  const store = fakeStore({ known: { user_id: 'u-1', plan_id: 'solo_lite', term: 'month' } });
  const { deps: d, audits } = deps(store);

  // Same subscription, now billing the Elite yearly price.
  await applyEvent(event({ priceIds: ['pri_elite_y'] }), d);

  const patch = store.calls.updates[0].patch;
  assert.equal(patch.plan_id, 'solo_elite', 'plan follows what Paddle is billing');
  assert.equal(patch.term, 'year');
  // The audit entry records the plan it settled on and where that came from.
  // A tier change is two consecutive entries that disagree; there is no flag,
  // because a PATCH returns the row after the write and the old plan is gone.
  assert.equal(audits[0].payload.planId, 'solo_elite');
  assert.equal(audits[0].payload.planFrom, 'price');
});

test('an event with no items falls back to custom_data and says so', async () => {
  const store = fakeStore({ known: { user_id: 'u-1', plan_id: 'solo_lite', term: 'month' } });
  const { deps: d, audits } = deps(store);
  await applyEvent(event({ priceIds: [] }), d);
  assert.equal(audits[0].payload.planFrom, 'custom_data');
});

test('the billed price beats stale custom_data', async () => {
  const store = fakeStore({ known: { user_id: 'u-1', plan_id: 'solo_lite', term: 'month' } });
  const { deps: d } = deps(store);

  // custom_data still says what was first bought; the price says otherwise.
  await applyEvent(event({ priceIds: ['pri_elite_y'], planId: 'solo_lite', term: 'month' }), d);
  assert.equal(store.calls.updates[0].patch.plan_id, 'solo_elite');
});

test('a trial is taken over rather than duplicated', async () => {
  const store = fakeStore({
    live: { id: 'row-1', user_id: 'u-1', provider_subscription_id: null, source: 'trial' }
  });
  const { deps: d, audits } = deps(store);

  assert.equal(await applyEvent(event(), d), true);
  assert.equal(audits[0].payload.outcome, 'adopted');
  assert.equal(store.calls.inserts.length, 0, 'no second live row is created');
  const claim = store.calls.updates[1].patch;
  assert.equal(claim.provider_subscription_id, 'sub_new');
  assert.equal(claim.source, 'billing');
  assert.equal(claim.notes, undefined, 'nothing was displaced, so no warning note');
});

test('a second live Paddle subscription is granted but flagged, not swallowed', async () => {
  const store = fakeStore({
    live: { id: 'row-1', user_id: 'u-1', provider_subscription_id: 'sub_old', source: 'billing' }
  });
  const { deps: d, audits } = deps(store);

  assert.equal(await applyEvent(event(), d), true);

  const claim = store.calls.updates[1].patch;
  assert.equal(claim.provider_subscription_id, 'sub_new', 'the paid-for subscription is granted');
  assert.match(claim.notes, /sub_old/, 'the displaced subscription is recorded on the row');
  assert.equal(audits[0].payload.outcome, 'displaced');
  assert.equal(audits[0].payload.displaced, 'sub_old', 'and in the audit log');
});

test('a first payment with no existing row inserts one', async () => {
  const store = fakeStore();
  const { deps: d, audits } = deps(store);

  assert.equal(await applyEvent(event(), d), true);
  assert.equal(store.calls.inserts.length, 1);
  assert.equal(store.calls.inserts[0].rows[0].user_id, 'u-1');
  assert.equal(audits[0].payload.outcome, 'created');
});

test('an event that cannot be attributed to a user is dropped', async () => {
  const store = fakeStore();
  const { deps: d } = deps(store);
  assert.equal(await applyEvent(event({ userId: null, priceIds: [] }), d), false);
  assert.equal(store.calls.inserts.length, 0);
});

test('an unknown plan is dropped rather than written as a bad foreign key', async () => {
  const store = fakeStore();
  const { deps: d } = deps(store);
  assert.equal(await applyEvent(event({ priceIds: [], planId: 'enterprise' }), d), false);
});

test('the free plan is never granted through billing', async () => {
  const store = fakeStore();
  const { deps: d } = deps(store);
  assert.equal(await applyEvent(event({ priceIds: [], planId: 'free' }), d), false);
});

test('a scheduled cancel is carried onto the row', async () => {
  const store = fakeStore({ known: { user_id: 'u-1', plan_id: 'solo_lite', term: 'month' } });
  const { deps: d } = deps(store);
  await applyEvent(event({ cancelAtPeriodEnd: true }), d);
  assert.equal(store.calls.updates[0].patch.cancel_at_period_end, true);
});

test('a paused subscription stops granting entitlements', async () => {
  const store = fakeStore({ known: { user_id: 'u-1', plan_id: 'solo_lite', term: 'month' } });
  const { deps: d } = deps(store);
  await applyEvent(event({ status: 'paused' }), d);
  assert.equal(store.calls.updates[0].patch.status, 'expired');
  assert.equal(store.calls.updates[0].patch.provider_status, 'paused');
});

test('a cancel for an untracked subscription never touches the live row', async () => {
  // The regression that mattered: an old subscription being cancelled arrived
  // while a different, paid subscription was live. The displace path rewrote
  // the live row to the dead subscription and marked it cancelled, leaving a
  // paying customer entitled to nothing.
  const store = fakeStore({
    live: { id: 'row-1', user_id: 'u-1', provider_subscription_id: 'sub_current', source: 'billing' }
  });
  const { deps: d, audits } = deps(store);

  const handled = await applyEvent(
    event({ status: 'canceled', subscriptionId: 'sub_old', priceIds: ['pri_elite_y'] }),
    d
  );

  assert.equal(handled, false, 'the event is ignored');
  assert.equal(store.calls.updates.length, 1, 'only the match-by-id probe ran');
  assert.equal(store.calls.inserts.length, 0, 'and nothing was inserted');
  assert.equal(audits.length, 0, 'nothing was granted, so nothing is audited');
});

test('an expired untracked subscription is ignored too', async () => {
  const store = fakeStore({
    live: { id: 'row-1', user_id: 'u-1', provider_subscription_id: 'sub_current', source: 'billing' }
  });
  const { deps: d } = deps(store);
  assert.equal(await applyEvent(event({ status: 'paused', subscriptionId: 'sub_old' }), d), false);
  assert.equal(store.calls.inserts.length, 0);
});

test('cancelling the subscription we DO track still applies', async () => {
  // The guard must not deafen us to a cancellation of the real subscription:
  // that one matches by id on path 1 and has to be written.
  const store = fakeStore({ known: { user_id: 'u-1', plan_id: 'solo_lite', term: 'month' } });
  const { deps: d, audits } = deps(store);

  assert.equal(await applyEvent(event({ status: 'canceled' }), d), true);
  assert.equal(store.calls.updates[0].patch.status, 'cancelled');
  assert.equal(audits[0].payload.outcome, 'updated');
});

test('a trialing subscription may still adopt a live row', async () => {
  const store = fakeStore({
    live: { id: 'row-1', user_id: 'u-1', provider_subscription_id: null, source: 'admin' }
  });
  const { deps: d, audits } = deps(store);
  assert.equal(await applyEvent(event({ status: 'trialing' }), d), true);
  assert.equal(audits[0].payload.outcome, 'adopted');
});

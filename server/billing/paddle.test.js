// ---------------------------------------------------------------------------
// server/billing/paddle.test.js
//   node --test server/billing/paddle.test.js
//
// Covers the two things that are dangerous to get wrong and cheap to test: the
// webhook signature, and the flattening of a Paddle event into the shape
// applyEvent consumes. Neither touches the network or the database.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { parseSignatureHeader, signatureIsValid, verifyWebhook } from './paddle.js';

const SECRET = 'pdl_ntfset_test_secret';
const NOW = 1767225600000; // fixed, so freshness assertions do not drift

function sign(body, { ts = Math.floor(NOW / 1000), secret = SECRET } = {}) {
  const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

const EVENT = JSON.stringify({
  event_id: 'evt_01',
  event_type: 'subscription.created',
  occurred_at: '2026-08-30T12:00:00Z',
  data: {
    id: 'sub_01',
    status: 'active',
    customer_id: 'ctm_01',
    current_billing_period: { starts_at: '2026-08-30T12:00:00Z', ends_at: '2026-09-30T12:00:00Z' },
    items: [{ price: { id: 'pri_01' } }],
    custom_data: { user_id: 'u-1', plan_id: 'solo_elite', term: 'year' }
  }
});

test('parseSignatureHeader splits ts and h1 and ignores unknown parts', () => {
  const parsed = parseSignatureHeader('ts=123;h1=abc;h2=future');
  assert.equal(parsed.ts, '123');
  assert.equal(parsed.h1, 'abc');
  assert.equal(parsed.h2, 'future');
});

test('a correct signature over the exact bytes verifies', () => {
  assert.equal(signatureIsValid(EVENT, sign(EVENT), SECRET, NOW), true);
  assert.equal(signatureIsValid(Buffer.from(EVENT), sign(EVENT), SECRET, NOW), true);
});

test('a body altered after signing is rejected', () => {
  const header = sign(EVENT);
  const tampered = EVENT.replace('"solo_elite"', '"team_tier1"');
  assert.equal(signatureIsValid(tampered, header, SECRET, NOW), false);
});

test('re-serialised JSON does not verify, which is why routes.js keeps raw bytes', () => {
  const header = sign(EVENT);
  // Same object, different bytes. This is the failure mode routes.js avoids by
  // reading the body before anything can parse it: it passes in testing with a
  // hand-built payload and fails on the first real one whose spacing, key
  // order, or unicode escaping differs from what JSON.stringify would produce.
  const roundTripped = JSON.stringify(JSON.parse(EVENT), null, 2);
  assert.notEqual(roundTripped, EVENT);
  assert.equal(signatureIsValid(roundTripped, header, SECRET, NOW), false);
});

test('the wrong secret is rejected', () => {
  assert.equal(signatureIsValid(EVENT, sign(EVENT, { secret: 'other' }), SECRET, NOW), false);
});

test('a missing secret is rejected rather than skipping the check', () => {
  assert.equal(signatureIsValid(EVENT, sign(EVENT), '', NOW), false);
  assert.equal(signatureIsValid(EVENT, sign(EVENT), undefined, NOW), false);
});

test('a stale timestamp is rejected even when the digest is right', () => {
  const old = Math.floor(NOW / 1000) - 6 * 60;
  assert.equal(signatureIsValid(EVENT, sign(EVENT, { ts: old }), SECRET, NOW), false);
});

test('a future timestamp is rejected too', () => {
  const ahead = Math.floor(NOW / 1000) + 6 * 60;
  assert.equal(signatureIsValid(EVENT, sign(EVENT, { ts: ahead }), SECRET, NOW), false);
});

test('malformed and empty headers are rejected', () => {
  for (const header of ['', 'garbage', 'ts=;h1=', 'h1=abc', 'ts=abc;h1=def']) {
    assert.equal(signatureIsValid(EVENT, header, SECRET, NOW), false, `header: ${header}`);
  }
});

test('a digest of the wrong length is rejected without throwing', () => {
  assert.equal(signatureIsValid(EVENT, `ts=${Math.floor(NOW / 1000)};h1=ab`, SECRET, NOW), false);
});

test('verifyWebhook returns null for an untrusted body', () => {
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  assert.equal(verifyWebhook(EVENT, 'ts=1;h1=nope'), null);
});

test('verifyWebhook flattens a subscription event into the applyEvent shape', () => {
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  const ts = Math.floor(Date.now() / 1000);
  const event = verifyWebhook(EVENT, sign(EVENT, { ts }));

  assert.equal(event.id, 'evt_01');
  assert.equal(event.type, 'subscription.created');
  assert.equal(event.data.status, 'active');
  assert.equal(event.data.subscriptionId, 'sub_01');
  assert.equal(event.data.currentPeriodEnd, '2026-09-30T12:00:00Z');
  assert.equal(event.data.currentPeriodStart, '2026-08-30T12:00:00Z');
  assert.equal(event.data.customerId, 'ctm_01');
  assert.equal(event.data.userId, 'u-1');
  assert.equal(event.data.planId, 'solo_elite');
  assert.equal(event.data.term, 'year');
  assert.equal(event.data.cancelAtPeriodEnd, false);
  assert.deepEqual(event.data.priceIds, ['pri_01']);
});

test('a scheduled cancel surfaces as cancelAtPeriodEnd', () => {
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  const body = JSON.stringify({
    event_id: 'evt_02',
    event_type: 'subscription.updated',
    data: {
      id: 'sub_01',
      status: 'active',
      scheduled_change: { action: 'cancel', effective_at: '2026-09-30T12:00:00Z' },
      custom_data: { user_id: 'u-1', plan_id: 'solo_lite', term: 'month' }
    }
  });
  const ts = Math.floor(Date.now() / 1000);
  const event = verifyWebhook(body, sign(body, { ts }));
  assert.equal(event.data.cancelAtPeriodEnd, true);
  assert.equal(event.data.currentPeriodEnd, null);
});

test('a transaction event takes its subscription id from subscription_id', () => {
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  const body = JSON.stringify({
    event_id: 'evt_03',
    event_type: 'transaction.completed',
    data: { id: 'txn_01', subscription_id: 'sub_09', status: 'completed', custom_data: {} }
  });
  const ts = Math.floor(Date.now() / 1000);
  const event = verifyWebhook(body, sign(body, { ts }));
  assert.equal(event.data.subscriptionId, 'sub_09');
});

test('a verified but unparseable body returns null', () => {
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  const body = 'not json';
  const ts = Math.floor(Date.now() / 1000);
  assert.equal(verifyWebhook(body, sign(body, { ts })), null);
});

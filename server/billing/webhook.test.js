// Run: node server/billing/webhook.test.js
//
// The webhook exists before any provider does, so that the two things which are
// easy to get wrong are proven while they are still cheap to change:
//
//   the raw bytes survive the request chain, byte for byte
//   a retried event is not applied twice
//
// Signature verification against a real provider cannot be tested without that
// provider. What is tested is that an unverifiable payload is refused once the
// integration is switched on, and dropped politely while it is not.

import http from 'node:http';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const { handleBillingRequest, alreadyHandled, mapProviderStatus, _resetSeenEvents } = await import(
  './routes.js'
);
const { provider } = await import('./provider.js');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await handleBillingRequest(req, res, url)) return;
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

function post(path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body
  });
}

// ---- unconfigured -----------------------------------------------------------

{
  const res = await fetch(`${base}/api/billing/status`);
  const body = await res.json();
  assert(body.configured === false, 'billing starts unconfigured');
  assert(body.provider === null, 'and names no provider');
  console.log('  billing reports itself unconfigured');
}

{
  // A 4xx here would be retried forever and eventually get the endpoint
  // disabled by the provider, so an unconfigured webhook answers 200 and drops.
  const res = await post('/api/billing/webhook', JSON.stringify({ id: 'evt_1' }));
  const body = await res.json();
  assert(res.status === 200, `unconfigured webhook should be 200, got ${res.status}`);
  assert(body.received === true && body.handled === false, 'received but not handled');
  assert(body.reason === 'billing_not_configured', `reason, got ${body.reason}`);
  console.log('  an unconfigured webhook accepts and drops rather than erroring');
}

{
  const res = await post('/api/billing/checkout', JSON.stringify({ planId: 'solo_premium' }));
  assert(res.status === 401, `checkout without a session is 401, got ${res.status}`);
  console.log('  checkout requires a session');
}

// ---- raw body ---------------------------------------------------------------

{
  // The payload a provider signs is the exact bytes it sent. This asserts the
  // bytes reach verifyWebhook untouched: no re-serialisation, no key
  // reordering, no unicode normalisation, and not truncated by the 64 KB cap
  // that server/index.js applies to ordinary JSON routes.
  provider.name = 'stripe';
  let seenRaw = null;
  let seenSignature = null;
  const original = provider.verifyWebhook;
  provider.verifyWebhook = (raw, signature) => {
    seenRaw = raw;
    seenSignature = signature;
    return null;
  };

  // Deliberately awkward: duplicate-looking keys in a fixed order, a unicode
  // escape, and enough padding to exceed the generic 64 KB body cap.
  const payload = `{"b":1,"a":2,"note":"\\u00e9\\u2014ok","pad":"${'x'.repeat(70 * 1024)}"}`;
  const res = await post('/api/billing/webhook', payload, { 'stripe-signature': 't=1,v1=abc' });

  assert(Buffer.isBuffer(seenRaw), 'the body arrives as a Buffer, not a parsed object');
  assert(
    seenRaw.toString('utf8') === payload,
    'the body reaches verifyWebhook byte for byte, including past 64 KB'
  );
  assert(seenSignature === 't=1,v1=abc', 'the signature header is passed through');
  assert(res.status === 400, `an unverifiable payload is refused once configured, got ${res.status}`);
  assert((await res.json()).error === 'invalid_signature', 'and says why');

  provider.verifyWebhook = original;
  console.log('  the raw body survives the request chain byte for byte, past 64 KB');
}

{
  // Oversize is refused rather than silently truncated: a truncated body would
  // fail signature verification and look like an attack instead of a limit.
  provider.name = 'stripe';
  // The server answers 413 and then closes. Depending on how much of the body
  // is already in flight the client may see the response or see the close, so
  // both are acceptable; what is not acceptable is a 200 on a truncated body,
  // because a truncated payload fails signature verification and looks like an
  // attack rather than a size limit.
  const res = await post('/api/billing/webhook', 'x'.repeat(2 * 1024 * 1024)).catch((err) => ({
    status: 0,
    err
  }));
  assert(res.status === 413 || res.status === 0, `oversize should be refused, got ${res.status}`);
  console.log('  an oversize webhook is refused, not truncated');
}

// ---- idempotency ------------------------------------------------------------

{
  _resetSeenEvents();
  assert(alreadyHandled('evt_100') === false, 'a new event is not already handled');
  assert(alreadyHandled('evt_100') === true, 'the same event twice is a duplicate');
  assert(alreadyHandled('evt_101') === false, 'a different event is not');
  assert(alreadyHandled('') === false, 'a missing id is never treated as a duplicate');
  console.log('  event ids are remembered so a retry is not applied twice');
}

{
  _resetSeenEvents();
  provider.name = 'stripe';
  const original = provider.verifyWebhook;
  provider.verifyWebhook = () => ({ id: 'evt_dup', data: { status: 'active' } });

  const first = await (await post('/api/billing/webhook', '{}', { 'stripe-signature': 's' })).json();
  const second = await (await post('/api/billing/webhook', '{}', { 'stripe-signature': 's' })).json();

  assert(first.received === true, 'the first delivery is received');
  assert(second.handled === false && second.reason === 'duplicate', 'the retry is recognised');

  provider.verifyWebhook = original;
  console.log('  a retried delivery is recognised and not applied again');
}

// ---- status mapping ---------------------------------------------------------

{
  assert(mapProviderStatus('active') === 'active', 'active maps through');
  assert(mapProviderStatus('trialing') === 'trialing', 'trialing maps through');
  assert(mapProviderStatus('past_due') === 'past_due', 'past_due maps through');
  assert(mapProviderStatus('unpaid') === 'past_due', 'unpaid is dunning, not cancellation');
  assert(mapProviderStatus('canceled') === 'cancelled', 'the American spelling maps too');
  assert(mapProviderStatus('something_new') === null, 'an unknown status maps to nothing');
  assert(mapProviderStatus(undefined) === null, 'and so does a missing one');
  console.log('  provider statuses map onto ours, unknown ones to nothing');
}

provider.name = null;
server.close();
console.log('webhook: all assertions passed');

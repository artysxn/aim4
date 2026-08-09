// ---------------------------------------------------------------------------
// server/ingest/faceit/webhook.test.js
// The door policy: who gets in, what becomes work, what is quietly dropped.
//
// These are the two pure functions from webhookRoutes.js. They are unit-tested
// rather than exercised through a live server because the interesting cases are
// all "a request that should not be accepted", and the cheapest way to be sure
// none of them is accepted is to enumerate them.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { authorizeDelivery, secretMatches, shouldHandle } from './webhookRoutes.js';

const SECRET = 'a'.repeat(64);

const cfg = (over = {}) => ({
  webhookSecret: SECRET,
  webhookHeaderName: 'x-aim4-webhook-secret',
  webhookQueryName: '',
  championships: [],
  organizers: [],
  ...over
});

const req = (headers = {}) => ({ headers });
const url = (qs = '') => new URL(`https://api.aim4.io/api/ingest/faceit/webhook${qs}`);

// `over` is spread first so a test can override `event`, then payload is
// rebuilt from the defaults: spreading `over` last would replace the whole
// payload object rather than merging into it, which silently drops the
// organizer_id and entity most of these cases depend on.
const envelope = (over = {}) => ({
  event: 'match_demo_ready',
  ...over,
  payload: {
    id: '1-cb038819-b0d0-4471-b25c-0e7468ab1eb1',
    game: 'cs2',
    organizer_id: 'org-1',
    entity: { id: 'champ-1', type: 'championship' },
    ...(over.payload || {})
  }
});

// --- secretMatches ---------------------------------------------------------

assert.equal(secretMatches(SECRET, SECRET), true);
assert.equal(secretMatches(SECRET, 'b'.repeat(64)), false);
// Length mismatch must be a plain false, not the throw timingSafeEqual does on
// unequal buffer lengths.
assert.equal(secretMatches(SECRET, 'short'), false);
assert.equal(secretMatches(SECRET, ''), false);
assert.equal(secretMatches(SECRET, undefined), false);
assert.equal(secretMatches('', SECRET), false);

// --- authorizeDelivery -----------------------------------------------------

assert.equal(
  authorizeDelivery(cfg(), req({ 'x-aim4-webhook-secret': SECRET }), url()).ok,
  true,
  'correct header is accepted'
);

assert.equal(
  authorizeDelivery(cfg(), req({ 'x-aim4-webhook-secret': 'nope' }), url()).ok,
  false,
  'wrong header value is rejected'
);

assert.equal(authorizeDelivery(cfg(), req(), url()).ok, false, 'missing header is rejected');

// The fail-closed case, and the reason this file exists. An unconfigured secret
// on a public endpoint must reject, never wave everything through.
{
  const result = authorizeDelivery(cfg({ webhookSecret: '' }), req(), url());
  assert.equal(result.ok, false);
  assert.match(result.reason, /not configured/);
}

// Query-string mode, for deployments that cannot pass a custom header.
{
  const c = cfg({ webhookHeaderName: '', webhookQueryName: 'token' });
  assert.equal(authorizeDelivery(c, req(), url(`?token=${SECRET}`)).ok, true);
  assert.equal(authorizeDelivery(c, req(), url('?token=nope')).ok, false);
  assert.equal(authorizeDelivery(c, req(), url()).ok, false);
}

// Both configured: either one satisfying it is enough.
{
  const c = cfg({ webhookQueryName: 'token' });
  assert.equal(authorizeDelivery(c, req({ 'x-aim4-webhook-secret': SECRET }), url()).ok, true);
  assert.equal(authorizeDelivery(c, req(), url(`?token=${SECRET}`)).ok, true);
  assert.equal(authorizeDelivery(c, req(), url('?token=nope')).ok, false);
}

// --- shouldHandle ----------------------------------------------------------

assert.equal(shouldHandle(cfg(), envelope()).handle, true, 'demo ready, no filters, is work');

assert.equal(
  shouldHandle(cfg(), envelope({ event: 'hub_user_added' })).handle,
  false,
  'unrelated event is dropped'
);

assert.equal(
  shouldHandle(cfg(), envelope({ event: 'match_status_finished' })).handle,
  true,
  'finished opens an awaiting_demo row'
);

assert.equal(shouldHandle(cfg(), { event: 'match_demo_ready' }).handle, false, 'no payload');
assert.equal(shouldHandle(cfg(), envelope({ payload: { id: '' } })).handle, false, 'no match id');

assert.equal(
  shouldHandle(cfg(), envelope({ payload: { game: 'csgo' } })).handle,
  false,
  'csgo demos are declined: the parser targets cs2'
);

// Filtering. A single organizer-scoped subscription delivers every championship
// that organizer runs, so this is the only place a specific event is selected.
{
  const c = cfg({ championships: ['champ-1'] });
  assert.equal(shouldHandle(c, envelope()).handle, true);
  assert.equal(
    shouldHandle(c, envelope({ payload: { entity: { id: 'champ-2' } } })).handle,
    false,
    'a championship we did not ask for is dropped'
  );
}

{
  const c = cfg({ organizers: ['org-1'] });
  assert.equal(
    shouldHandle(c, envelope({ payload: { entity: { id: 'champ-9' } } })).handle,
    true,
    'organizer allowlist admits any of their championships'
  );
  assert.equal(shouldHandle(c, envelope({ payload: { organizer_id: 'org-2' } })).handle, false);
}

// Either list admitting it is enough, so a one-off championship can be added
// without touching the organizer list.
{
  const c = cfg({ championships: ['champ-1'], organizers: ['org-9'] });
  assert.equal(shouldHandle(c, envelope({ payload: { organizer_id: 'org-2' } })).handle, true);
}

console.log('faceit webhook tests passed');

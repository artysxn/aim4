// Run: node server/admin/impersonation.test.js
//
// Impersonation is the feature with the most ways to go wrong, and every one of
// them ends with an admin session doing something to a customer's account. The
// checks that matter:
//
//   a ticket alone is worthless without the admin's live session
//   admin B cannot use admin A's ticket
//   admins cannot be impersonated
//   impersonating never confers admin
//   a read-only session cannot write
//   revocation is immediate, not at expiry

import http from 'node:http';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- stub Supabase ----------------------------------------------------------

const ADMIN_A = '11111111-1111-4111-8111-111111111111';
const ADMIN_B = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';

const tokens = {
  'token-admin-a': { id: ADMIN_A, user_metadata: { username: 'artysan' } },
  'token-admin-b': { id: ADMIN_B, user_metadata: { username: 'ryL' } },
  'token-target': { id: TARGET, user_metadata: { username: 'someplayer' } }
};
const admins = new Set([ADMIN_A, ADMIN_B]);

const stub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/auth/v1/user') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = tokens[token];
    res.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(user || { error: 'bad token' }));
    return;
  }

  if (url.pathname === '/rest/v1/site_admins') {
    const filter = url.searchParams.get('user_id') || '';
    const id = filter.replace(/^eq\./, '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(admins.has(id) ? [{ user_id: id, can_impersonate: true }] : []));
    return;
  }

  if (url.pathname === '/rest/v1/profiles') {
    const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(id === TARGET ? [{ username: 'someplayer' }] : []));
    return;
  }

  // Subscriptions, seats and grants: this account holds nothing.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('[]');
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;
process.env.SUPABASE_URL = base;
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
process.env.AIM4_IMPERSONATION_SECRET = 'test-impersonation-secret';

const { mintTicket, revokeTicket, verifyTicket, _resetRevoked } = await import('./impersonation.js');
const { whoami, readOnlyBlocked } = await import('../replays/identity.js');

/** A request object shaped the way Node's http server produces one. */
function request({ token, ticket, method = 'GET' } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (ticket) headers['x-aim4-impersonate'] = ticket;
  return { method, headers, socket: { remoteAddress: '127.0.0.1' } };
}

// ---- minting and verifying --------------------------------------------------

{
  const { ticket, jti } = await mintTicket({ actorId: ADMIN_A, targetId: TARGET });
  const claims = await verifyTicket(ticket);
  assert(claims?.actorId === ADMIN_A, 'the ticket names its actor');
  assert(claims?.targetId === TARGET, 'and its target');
  assert(claims?.readOnly === true, 'read-only is the default');
  assert(claims?.jti === jti, 'and carries the id it was minted with');
  console.log('  a minted ticket verifies, read-only by default');
}

{
  assert((await verifyTicket('not-a-jwt')) === null, 'garbage does not verify');
  assert((await verifyTicket('')) === null, 'an empty ticket does not verify');

  const { ticket } = await mintTicket({ actorId: ADMIN_A, targetId: TARGET });
  const tampered = `${ticket.slice(0, -3)}aaa`;
  assert((await verifyTicket(tampered)) === null, 'a tampered signature does not verify');
  console.log('  garbage and tampered tickets do not verify');
}

{
  let threw = false;
  try {
    await mintTicket({ actorId: ADMIN_A, targetId: ADMIN_A });
  } catch {
    threw = true;
  }
  assert(threw, 'you cannot mint a ticket to impersonate yourself');
  console.log('  self-impersonation is refused at mint time');
}

{
  const expired = await mintTicket({ actorId: ADMIN_A, targetId: TARGET, ttlSeconds: -10 });
  assert((await verifyTicket(expired.ticket)) === null, 'an expired ticket does not verify');
  console.log('  an expired ticket does not verify');
}

// ---- revocation -------------------------------------------------------------

{
  _resetRevoked();
  const { ticket, jti } = await mintTicket({ actorId: ADMIN_A, targetId: TARGET });
  assert(await verifyTicket(ticket), 'valid before revocation');
  revokeTicket(jti, Math.floor(Date.now() / 1000) + 1800);
  assert((await verifyTicket(ticket)) === null, 'revocation takes effect immediately');
  console.log('  revoking a ticket takes effect immediately, not at expiry');
}

// ---- whoami integration -----------------------------------------------------

{
  _resetRevoked();
  const { ticket } = await mintTicket({ actorId: ADMIN_A, targetId: TARGET });
  const me = await whoami(request({ token: 'token-admin-a', ticket }));
  assert(me.id === TARGET, `identity should become the target, got ${me.id}`);
  assert(me.username === 'someplayer', 'and carry the target username');
  assert(me.impersonating?.actorId === ADMIN_A, 'while reporting who is driving');
  assert(me.admin === false, 'impersonating must never confer admin');
  console.log('  a valid ticket resolves to the target, and never carries admin');
}

{
  // The central check: a stolen ticket without the admin's session does nothing.
  _resetRevoked();
  const { ticket } = await mintTicket({ actorId: ADMIN_A, targetId: TARGET });
  const anon = await whoami(request({ ticket }));
  assert(anon.signedIn === false, 'a ticket with no bearer token is anonymous');

  const asTarget = await whoami(request({ token: 'token-target', ticket }));
  assert(asTarget.id === TARGET && !asTarget.impersonating, 'a non-admin cannot use a ticket');
  console.log('  a ticket without a live admin session does nothing');
}

{
  // Admin B picking up admin A's ticket.
  _resetRevoked();
  const { ticket } = await mintTicket({ actorId: ADMIN_A, targetId: TARGET });
  const me = await whoami(request({ token: 'token-admin-b', ticket }));
  assert(me.id === ADMIN_B, `admin B stays admin B, got ${me.id}`);
  assert(me.impersonating === null, 'admin B cannot use admin A ticket');
  console.log('  a ticket minted for one admin is rejected for another');
}

{
  // Impersonating an admin would let one admin launder actions through another.
  _resetRevoked();
  const { ticket } = await mintTicket({ actorId: ADMIN_A, targetId: ADMIN_B });
  const me = await whoami(request({ token: 'token-admin-a', ticket }));
  assert(me.id === ADMIN_A, `impersonating an admin must be refused, got ${me.id}`);
  assert(me.impersonating === null, 'and leaves the session untouched');
  console.log('  impersonating another admin is refused');
}

// ---- read-only --------------------------------------------------------------

{
  _resetRevoked();
  const { ticket } = await mintTicket({ actorId: ADMIN_A, targetId: TARGET, readOnly: true });
  const me = await whoami(request({ token: 'token-admin-a', ticket }));

  assert(!readOnlyBlocked(request({ method: 'GET' }), me), 'GET is allowed');
  assert(!readOnlyBlocked(request({ method: 'HEAD' }), me), 'HEAD is allowed');
  assert(readOnlyBlocked(request({ method: 'POST' }), me), 'POST is blocked');
  assert(readOnlyBlocked(request({ method: 'DELETE' }), me), 'DELETE is blocked');
  console.log('  a read-only session may read but not write');
}

{
  _resetRevoked();
  const { ticket } = await mintTicket({ actorId: ADMIN_A, targetId: TARGET, readOnly: false });
  const me = await whoami(request({ token: 'token-admin-a', ticket }));
  assert(me.impersonating?.readOnly === false, 'write mode is reported');
  assert(!readOnlyBlocked(request({ method: 'POST' }), me), 'write mode allows POST');
  console.log('  write-mode impersonation is a separate, explicit choice');
}

{
  // Someone not impersonating at all is never blocked.
  const plain = await whoami(request({ token: 'token-target' }));
  assert(!readOnlyBlocked(request({ method: 'POST' }), plain), 'a normal session writes freely');
  console.log('  a normal session is unaffected by the read-only gate');
}

stub.close();
console.log('impersonation: all assertions passed');

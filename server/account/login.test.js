// Run: node server/account/login.test.js
//
// Password sign-in by username or email, against a stubbed Supabase.
//
// The property worth protecting here is not "a good password works" but what
// happens when one does not: an unknown username and a wrong password must be
// indistinguishable to the caller, or the login form becomes a way to ask which
// accounts exist. The email behind a username must never appear in a response
// either, which is the whole reason this resolution happens on the server.

import http from 'node:http';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- a stand-in for Supabase ------------------------------------------------

const USERS = [
  { id: 'uuid-vip', username: 'viptest123', email: 'viptest123@users.aim4.io', password: 'pepsimax67' },
  { id: 'uuid-old', username: 'oldtimer', email: 'real.person@gmail.com', password: 'hunter2hunter' }
];

const calls = { profiles: 0, adminUser: 0, token: 0 };

const stub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  };

  if (url.pathname === '/rest/v1/profiles') {
    calls.profiles += 1;
    // PostgREST filter syntax: username=eq.<name>
    const want = String(url.searchParams.get('username') || '').replace(/^eq\./, '');
    const hit = USERS.find((u) => u.username === want);
    send(200, hit ? [{ id: hit.id }] : []);
    return;
  }

  const adminMatch = url.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/);
  if (adminMatch) {
    calls.adminUser += 1;
    const hit = USERS.find((u) => u.id === decodeURIComponent(adminMatch[1]));
    if (!hit) return send(404, { msg: 'not found' });
    send(200, { id: hit.id, email: hit.email });
    return;
  }

  if (url.pathname === '/auth/v1/token') {
    calls.token += 1;
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const hit = USERS.find((u) => u.email === body.email && u.password === body.password);
      if (!hit) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      send(200, {
        access_token: `access-${hit.id}`,
        refresh_token: `refresh-${hit.id}`,
        token_type: 'bearer',
        expires_in: 3600,
        user: { id: hit.id, email: hit.email }
      });
    });
    return;
  }

  // whoami() probes this for every account request. No token, no user: the
  // login route is reached while signed out, which is the whole point.
  if (url.pathname === '/auth/v1/user') return send(401, { msg: 'no session' });

  send(404, { msg: 'unexpected path' });
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;

process.env.SUPABASE_URL = base;
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

const { passwordLogin, resetLoginThrottle } = await import('./login.js');

/** A fresh caller each time, so one test's attempts never bleed into the next. */
let ipSeed = 0;
const reqFrom = (ip = `10.0.0.${++ipSeed}`) => ({
  headers: { 'x-forwarded-for': ip },
  socket: { remoteAddress: ip }
});

// ---- sign in by username ----------------------------------------------------
{
  resetLoginThrottle();
  const { status, body } = await passwordLogin(reqFrom(), {
    identifier: 'viptest123',
    password: 'pepsimax67'
  });
  assert(status === 200, `username sign-in succeeds (got ${status})`);
  assert(body.access_token === 'access-uuid-vip', 'the session comes back');
  assert(body.refresh_token === 'refresh-uuid-vip', 'with its refresh token');
  // The address behind the username is the thing this design exists to hide.
  const serialized = JSON.stringify(body);
  assert(!serialized.includes('@'), 'no email address appears in the response');
  assert(!('user' in body), 'and no user object rides along');
}

// Case and stray whitespace are how people actually type a username.
{
  resetLoginThrottle();
  const { status } = await passwordLogin(reqFrom(), {
    identifier: '  VipTest123 ',
    password: 'pepsimax67'
  });
  assert(status === 200, 'usernames are matched case-insensitively and trimmed');
}

// ---- sign in by email, for accounts that predate username login -------------
{
  resetLoginThrottle();
  const before = calls.profiles;
  const { status, body } = await passwordLogin(reqFrom(), {
    identifier: 'Real.Person@gmail.com',
    password: 'hunter2hunter'
  });
  assert(status === 200, `email sign-in still works (got ${status})`);
  assert(body.access_token === 'access-uuid-old', 'and returns that account');
  assert(calls.profiles === before, 'an email identifier skips the username lookup entirely');
}

// ---- the two failures are indistinguishable ---------------------------------
{
  resetLoginThrottle();
  const wrongPass = await passwordLogin(reqFrom(), {
    identifier: 'viptest123',
    password: 'not-the-password'
  });
  resetLoginThrottle();
  const noSuchUser = await passwordLogin(reqFrom(), {
    identifier: 'nobody_here',
    password: 'not-the-password'
  });

  assert(wrongPass.status === 401, 'a wrong password is a 401');
  assert(noSuchUser.status === 401, 'an unknown username is also a 401');
  assert(
    wrongPass.body.error === noSuchUser.body.error,
    'and both say exactly the same thing, so the form cannot enumerate accounts'
  );
  assert(!wrongPass.body.access_token, 'no session on a failed sign-in');
}

// A username that could never exist is rejected without a database round trip.
{
  resetLoginThrottle();
  const before = calls.profiles;
  const { status } = await passwordLogin(reqFrom(), { identifier: 'no', password: 'whatever' });
  assert(status === 401, 'an illegal username fails like any other bad credential');
  assert(calls.profiles === before, 'and never reaches the database');
}

// ---- missing input ----------------------------------------------------------
{
  resetLoginThrottle();
  const noPass = await passwordLogin(reqFrom(), { identifier: 'viptest123', password: '' });
  assert(noPass.status === 400, 'a missing password is a 400, not a credential failure');
  const noId = await passwordLogin(reqFrom(), { identifier: '', password: 'x' });
  assert(noId.status === 400, 'and so is a missing identifier');
}

// ---- rate limiting ----------------------------------------------------------
{
  resetLoginThrottle();
  const attacker = reqFrom('203.0.113.9');
  let last = null;
  for (let i = 0; i < 12; i++) {
    last = await passwordLogin(attacker, { identifier: 'viptest123', password: `guess-${i}` });
  }
  assert(last.status === 429, `a dictionary run is cut off (ended on ${last.status})`);

  // The real password must not get through while the lockout is in force.
  const stillLocked = await passwordLogin(attacker, {
    identifier: 'viptest123',
    password: 'pepsimax67'
  });
  assert(stillLocked.status === 429, 'the lockout holds even for the correct password');

  // Someone else's session is unaffected by that address being locked out.
  const bystander = await passwordLogin(reqFrom('198.51.100.4'), {
    identifier: 'oldtimer',
    password: 'hunter2hunter'
  });
  assert(bystander.status === 200, 'another address is not caught in the lockout');
}

// A success clears the counter, so a few typos do not lock someone out.
{
  resetLoginThrottle();
  const person = reqFrom('192.0.2.77');
  for (let i = 0; i < 3; i++) {
    await passwordLogin(person, { identifier: 'viptest123', password: 'typo' });
  }
  const ok = await passwordLogin(person, { identifier: 'viptest123', password: 'pepsimax67' });
  assert(ok.status === 200, 'a correct password after a few typos still works');
  for (let i = 0; i < 9; i++) {
    await passwordLogin(person, { identifier: 'viptest123', password: 'typo' });
  }
  const after = await passwordLogin(person, { identifier: 'viptest123', password: 'typo' });
  assert(after.status === 401, 'and the counter restarted from that success');
}

// ---- unconfigured deployments fail closed, and say so -----------------------
{
  resetLoginThrottle();
  const saved = process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_ANON_KEY = '';
  const { status } = await passwordLogin(reqFrom(), {
    identifier: 'viptest123',
    password: 'pepsimax67'
  });
  assert(status === 503, 'no anon key means unavailable, not unauthorized');
  process.env.SUPABASE_ANON_KEY = saved;
}

// ---- the endpoint itself, through the account router ------------------------
// Everything above tests the module. This tests that POST /api/account/login
// actually reaches it while signed out, which is the part a wiring mistake
// would break without failing a single assertion above.
{
  resetLoginThrottle();
  const { handleAccountRequest } = await import('./routes.js');
  const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await handleAccountRequest(req, res, url)) return;
    res.writeHead(404).end();
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${api.address().port}`;

  const post = (body) =>
    fetch(`${apiBase}/api/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  const ok = await post({ identifier: 'viptest123', password: 'pepsimax67' });
  const okBody = await ok.json();
  assert(ok.status === 200, `the route serves a good sign-in (got ${ok.status})`);
  assert(okBody.access_token === 'access-uuid-vip', 'and returns the session');
  assert(ok.headers.get('cache-control') === 'no-store', 'a session is never cached');

  const bad = await post({ identifier: 'viptest123', password: 'wrong' });
  assert(bad.status === 401, 'and refuses a bad one');
  assert((await bad.json()).error === 'Wrong username or password.', 'with the uniform message');

  // The browser sends a cross-origin preflight before this POST.
  const pre = await fetch(`${apiBase}/api/account/login`, { method: 'OPTIONS' });
  assert(pre.status === 204, 'the preflight is answered');
  assert(
    String(pre.headers.get('access-control-allow-methods') || '').includes('POST'),
    'and allows the POST the form makes'
  );

  api.close();
}

stub.close();
console.log('login.test.js: all assertions passed');

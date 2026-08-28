// Run: node server/account/register.test.js
//
// Username registration, against a stubbed Supabase.
//
// The properties worth protecting: a new account signs IN as part of signing
// UP (a registration that ends signed out is a login form with extra steps);
// the internal login email never appears in a response; a taken name is a
// clear 409 whether profiles or auth knew it first; and validation runs
// before anything touches the network.

import http from 'node:http';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- a stand-in for Supabase ------------------------------------------------

const TAKEN = ['viptest123'];
const created = [];
const calls = { profiles: 0, create: 0, token: 0 };

const stub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  };

  if (url.pathname === '/rest/v1/profiles') {
    calls.profiles += 1;
    const want = String(url.searchParams.get('username') || '').replace(/^eq\./, '');
    send(200, TAKEN.includes(want) ? [{ id: 'uuid-taken' }] : []);
    return;
  }

  if (url.pathname === '/auth/v1/admin/users' && req.method === 'POST') {
    calls.create += 1;
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      // The auth-side duplicate: profiles missed it, GoTrue knows the address.
      if (body.email === 'ghost@users.aim4.io') {
        return send(422, { msg: 'A user with this email address has already been registered' });
      }
      created.push(body);
      send(200, { id: `uuid-${body.user_metadata?.username}`, email: body.email });
    });
    return;
  }

  if (url.pathname === '/auth/v1/token') {
    calls.token += 1;
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const hit = created.find((u) => u.email === body.email && u.password === body.password);
      if (!hit) return send(400, { error: 'invalid_grant' });
      send(200, {
        access_token: `access-${hit.user_metadata.username}`,
        refresh_token: `refresh-${hit.user_metadata.username}`,
        token_type: 'bearer',
        expires_in: 3600
      });
    });
    return;
  }

  if (url.pathname === '/auth/v1/user') return send(401, { msg: 'no session' });
  send(404, { msg: `unexpected path ${url.pathname}` });
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;

process.env.SUPABASE_URL = base;
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

const { registerAccount, resetRegisterThrottle, validateRegistration } = await import(
  './register.js'
);

let ipSeed = 0;
const reqFrom = (ip = `10.1.0.${++ipSeed}`) => ({
  headers: { 'x-forwarded-for': ip },
  socket: { remoteAddress: ip }
});

// ---- validation happens before the network ---------------------------------
{
  assert(validateRegistration({ username: 'ab', password: 'longenough1' }).error, 'too short');
  assert(validateRegistration({ username: 'a'.repeat(21), password: 'longenough1' }).error, 'too long');
  assert(validateRegistration({ username: 'has space', password: 'longenough1' }).error, 'no spaces');
  assert(validateRegistration({ username: 'näme', password: 'longenough1' }).error, 'ascii only');
  assert(validateRegistration({ username: 'goodname', password: 'short' }).error, 'password length');
  assert(
    validateRegistration({ username: 'goodname', password: 'GOODNAME' }).error,
    'password may not be the username'
  );
  const ok = validateRegistration({ username: '  MixedCase_7 '.trim(), password: 'longenough1' });
  assert(ok.username === 'mixedcase_7', 'usernames are lowercased');

  const before = calls.profiles + calls.create;
  const { status } = await registerAccount(reqFrom(), { username: 'x', password: 'longenough1' });
  assert(status === 400, 'invalid input is a 400');
  assert(calls.profiles + calls.create === before, 'and nothing was queried for it');
}

// ---- the happy path signs the account in ------------------------------------
{
  resetRegisterThrottle();
  const { status, body } = await registerAccount(reqFrom(), {
    username: 'NewPlayer_1',
    password: 'a-decent-password'
  });
  assert(status === 201, `created (got ${status}: ${JSON.stringify(body)})`);
  assert(body.username === 'newplayer_1', 'the lowercased username comes back');
  assert(body.access_token === 'access-newplayer_1', 'signed in as part of signing up');
  assert(body.refresh_token === 'refresh-newplayer_1', 'with a refresh token');
  assert(!JSON.stringify(body).includes('@'), 'the internal email never leaves the server');

  const made = created.at(-1);
  assert(made.email === 'newplayer_1@users.aim4.io', 'internal login address');
  assert(made.email_confirm === true, 'pre-confirmed, no mail is ever sent');
  assert(made.user_metadata.username === 'newplayer_1', 'handle_new_user stamps the profile');
}

// ---- taken names, both ways they can be taken --------------------------------
{
  const { status, body } = await registerAccount(reqFrom(), {
    username: 'viptest123',
    password: 'a-decent-password'
  });
  assert(status === 409, 'profiles says taken');
  assert(/taken/i.test(body.error), 'in plain words');
}
{
  // profiles does not know "ghost", but GoTrue already holds its address.
  const { status, body } = await registerAccount(reqFrom(), {
    username: 'ghost',
    password: 'a-decent-password'
  });
  assert(status === 409, `auth-side duplicate is also a 409 (got ${status})`);
  assert(/taken/i.test(body.error), 'same message either way');
}

// ---- the throttle ------------------------------------------------------------
{
  resetRegisterThrottle();
  const ip = '10.9.9.9';
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await registerAccount(reqFrom(ip), {
      username: `bulk_${i}_${Date.now() % 100000}`,
      password: 'a-decent-password'
    });
  }
  assert(last.status === 429, `the sixth account in an hour is refused (got ${last.status})`);

  const other = await registerAccount(reqFrom('10.9.9.10'), {
    username: `other_${Date.now() % 100000}`,
    password: 'a-decent-password'
  });
  assert(other.status === 201, 'a different address is not punished for it');
}

stub.close();
console.log('register: all assertions passed');

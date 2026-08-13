// Run: node server/sim/guard.test.js
//
// /sim is a hidden page, so the interesting assertions are all about who is
// refused and what the refusal looks like:
//
//   the site admin is allowed
//   an impersonating admin is not (a "view as" window must not show it)
//   an anonymous caller is not
//   a signed-in non-admin is not
//   every refusal is 404-shaped, byte for byte identical, so a prober cannot
//     tell "no such route" from "not you"
//   an identity or database failure fails closed
//   unknown sim paths 404 for the admin too, and never 405/500

import { decideSimAccess, simGuard } from './guard.js';
import { handleSimRequest, _resetRateLimit } from './routes.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ADMIN = '11111111-1111-4111-8111-111111111111';
const PLAYER = '22222222-2222-4222-8222-222222222222';

const asAdmin = { id: ADMIN, username: 'artysan', signedIn: true, admin: true };
const asPlayer = { id: PLAYER, username: 'someplayer', signedIn: true, admin: false };
const anon = { id: null, username: null, signedIn: false, admin: false };
const impersonating = {
  ...asAdmin,
  admin: false,
  impersonating: { actorId: ADMIN, targetId: PLAYER, jti: 'x' }
};

// ---- the pure rule ----------------------------------------------------------

assert(decideSimAccess(asAdmin, true).allowed, 'site admin allowed');
assert(!decideSimAccess(asPlayer, false).allowed, 'non-admin denied');
assert(decideSimAccess(asPlayer, false).reason === 'not-admin', 'reason: not-admin');
assert(!decideSimAccess(anon, false).allowed, 'anonymous denied');
assert(decideSimAccess(anon, true).reason === 'anonymous', 'anonymous denied even if admin table says yes');
assert(!decideSimAccess(impersonating, true).allowed, 'impersonation denied');
assert(decideSimAccess(impersonating, true).reason === 'impersonating', 'reason: impersonating');
assert(!decideSimAccess(null, true).allowed, 'null identity denied');
assert(!decideSimAccess(undefined, true).allowed, 'undefined identity denied');

// ---- the wiring -------------------------------------------------------------

const deps = (me, admins = [ADMIN]) => ({
  whoami: async () => me,
  isSiteAdmin: async (id) => admins.includes(id)
});

{
  const r = await simGuard({}, deps(asAdmin));
  assert(r.allowed, 'simGuard allows the admin');
}
{
  const r = await simGuard({}, deps(asPlayer));
  assert(!r.allowed && r.reason === 'not-admin', 'simGuard denies a player');
}
{
  // An admin whose row has been removed is no longer an admin, immediately.
  const r = await simGuard({}, deps(asAdmin, []));
  assert(!r.allowed && r.reason === 'not-admin', 'simGuard rechecks the table');
}
{
  const r = await simGuard(
    {},
    { whoami: async () => { throw new Error('supabase down'); }, isSiteAdmin: async () => true }
  );
  assert(!r.allowed, 'identity outage fails closed');
}
{
  const r = await simGuard(
    {},
    { whoami: async () => asAdmin, isSiteAdmin: async () => { throw new Error('db down'); } }
  );
  assert(!r.allowed, 'admin lookup failure fails closed');
}
{
  // The admin table must not be consulted for a caller we already refused.
  let asked = 0;
  await simGuard({}, { whoami: async () => anon, isSiteAdmin: async () => { asked += 1; return true; } });
  assert(asked === 0, 'anonymous callers never reach the database');
}

// ---- the response shape -----------------------------------------------------

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload || '';
    }
  };
}

const req = (method = 'GET', body = null) => ({
  method,
  headers: {},
  socket: { remoteAddress: '10.0.0.1' },
  // POST handlers read the body as an async byte stream, like a real request.
  async *[Symbol.asyncIterator]() {
    if (body !== null) yield Buffer.from(JSON.stringify(body));
  }
});
const u = (path) => new URL(`http://localhost${path}`);

async function call(path, me, method = 'GET') {
  _resetRateLimit();
  const res = fakeRes();
  const handled = await handleSimRequest(req(method), res, u(path), deps(me));
  return { handled, res };
}

{
  const { handled } = await call('/api/replays/list', asAdmin);
  assert(handled === false, 'non-sim paths are not claimed');
}
{
  const { handled, res } = await call('/api/sim/me', asAdmin);
  assert(handled && res.status === 200, 'admin gets 200 from /api/sim/me');
  assert(JSON.parse(res.body).ok === true, 'body says ok');
  assert(res.headers['Cache-Control'] === 'no-store', 'no-store on every response');
  assert(!('Access-Control-Allow-Origin' in res.headers), 'no CORS header without an allowed origin');
}

const refusals = [];
for (const me of [anon, asPlayer, impersonating]) {
  const { res } = await call('/api/sim/me', me);
  assert(res.status === 404, 'refusal is 404, never 403');
  refusals.push(res.body);
}
{
  // An unknown sim path, for the admin, must look exactly like a refusal.
  const { res } = await call('/api/sim/does-not-exist', asAdmin);
  assert(res.status === 404, 'unknown sim path is 404');
  refusals.push(res.body);
}
assert(new Set(refusals).size === 1, 'every 404 body is byte-identical');

{
  // A wrong method on a real path is a 404 too, not a 405: the method is
  // another bit of information a prober does not get.
  const { res } = await call('/api/sim/me', asAdmin, 'POST');
  assert(res.status === 404, 'wrong method is 404, not 405');
}
{
  const { res } = await call('/api/sim/me', anon, 'OPTIONS');
  assert(res.status === 204, 'preflight is answered for everyone and carries nothing');
  assert(res.body === '', 'preflight body is empty');
}

// ---- the wider surface: every route answers, and refusals stay identical ----

{
  // The dataset export and the match store are behind the same guard, and a
  // refusal on any of them must be byte-identical to a refusal anywhere else:
  // a prober must not learn which paths exist.
  const surface = [
    '/api/sim/export/list',
    '/api/sim/export/demo?id=x',
    '/api/sim/matches',
    '/api/sim/matches/some-id/round/3/meta',
    '/api/sim/run',
    // The job runner and the model registry are the same secret as everything
    // else here: what this host trains and how well it scores are strategy.
    '/api/sim/jobs',
    '/api/sim/jobs/some-job',
    '/api/sim/models',
    '/api/sim/experience'
  ];
  const anonBodies = [];
  for (const pathq of surface) {
    const { res } = await call(pathq, anon);
    assert(res.status === 404, `anonymous ${pathq} is 404`);
    anonBodies.push(res.body);
  }
  assert(new Set(anonBodies).size === 1, 'and every refusal is the same bytes');

  // For the admin, the endpoints answer. The library on a dev machine is
  // empty; the shape is what matters here, the content is export.test.js's job.
  {
    const { res } = await call('/api/sim/export/list', asAdmin);
    assert(res.status === 200, 'the admin can list exportable demos');
    assert(Array.isArray(JSON.parse(res.body).demos), 'as an array');
  }
  {
    const { res } = await call('/api/sim/export/demo?id=does-not-exist', asAdmin);
    assert(res.status === 404, 'an unknown demo is a 404');
  }
  {
    const { res } = await call('/api/sim/matches', asAdmin);
    assert(res.status === 200 && Array.isArray(JSON.parse(res.body).matches), 'matches list answers');
  }
  {
    const { res } = await call('/api/sim/models', asAdmin);
    assert(res.status === 200, 'the admin can list models');
  }
  {
    const { res } = await call('/api/sim/experience', asAdmin);
    assert(res.status === 200, 'the admin can read experience rows');
    assert(Array.isArray(JSON.parse(res.body).rows), 'as an array');
  }
  {
    const { res } = await call('/api/sim/run', asAdmin);
    assert(res.status === 200, 'run status answers');
    assert('running' in JSON.parse(res.body), 'with a running field');
  }
  {
    // A run on a map with no bake refuses with a reason instead of pretending.
    _resetRateLimit();
    const res = fakeRes();
    await handleSimRequest(req('POST', { map: 'ZZZ' }), res, u('/api/sim/run'), deps(asAdmin));
    assert(res.status === 409, `an unbaked map refuses (${res.status})`);
    assert(JSON.parse(res.body).error.includes('bake'), 'and says why');
  }
}

// ---- rate limit -------------------------------------------------------------

{
  _resetRateLimit();
  const limit = Number(process.env.AIM4_SIM_RATE_LIMIT || 240);
  let last = null;
  for (let i = 0; i < limit + 2; i += 1) {
    const res = fakeRes();
    await handleSimRequest(req(), res, u('/api/sim/me'), deps(asAdmin));
    last = res;
  }
  assert(last.status === 429, 'the limiter eventually bites');
}

console.log('sim guard: ok');

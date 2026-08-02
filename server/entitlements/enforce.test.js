// Run: node server/entitlements/enforce.test.js
//
// The gate itself: limits, quotas, and the shape of a refusal.
//
// Quota consumption is driven against a stub PostgREST that reproduces
// consume_quota's contract in JS, including its serialisation. That exercises
// the Node side end to end, but note what it does NOT prove: the real
// atomicity lives in the SQL function's advisory lock, and only a live Postgres
// can demonstrate that two concurrent transactions cannot both pass. The stub
// asserts the behaviour this layer depends on, not that the SQL delivers it.

import http from 'node:http';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- stub PostgREST ---------------------------------------------------------

/** capability -> { windowStart, used } per user. */
const counters = new Map();
/** Serialises consume_quota the way pg_advisory_xact_lock does. */
let chain = Promise.resolve();
let consumeCalls = 0;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

const stub = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const body = await readBody(req);

  if (url.pathname === '/rest/v1/rpc/consume_quota') {
    consumeCalls++;
    const result = await (chain = chain.then(async () => {
      // A tick of real asynchrony between the read and the write, so an
      // unserialised implementation would visibly interleave here.
      const key = `${body.p_user_id}:${body.p_capability}`;
      const limit = Number(body.p_limit);
      const windowMs = Number(body.p_window_seconds) * 1000;
      const now = Date.now();
      let row = counters.get(key);
      await new Promise((r) => setImmediate(r));
      if (!row || now >= row.windowStart + windowMs) {
        row = { windowStart: now, used: 0 };
      }
      const allowed = row.used < limit;
      if (allowed) row.used += 1;
      counters.set(key, row);
      return {
        allowed,
        used_count: row.used,
        limit_value: limit,
        window_started_at: new Date(row.windowStart).toISOString(),
        resets_at: new Date(row.windowStart + windowMs).toISOString()
      };
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([result]));
    return;
  }

  if (url.pathname === '/rest/v1/rpc/peek_quota') {
    const key = `${body.p_user_id}:${body.p_capability}`;
    const row = counters.get(key);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        row
          ? [{ used_count: row.used, window_started_at: new Date(row.windowStart).toISOString() }]
          : []
      )
    );
    return;
  }

  res.writeHead(404).end('[]');
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';

const { CAP } = await import('../../shared/entitlements/keys.js');
const { resolveEntitlements } = await import('../../shared/entitlements/resolve.js');
const {
  UpgradeRequiredError,
  can,
  capability,
  checkLimit,
  consumeQuota,
  requireCapability,
  requireLimit,
  requireQuota,
  upgradeResponse
} = await import('./enforce.js');

/** A user object shaped the way whoami() returns one. */
function userOn(planId, extra = {}) {
  const subscription =
    planId === 'free'
      ? null
      : {
          plan_id: planId,
          status: 'active',
          term: 'month',
          current_period_end: new Date(Date.now() + 30 * 86400_000).toISOString()
        };
  return {
    id: extra.id || `user-${planId}`,
    username: planId,
    signedIn: true,
    admin: Boolean(extra.isAdmin),
    entitlements: resolveEntitlements({ subscription, isAdmin: extra.isAdmin, now: Date.now() }),
    impersonating: extra.impersonating || null
  };
}

// ---- reading capabilities ---------------------------------------------------

{
  assert(capability(userOn('free'), CAP.DEMOS_UPLOAD_LIMIT) === 3, 'free uploads 3');
  assert(capability(userOn('premium'), CAP.DEMOS_UPLOAD_LIMIT) === 50, 'premium uploads 50');
  assert(capability(userOn('team_elite'), CAP.DEMOS_UPLOAD_LIMIT) === -1, 'elite is unlimited');

  // A route that forgot to await whoami() passes something with no entitlements.
  // That must read as the free tier, never as undefined-and-therefore-allowed.
  assert(capability({}, CAP.DEMOS_UPLOAD_LIMIT) === 3, 'a user with no entitlements reads as free');
  assert(can({}, CAP.STATS_SINGLE_GAME) === false, 'and is denied paid capabilities');

  let threw = false;
  try {
    capability(userOn('free'), 'demos.upload_limt');
  } catch {
    threw = true;
  }
  assert(threw, 'a misspelled capability key throws rather than reading undefined');
  console.log('  capability reads fall back to free and reject unknown keys');
}

// ---- limits -----------------------------------------------------------------

{
  const free = userOn('free');
  assert(checkLimit(free, CAP.DEMOS_UPLOAD_LIMIT, 0).allowed, '0 of 3 may upload');
  assert(checkLimit(free, CAP.DEMOS_UPLOAD_LIMIT, 2).allowed, '2 of 3 may upload');
  assert(checkLimit(free, CAP.DEMOS_UPLOAD_LIMIT, 2).remaining === 1, 'one left at 2 of 3');
  assert(!checkLimit(free, CAP.DEMOS_UPLOAD_LIMIT, 3).allowed, 'exactly at the limit is refused');
  assert(!checkLimit(free, CAP.DEMOS_UPLOAD_LIMIT, 99).allowed, 'over the limit is refused');

  const elite = userOn('team_elite');
  assert(checkLimit(elite, CAP.DEMOS_UPLOAD_LIMIT, 100_000).allowed, 'unlimited never refuses');
  assert(checkLimit(elite, CAP.DEMOS_UPLOAD_LIMIT, 5).remaining === -1, 'unlimited remaining is -1');
  console.log('  limits refuse exactly at the cap, and unlimited never refuses');
}

{
  // An admin is unlimited through resolution, not through a branch in the
  // route. This is the check that the old `if (me.admin) return ''` is gone.
  const admin = userOn('free', { isAdmin: true });
  assert(checkLimit(admin, CAP.DEMOS_UPLOAD_LIMIT, 10_000).allowed, 'admins are never capped');
  console.log('  an admin is uncapped by resolution, with no special case in the gate');
}

// ---- the 402 shape ----------------------------------------------------------

{
  let err = null;
  try {
    requireLimit(userOn('free'), CAP.DEMOS_UPLOAD_LIMIT, 3);
  } catch (e) {
    err = e;
  }
  assert(err instanceof UpgradeRequiredError, 'a full cap throws UpgradeRequiredError');
  assert(err.status === 402, `status should be 402, got ${err.status}`);

  const refusal = upgradeResponse(err);
  assert(refusal.status === 402, 'upgradeResponse reports 402');
  const body = refusal.body;
  assert(body.error === 'upgrade_required', `error key, got ${body.error}`);
  assert(body.capability === CAP.DEMOS_UPLOAD_LIMIT, 'names the capability');
  assert(body.currentTier === 'free', `currentTier, got ${body.currentTier}`);
  assert(body.requiredTier === 'premium', `cheapest sufficient tier, got ${body.requiredTier}`);
  assert(body.limit.current === 3 && body.limit.limit === 3, 'reports the counts');
  assert(!/—/.test(body.message), 'no em dashes in user-facing copy');
  console.log('  a blocked limit produces the documented 402 body');
}

{
  // Pointing a Free user at Elite for something Premium already covers is the
  // failure mode this guards against.
  let err = null;
  try {
    await requireCapability(userOn('free'), CAP.STATS_METRICS_PLAYER_FULL);
  } catch (e) {
    err = e;
  }
  assert(err.toJSON().requiredTier === 'premium', 'names Premium, not Team Elite');

  let eliteErr = null;
  try {
    await requireCapability(userOn('premium'), CAP.STATS_METRICS_TEAM_FULL);
  } catch (e) {
    eliteErr = e;
  }
  assert(eliteErr.toJSON().requiredTier === 'team_elite', 'Elite-only really does name Elite');
  console.log('  refusals name the cheapest plan that would unlock the feature');
}

{
  // Enum capabilities.
  const premium = userOn('premium');
  const ok = await requireCapability(premium, CAP.AIM_REPLAYS, { atLeast: 'best_and_recent' });
  assert(ok.allowed, 'premium meets best_and_recent');

  let err = null;
  try {
    await requireCapability(premium, CAP.AIM_REPLAYS, { atLeast: 'full' });
  } catch (e) {
    err = e;
  }
  assert(err?.status === 402, 'premium does not meet full');
  assert(err.toJSON().requiredTier === 'team_elite', 'full replays are Elite');
  console.log('  enum capabilities compare against a required level');
}

// ---- quotas -----------------------------------------------------------------

{
  const free = userOn('free', { id: 'quota-user-1' });
  // analytics.charts is 3 per 24h on free.
  const a = await consumeQuota(free, CAP.ANALYTICS_CHARTS);
  assert(a.allowed && a.used === 1 && a.remaining === 2, `first use: ${JSON.stringify(a)}`);
  const b = await consumeQuota(free, CAP.ANALYTICS_CHARTS);
  const c = await consumeQuota(free, CAP.ANALYTICS_CHARTS);
  assert(c.allowed && c.used === 3 && c.remaining === 0, `third use: ${JSON.stringify(c)}`);
  const d = await consumeQuota(free, CAP.ANALYTICS_CHARTS);
  assert(!d.allowed, 'the fourth use in a window is refused');
  assert(b.allowed, 'the second use was fine');
  assert(d.resetsAt, 'a refusal carries the reset time');
  console.log('  a quota allows exactly its limit inside one window');
}

{
  let err = null;
  try {
    await requireQuota(userOn('free', { id: 'quota-user-1' }), CAP.ANALYTICS_CHARTS);
  } catch (e) {
    err = e;
  }
  const body = err.toJSON();
  assert(body.error === 'upgrade_required', 'a spent quota is an upgrade prompt');
  assert(body.quota.limit === 3 && body.quota.used === 3, 'reports used and limit');
  assert(body.quota.resetsAt, 'and when it resets');
  assert(body.requiredTier === 'premium', 'unlimited charts start at Premium');
  console.log('  a spent quota produces a 402 carrying used, limit and reset time');
}

{
  // Two concurrent requests with one use left. Exactly one may pass.
  const user = userOn('free', { id: 'quota-race' });
  // demos.macro_viewer is 1 per 24h on free.
  const [first, second] = await Promise.all([
    consumeQuota(user, CAP.DEMOS_MACRO_VIEWER),
    consumeQuota(user, CAP.DEMOS_MACRO_VIEWER)
  ]);
  const passed = [first, second].filter((r) => r.allowed).length;
  assert(passed === 1, `exactly one of two concurrent uses may pass, ${passed} did`);
  console.log('  two concurrent uses at the limit let exactly one through');
}

{
  // Unlimited tiers must not write counter rows at all.
  const before = consumeCalls;
  const elite = userOn('team_elite', { id: 'quota-elite' });
  const r = await consumeQuota(elite, CAP.ANALYTICS_CHARTS);
  assert(r.allowed && r.limit === -1, 'unlimited always passes');
  assert(consumeCalls === before, 'and never touches the counter table');
  console.log('  an unlimited quota never reaches the database');
}

{
  // A capability the tier does not have at all is refused without a round trip.
  const before = consumeCalls;
  const free = userOn('free', { id: 'quota-zero' });
  const r = await consumeQuota(free, CAP.DEMOS_MAP_CONTROL);
  assert(!r.allowed && r.limit === 0, 'a zero quota is refused');
  assert(consumeCalls === before, 'without asking the database');
  console.log('  a capability absent from the tier is refused without a query');
}

{
  // Impersonation must never spend the quota the user paid for.
  const before = consumeCalls;
  const target = userOn('free', {
    id: 'quota-user-1',
    impersonating: { actorId: 'admin-1', targetId: 'quota-user-1', readOnly: true }
  });
  const r = await consumeQuota(target, CAP.ANALYTICS_CHARTS);
  assert(consumeCalls === before, 'impersonation did not call consume_quota');
  assert(r.used === 3, 'it read the real usage');
  console.log('  impersonation reads a quota without spending it');
}

// ---- opening a page must not spend a use ------------------------------------

{
  const before = consumeCalls;
  const free = userOn('free', { id: 'quota-peek' });
  const r = await requireCapability(free, CAP.ANALYTICS_CHARTS, { consume: false });
  assert(r.allowed, 'charts exist on free');
  assert(consumeCalls === before, 'checking availability spends nothing');

  let err = null;
  try {
    await requireCapability(free, CAP.DEMOS_MAP_CONTROL, { consume: false });
  } catch (e) {
    err = e;
  }
  assert(err?.status === 402, 'a capability absent from the tier still refuses');
  console.log('  checking availability does not consume a use');
}

stub.close();
console.log('enforce: all assertions passed');

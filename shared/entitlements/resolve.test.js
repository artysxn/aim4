// Run: node shared/entitlements/resolve.test.js
//
// resolve() is the only place tier questions are answered, so the cases below
// are the ones that decide whether a paying user is locked out or a free user
// is let in. Everything here is pure: no database, no clock, `now` is passed.

import {
  CAPABILITY_KEYS,
  UNLIMITED,
  capabilitiesForPlan,
  compareValues,
  isEnabled,
  requiredPlanFor
} from './catalogue.js';
import { CAP } from './keys.js';
import { resolveEntitlements } from './resolve.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const NOW = Date.parse('2026-08-02T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

/** A live subscription on `planId`, ending a month out unless told otherwise. */
function sub(planId, extra = {}) {
  return {
    id: `sub-${planId}`,
    plan_id: planId,
    status: 'active',
    term: 'month',
    current_period_end: iso(NOW + 30 * DAY),
    ...extra
  };
}

function seatOn(planId, extra = {}) {
  return {
    id: `seat-${planId}`,
    subscription_id: `sub-${planId}`,
    team_id: 'team-1',
    released_at: null,
    subscription: sub(planId),
    ...extra
  };
}

function grant(extra = {}) {
  return {
    id: 'grant-1',
    mode: 'upgrade',
    starts_at: iso(NOW - DAY),
    expires_at: null,
    revoked_at: null,
    created_at: iso(NOW - DAY),
    ...extra
  };
}

// ---- catalogue invariants ---------------------------------------------------

{
  // The whole design rests on rank order matching capability strength. If a
  // future plan breaks monotonicity the "never worse off holding both" promise
  // silently stops being true, so assert it rather than trust it.
  const order = ['free', 'premium', 'team_premium', 'team_elite'];
  for (const key of CAPABILITY_KEYS) {
    for (let i = 1; i < order.length; i++) {
      const lower = capabilitiesForPlan(order[i - 1])[key];
      const higher = capabilitiesForPlan(order[i])[key];
      assert(
        compareValues(key, higher, lower) >= 0,
        `${key}: ${order[i]} (${higher}) is weaker than ${order[i - 1]} (${lower})`
      );
    }
  }
  console.log('  capability values never decrease as plan rank rises');
}

{
  assert(compareValues(CAP.DEMOS_UPLOAD_LIMIT, UNLIMITED, 9999) > 0, 'unlimited beats any number');
  assert(compareValues(CAP.DEMOS_UPLOAD_LIMIT, 50, 3) > 0, 'bigger limit is stronger');
  assert(compareValues(CAP.AIM_REPLAYS, 'full', 'none') > 0, 'enum order applies');
  assert(!isEnabled(CAP.DEMOS_MAP_CONTROL, 0), 'a zero quota is not enabled');
  assert(isEnabled(CAP.DEMOS_MAP_CONTROL, UNLIMITED), 'an unlimited quota is enabled');
  assert(!isEnabled(CAP.AIM_REPLAYS, 'none'), 'the weakest enum value is not enabled');
  console.log('  value comparison handles unlimited, enums and zero quotas');
}

{
  assert(
    requiredPlanFor(CAP.STATS_METRICS_TEAM_FULL) === 'team_elite',
    'full team metrics are Elite only'
  );
  assert(
    requiredPlanFor(CAP.STATS_METRICS_PLAYER_FULL) === 'premium',
    'a 402 should name the cheapest plan that unlocks it, not the priciest'
  );
  console.log('  requiredPlanFor names the cheapest sufficient plan');
}

// ---- base case --------------------------------------------------------------

{
  const r = resolveEntitlements({ now: NOW });
  assert(r.tier === 'free', `no sources means free, got ${r.tier}`);
  assert(r.source === 'free', `source should be free, got ${r.source}`);
  assert(r.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === 3, 'free uploads 3');
  assert(r.capabilities[CAP.AIM_TRAINER] === true, 'the trainer itself is free');
  assert(r.capabilities[CAP.STATS_SINGLE_GAME] === false, 'single game stats are not free');
  assert(r.trial === null && r.isAdmin === false, 'no trial, not admin');
  console.log('  an account with nothing attached resolves to free');
}

// ---- own subscription -------------------------------------------------------

{
  const r = resolveEntitlements({ subscription: sub('premium'), now: NOW });
  assert(r.tier === 'premium' && r.source === 'subscription', `got ${r.tier}/${r.source}`);
  assert(r.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === 50, 'premium uploads 50');
  assert(r.expiresAt === iso(NOW + 30 * DAY), 'expiry comes from the period end');
  console.log('  an own subscription sets the tier and its expiry');
}

// ---- the FAQ #6 case: own Premium plus an Elite seat ------------------------

{
  const r = resolveEntitlements({
    subscription: sub('premium'),
    seat: seatOn('team_elite'),
    now: NOW
  });
  assert(r.tier === 'team_elite', `holding both should resolve to Elite, got ${r.tier}`);
  assert(r.source === 'seat', `Elite came from the seat, got ${r.source}`);
  assert(r.capabilities[CAP.DEMOS_TEAMSPEAK_SYNC] === true, 'Elite-only capability is present');
  assert(r.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === UNLIMITED, 'Elite uploads are unlimited');
  assert(r.seat?.planId === 'team_elite', 'the seat is reported for the account page');
  // The whole point of merging by rank: no capability is worse than Premium alone.
  const premiumOnly = resolveEntitlements({ subscription: sub('premium'), now: NOW });
  for (const key of CAPABILITY_KEYS) {
    assert(
      compareValues(key, r.capabilities[key], premiumOnly.capabilities[key]) >= 0,
      `${key} got worse by also holding a seat`
    );
  }
  console.log('  own Premium plus an Elite seat resolves to Elite, never worse off');
}

{
  // The reverse: a personal plan stronger than the seat still wins.
  const r = resolveEntitlements({
    subscription: sub('team_elite'),
    seat: seatOn('premium'),
    now: NOW
  });
  assert(r.tier === 'team_elite' && r.source === 'subscription', `got ${r.tier}/${r.source}`);
  console.log('  a stronger own plan outranks a weaker seat');
}

{
  // Seats on two plans: the better seat is the one that counts.
  const r = resolveEntitlements({
    seat: [seatOn('premium'), seatOn('team_premium')],
    now: NOW
  });
  assert(r.tier === 'team_premium', `best seat should win, got ${r.tier}`);
  console.log('  the strongest of several seats is the one that applies');
}

// ---- seats stop counting when released or when the lender lapses ------------

{
  const released = resolveEntitlements({
    seat: seatOn('team_elite', { released_at: iso(NOW - HOUR) }),
    now: NOW
  });
  assert(released.tier === 'free', `a released seat entitles nothing, got ${released.tier}`);

  const lapsed = resolveEntitlements({
    seat: seatOn('team_elite', {
      subscription: sub('team_elite', { status: 'cancelled' })
    }),
    now: NOW
  });
  assert(lapsed.tier === 'free', `a seat on a cancelled plan is worthless, got ${lapsed.tier}`);
  console.log('  released seats and seats on dead plans stop entitling');
}

// ---- past_due is not access -------------------------------------------------

{
  const r = resolveEntitlements({ subscription: sub('premium', { status: 'past_due' }), now: NOW });
  assert(r.tier === 'free', `past_due should not entitle, got ${r.tier}`);
  console.log('  a past_due subscription does not entitle');
}

// ---- expiry is evaluated at read, not by a sweep ----------------------------

{
  const r = resolveEntitlements({
    subscription: sub('premium', { current_period_end: iso(NOW - 1) }),
    now: NOW
  });
  assert(r.tier === 'free', `a lapsed period must not entitle, got ${r.tier}`);

  const stillLive = resolveEntitlements({
    subscription: sub('premium', { current_period_end: iso(NOW + 1) }),
    now: NOW
  });
  assert(stillLive.tier === 'premium', 'one millisecond before the end is still access');

  const forever = resolveEntitlements({
    subscription: sub('team_elite', { current_period_end: null }),
    now: NOW
  });
  assert(forever.tier === 'team_elite', 'a null period end never expires');
  assert(forever.expiresAt === null, 'and reports no expiry');
  console.log('  subscription expiry is time-aware at read, null means forever');
}

// ---- trials -----------------------------------------------------------------

{
  const trialing = sub('premium', {
    status: 'trialing',
    source: 'trial',
    trial_started_at: iso(NOW - 3 * DAY),
    trial_ends_at: iso(NOW + 4 * DAY),
    current_period_end: iso(NOW + 4 * DAY)
  });
  const r = resolveEntitlements({ subscription: trialing, now: NOW });
  assert(r.tier === 'premium', `a live trial grants its plan, got ${r.tier}`);
  assert(r.trial?.daysLeft === 4, `expected 4 days left, got ${r.trial?.daysLeft}`);
  assert(r.trial?.cancelAtPeriodEnd === false, 'not cancelled');

  const expired = resolveEntitlements({
    subscription: { ...trialing, trial_ends_at: iso(NOW - 1), current_period_end: iso(NOW - 1) },
    now: NOW
  });
  assert(expired.tier === 'free', `an ended trial drops to free, got ${expired.tier}`);
  console.log('  a live trial entitles, an ended one drops to free without a sweep');
}

{
  // Cancelling keeps access until the end date. Revoking at the moment of
  // cancellation is the antipattern this asserts against.
  const r = resolveEntitlements({
    subscription: sub('premium', {
      status: 'trialing',
      trial_ends_at: iso(NOW + 2 * DAY),
      current_period_end: iso(NOW + 2 * DAY),
      cancel_at_period_end: true
    }),
    now: NOW
  });
  assert(r.tier === 'premium', 'a cancelled trial keeps access until it ends');
  assert(r.trial?.cancelAtPeriodEnd === true, 'and reports that it is cancelled');
  console.log('  a cancelled trial keeps access until the end date');
}

// ---- grants -----------------------------------------------------------------

{
  const r = resolveEntitlements({
    subscription: sub('team_elite'),
    grants: [grant({ plan_id: 'free', mode: 'upgrade' })],
    now: NOW
  });
  assert(r.tier === 'team_elite', `an upgrade grant below the current tier is ignored`);
  console.log('  a mode:upgrade grant below the current tier is ignored');
}

{
  const r = resolveEntitlements({
    subscription: sub('team_elite'),
    grants: [grant({ plan_id: 'free', mode: 'override' })],
    now: NOW
  });
  assert(r.tier === 'free', `an override grant below the current tier applies, got ${r.tier}`);
  assert(r.source === 'grant', `source should be grant, got ${r.source}`);
  assert(r.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === 3, 'and it really does downgrade capabilities');
  console.log('  a mode:override grant below the current tier applies');
}

{
  const r = resolveEntitlements({
    grants: [grant({ plan_id: 'team_elite', mode: 'upgrade' })],
    now: NOW
  });
  assert(r.tier === 'team_elite' && r.source === 'grant', `got ${r.tier}/${r.source}`);
  assert(r.appliedGrants.includes('grant-1'), 'the applied grant is reported');
  console.log('  a plan grant lifts a free account');
}

{
  // Single-capability grants, both directions.
  const up = resolveEntitlements({
    grants: [grant({ capability: CAP.DEMOS_UPLOAD_LIMIT, value: 25 })],
    now: NOW
  });
  assert(up.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === 25, 'capability grant raises the cap');
  assert(up.tier === 'free', 'without a plan_id the tier is unchanged');

  const ignored = resolveEntitlements({
    subscription: sub('premium'),
    grants: [grant({ capability: CAP.DEMOS_UPLOAD_LIMIT, value: 1, mode: 'upgrade' })],
    now: NOW
  });
  assert(ignored.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === 50, 'a weaker upgrade grant is ignored');

  const forced = resolveEntitlements({
    subscription: sub('premium'),
    grants: [grant({ capability: CAP.DEMOS_UPLOAD_LIMIT, value: 1, mode: 'override' })],
    now: NOW
  });
  assert(forced.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === 1, 'an override grant forces it down');
  console.log('  capability grants respect upgrade and override modes');
}

{
  const expired = resolveEntitlements({
    grants: [grant({ plan_id: 'team_elite', expires_at: iso(NOW - 1) })],
    now: NOW
  });
  assert(expired.tier === 'free', 'an expired grant stops applying with no sweep run');

  const notYet = resolveEntitlements({
    grants: [grant({ plan_id: 'team_elite', starts_at: iso(NOW + HOUR) })],
    now: NOW
  });
  assert(notYet.tier === 'free', 'a future grant does not apply yet');

  const revoked = resolveEntitlements({
    grants: [grant({ plan_id: 'team_elite', revoked_at: iso(NOW - HOUR) })],
    now: NOW
  });
  assert(revoked.tier === 'free', 'a revoked grant does not apply');
  console.log('  grants are time-aware at read and revocation is immediate');
}

{
  // Two plan grants: the later one wins on a tie, and neither loses to the other
  // by accident of object key order.
  const r = resolveEntitlements({
    grants: [
      grant({ id: 'a', plan_id: 'premium', created_at: iso(NOW - 2 * DAY) }),
      grant({ id: 'b', plan_id: 'team_elite', created_at: iso(NOW - DAY) })
    ],
    now: NOW
  });
  assert(r.tier === 'team_elite', `the stronger grant wins, got ${r.tier}`);
  console.log('  several grants merge by rank');
}

// ---- admin ------------------------------------------------------------------

{
  const r = resolveEntitlements({ isAdmin: true, now: NOW });
  assert(r.isAdmin === true && r.source === 'admin', `got ${r.source}`);
  assert(r.tier === 'free', 'admin is not a tier: the underlying tier is still reported');
  for (const key of CAPABILITY_KEYS) {
    assert(isEnabled(key, r.capabilities[key]), `admin should have ${key}`);
  }
  assert(r.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === UNLIMITED, 'admin uploads are unlimited');
  assert(r.capabilities[CAP.AIM_REPLAYS] === 'full', 'admin gets the strongest enum value');
  console.log('  an admin gets every capability at full strength, without a tier');
}

console.log('resolve: all assertions passed');

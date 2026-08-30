// Run: node shared/entitlements/resolve.test.js
//
// resolve() is the only place tier questions are answered, so the cases below
// are the ones that decide whether a paying user is locked out or a free user
// is let in. Everything here is pure: no database, no clock, `now` is passed.

import {
  CAPABILITY_KEYS,
  PLAN_IDS,
  SHARED_QUOTA_KEYS,
  UNLIMITED,
  capabilitiesForPlan,
  compareValues,
  isEnabled,
  requiredPlanFor
} from './catalogue.js';
import { CAP } from './keys.js';
import { quotaSubject, resolveEntitlements } from './resolve.js';

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
  // Rank and price walk the same array, but capability strength does not:
  // Solo Elite is unlimited on the models that Team Tier 3 meters, and Tier 3
  // has the whole team toolkit that no solo plan has. The check that still
  // holds for every key is "never weaker than Free", plus the per-ladder
  // monotonicity the catalogue already self-checks on import.
  for (const key of CAPABILITY_KEYS) {
    const freeVal = capabilitiesForPlan('free')[key];
    for (const planId of PLAN_IDS) {
      assert(
        compareValues(key, capabilitiesForPlan(planId)[key], freeVal) >= 0,
        `${key}: ${planId} is weaker than free`
      );
    }
  }
  console.log('  no plan is weaker than free on any capability');
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
    requiredPlanFor(CAP.STATS_METRICS_PLAYER_FULL) === 'solo_lite',
    'a 402 should name the cheapest plan that unlocks it, not the priciest'
  );
  assert(
    requiredPlanFor(CAP.STATS_METRICS_TEAM_FULL) === 'solo_premium',
    'full team metrics start at the middle band'
  );
  assert(
    requiredPlanFor(CAP.AIM_REPLAYS, 'full') === 'solo_elite',
    'full aim replays start at the high solo band, not at Team Tier 1'
  );
  assert(
    requiredPlanFor(CAP.TEAM_CREATE_LIMIT) === 'team_tier3',
    'creating a team is the thing that names the team ladder'
  );
  assert(
    requiredPlanFor(CAP.ANALYTICS_ANTISTRAT) === 'team_tier3',
    'anti-strat is the same door'
  );
  assert(
    SHARED_QUOTA_KEYS.includes(CAP.ANALYTICS_ANTISTRAT) &&
      SHARED_QUOTA_KEYS.includes(CAP.DEMOS_MAP_CONTROL),
    'the expensive tools are the shared ones'
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
  const r = resolveEntitlements({ subscription: sub('solo_premium'), now: NOW });
  assert(r.tier === 'solo_premium' && r.source === 'subscription', `got ${r.tier}/${r.source}`);
  // Derived, not hardcoded: the exact figure is pricing, and pricing moves.
  // What this test owns is that the plan's own catalogue value comes through.
  const premiumLimit = capabilitiesForPlan('solo_premium')[CAP.DEMOS_UPLOAD_LIMIT];
  assert(r.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === premiumLimit, 'solo premium uploads its catalogue limit');
  assert(premiumLimit > 3, 'and that limit is worth more than free');
  assert(r.expiresAt === iso(NOW + 30 * DAY), 'expiry comes from the period end');
  console.log('  an own subscription sets the tier and its expiry');
}

// ---- holding both ladders: own Solo Premium plus a Team Tier 1 seat ---------

{
  const r = resolveEntitlements({
    subscription: sub('solo_premium'),
    seat: seatOn('team_tier1'),
    now: NOW
  });
  assert(r.tier === 'team_tier1', `holding both should resolve to Tier 1, got ${r.tier}`);
  assert(r.source === 'seat', `Tier 1 came from the seat, got ${r.source}`);
  assert(r.capabilities[CAP.DEMOS_TEAMSPEAK_SYNC] === true, 'team-only capability is present');
  assert(r.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === UNLIMITED, 'Tier 1 uploads are unlimited');
  assert(r.seat?.planId === 'team_tier1', 'the seat is reported for the account page');
  const soloOnly = resolveEntitlements({ subscription: sub('solo_premium'), now: NOW });
  for (const key of CAPABILITY_KEYS) {
    assert(
      compareValues(key, r.capabilities[key], soloOnly.capabilities[key]) >= 0,
      `${key} got worse by also holding a seat`
    );
  }
  console.log('  own Solo Premium plus a Tier 1 seat resolves to Tier 1, never worse off');
}

{
  // The load-bearing 3-3 case: Solo Elite is stronger than Team Tier 3 on the
  // models, weaker on the team toolkit, and lower ranked. Merging by rank
  // wholesale would silently meter an Elite subscriber at one map-control a
  // day the moment they sat on a Tier 3 roster.
  const r = resolveEntitlements({
    subscription: sub('solo_elite'),
    seat: seatOn('team_tier3'),
    now: NOW
  });
  assert(r.tier === 'team_tier3', `displayed tier follows rank, got ${r.tier}`);
  assert(r.source === 'seat', `Tier 3 outranks Solo Elite, got ${r.source}`);
  assert(r.capabilities[CAP.DEMOS_MAP_CONTROL] === UNLIMITED, 'Elite model runs survive the seat');
  assert(r.capabilities[CAP.ANALYTICS_ANTISTRAT] === 1, 'the seat still grants anti-strat');
  assert(r.capabilities[CAP.TEAM_STRATBOOK_ACCESS] === true, 'and the rest of the team toolkit');
  assert(
    r.quotaSubjects[CAP.DEMOS_MAP_CONTROL] === 'sub-solo_elite',
    'unlimited model runs still belong to the Elite subscription'
  );
  assert(
    r.quotaSubjects[CAP.ANALYTICS_ANTISTRAT] === 'sub-team_tier3',
    'anti-strat is metered against the team subscription'
  );
  assert(
    quotaSubject(r, CAP.DEMOS_MAP_CONTROL, 'user-1') === 'sub-solo_elite',
    'quotaSubject follows the subscription that granted the value'
  );
  assert(
    quotaSubject(r, CAP.ANALYTICS_CHARTS, 'user-1') === 'user-1',
    'a personal quota still charges the account'
  );

  const eliteOnly = resolveEntitlements({ subscription: sub('solo_elite'), now: NOW });
  const seatOnly = resolveEntitlements({ seat: seatOn('team_tier3'), now: NOW });
  for (const key of CAPABILITY_KEYS) {
    assert(
      compareValues(key, r.capabilities[key], eliteOnly.capabilities[key]) >= 0,
      `${key} got worse than Solo Elite alone`
    );
    assert(
      compareValues(key, r.capabilities[key], seatOnly.capabilities[key]) >= 0,
      `${key} got worse than the Tier 3 seat alone`
    );
  }
  console.log('  Solo Elite plus a Tier 3 seat keeps both toolkits, never worse off');
}

{
  // The reverse: a personal plan stronger than the seat still wins the name.
  const r = resolveEntitlements({
    subscription: sub('team_tier1'),
    seat: seatOn('team_tier3'),
    now: NOW
  });
  assert(r.tier === 'team_tier1' && r.source === 'subscription', `got ${r.tier}/${r.source}`);
  console.log('  a stronger own plan outranks a weaker seat');
}

{
  // Seats on two plans: the better seat is the one that counts.
  const r = resolveEntitlements({
    seat: [seatOn('solo_lite'), seatOn('team_tier3')],
    now: NOW
  });
  assert(r.tier === 'team_tier3', `best seat should win, got ${r.tier}`);
  console.log('  the strongest of several seats is the one that applies');
}

// ---- seats stop counting when released or when the lender lapses ------------

{
  const released = resolveEntitlements({
    seat: seatOn('team_tier1', { released_at: iso(NOW - HOUR) }),
    now: NOW
  });
  assert(released.tier === 'free', `a released seat entitles nothing, got ${released.tier}`);

  const lapsed = resolveEntitlements({
    seat: seatOn('team_tier1', {
      subscription: sub('team_tier1', { status: 'cancelled' })
    }),
    now: NOW
  });
  assert(lapsed.tier === 'free', `a seat on a cancelled plan is worthless, got ${lapsed.tier}`);
  console.log('  released seats and seats on dead plans stop entitling');
}

// ---- past_due is not access -------------------------------------------------

{
  const r = resolveEntitlements({ subscription: sub('solo_premium', { status: 'past_due' }), now: NOW });
  assert(r.tier === 'free', `past_due should not entitle, got ${r.tier}`);
  console.log('  a past_due subscription does not entitle');
}

// ---- expiry is evaluated at read, not by a sweep ----------------------------

{
  const r = resolveEntitlements({
    subscription: sub('solo_premium', { current_period_end: iso(NOW - 1) }),
    now: NOW
  });
  assert(r.tier === 'free', `a lapsed period must not entitle, got ${r.tier}`);

  const stillLive = resolveEntitlements({
    subscription: sub('solo_premium', { current_period_end: iso(NOW + 1) }),
    now: NOW
  });
  assert(stillLive.tier === 'solo_premium', 'one millisecond before the end is still access');

  const forever = resolveEntitlements({
    subscription: sub('team_tier1', { current_period_end: null }),
    now: NOW
  });
  assert(forever.tier === 'team_tier1', 'a null period end never expires');
  assert(forever.expiresAt === null, 'and reports no expiry');
  console.log('  subscription expiry is time-aware at read, null means forever');
}

// ---- trials -----------------------------------------------------------------

{
  const trialing = sub('solo_premium', {
    status: 'trialing',
    source: 'trial',
    trial_started_at: iso(NOW - 3 * DAY),
    trial_ends_at: iso(NOW + 4 * DAY),
    current_period_end: iso(NOW + 4 * DAY)
  });
  const r = resolveEntitlements({ subscription: trialing, now: NOW });
  assert(r.tier === 'solo_premium', `a live trial grants its plan, got ${r.tier}`);
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
    subscription: sub('solo_premium', {
      status: 'trialing',
      trial_ends_at: iso(NOW + 2 * DAY),
      current_period_end: iso(NOW + 2 * DAY),
      cancel_at_period_end: true
    }),
    now: NOW
  });
  assert(r.tier === 'solo_premium', 'a cancelled trial keeps access until it ends');
  assert(r.trial?.cancelAtPeriodEnd === true, 'and reports that it is cancelled');
  console.log('  a cancelled trial keeps access until the end date');
}

// ---- grants -----------------------------------------------------------------

{
  const r = resolveEntitlements({
    subscription: sub('team_tier1'),
    grants: [grant({ plan_id: 'free', mode: 'upgrade' })],
    now: NOW
  });
  assert(r.tier === 'team_tier1', `an upgrade grant below the current tier is ignored`);
  console.log('  a mode:upgrade grant below the current tier is ignored');
}

{
  const r = resolveEntitlements({
    subscription: sub('team_tier1'),
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
    grants: [grant({ plan_id: 'team_tier1', mode: 'upgrade' })],
    now: NOW
  });
  assert(r.tier === 'team_tier1' && r.source === 'grant', `got ${r.tier}/${r.source}`);
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
    subscription: sub('solo_premium'),
    grants: [grant({ capability: CAP.DEMOS_UPLOAD_LIMIT, value: 1, mode: 'upgrade' })],
    now: NOW
  });
  assert(
    ignored.capabilities[CAP.DEMOS_UPLOAD_LIMIT] ===
      capabilitiesForPlan('solo_premium')[CAP.DEMOS_UPLOAD_LIMIT],
    'a weaker upgrade grant is ignored'
  );

  const forced = resolveEntitlements({
    subscription: sub('solo_premium'),
    grants: [grant({ capability: CAP.DEMOS_UPLOAD_LIMIT, value: 1, mode: 'override' })],
    now: NOW
  });
  assert(forced.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === 1, 'an override grant forces it down');
  console.log('  capability grants respect upgrade and override modes');
}

{
  const expired = resolveEntitlements({
    grants: [grant({ plan_id: 'team_tier1', expires_at: iso(NOW - 1) })],
    now: NOW
  });
  assert(expired.tier === 'free', 'an expired grant stops applying with no sweep run');

  const notYet = resolveEntitlements({
    grants: [grant({ plan_id: 'team_tier1', starts_at: iso(NOW + HOUR) })],
    now: NOW
  });
  assert(notYet.tier === 'free', 'a future grant does not apply yet');

  const revoked = resolveEntitlements({
    grants: [grant({ plan_id: 'team_tier1', revoked_at: iso(NOW - HOUR) })],
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
      grant({ id: 'a', plan_id: 'solo_premium', created_at: iso(NOW - 2 * DAY) }),
      grant({ id: 'b', plan_id: 'team_tier1', created_at: iso(NOW - DAY) })
    ],
    now: NOW
  });
  assert(r.tier === 'team_tier1', `the stronger grant wins, got ${r.tier}`);
  console.log('  several grants merge by rank');
}

// ---- probation ----------------------------------------------------------------

{
  // Sharing probation forces Free over everything a user can hold themselves:
  // subscription, seat and grant together must not leave a way around it.
  const r = resolveEntitlements({
    subscription: sub('solo_elite'),
    seat: seatOn('team_tier1'),
    grants: [grant({ plan_id: 'team_tier1', mode: 'upgrade' })],
    probation: true,
    now: NOW
  });
  assert(r.tier === 'free', `probation must serve free, got ${r.tier}`);
  assert(r.source === 'probation', `source should say why, got ${r.source}`);
  assert(r.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === 3, 'capabilities really are free-tier');
  assert(r.expiresAt === null, 'probation has no expiry: an admin lifts it');

  const clean = resolveEntitlements({ subscription: sub('solo_elite'), now: NOW });
  assert(clean.tier === 'solo_elite', 'without probation the same inputs entitle normally');

  // Admin still wins: a flagged site admin must keep the panel that lifts flags.
  const admin = resolveEntitlements({ isAdmin: true, probation: true, now: NOW });
  assert(admin.source === 'admin', `admin outranks probation, got ${admin.source}`);
  assert(admin.capabilities[CAP.DEMOS_UPLOAD_LIMIT] === UNLIMITED, 'admin capabilities survive');
  console.log('  probation forces free past plan, seat and grant; admin still wins');
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

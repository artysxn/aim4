// ---------------------------------------------------------------------------
// server/entitlements/seats.test.js
//   node --test server/entitlements/seats.test.js
//
// What a seat is worth. A seat holder pays nothing and owns nothing, but should
// see exactly what the person paying sees, and the daily allowances they share
// should be charged to the plan that lent the seat rather than to them.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveEntitlements } from '../../shared/entitlements/resolve.js';
import { CAP } from '../../shared/entitlements/keys.js';

const DAY = 24 * 60 * 60 * 1000;

function lender(planId, { status = 'active', endsInDays = 30 } = {}) {
  return {
    id: `sub-${planId}`,
    plan_id: planId,
    status,
    current_period_end: new Date(Date.now() + endsInDays * DAY).toISOString()
  };
}

const seatOn = (sub, teamId = 'team-1') => [
  { subscription_id: sub.id, team_id: teamId, released_at: null, subscription: sub }
];

test('a seat gives exactly what the plan owner has', () => {
  const sub = lender('team_tier1');
  const owner = resolveEntitlements({ subscription: sub, seat: [], grants: [] });
  const holder = resolveEntitlements({ subscription: null, seat: seatOn(sub), grants: [] });

  assert.deepEqual(holder.capabilities, owner.capabilities, 'a seat is not a lesser plan');
  assert.equal(holder.tier, 'team_tier1');
  assert.equal(holder.source, 'seat', 'but the page must be able to tell them apart');
  assert.equal(owner.source, 'subscription');
});

test('shared allowances are charged to the lending subscription', () => {
  // Seven people on one Tier 3 get one anti-strat a day between them, not seven.
  const sub = lender('team_tier3');
  const holder = resolveEntitlements({ subscription: null, seat: seatOn(sub), grants: [] });
  assert.equal(holder.quotaSubjects[CAP.ANALYTICS_ANTISTRAT], sub.id);
});

test('the seat names the team and plan it came from, for the account page', () => {
  const sub = lender('team_tier2');
  const holder = resolveEntitlements({ subscription: null, seat: seatOn(sub, 'team-42'), grants: [] });
  assert.deepEqual(holder.seat, {
    subscriptionId: 'sub-team_tier2',
    teamId: 'team-42',
    planId: 'team_tier2'
  });
  assert.equal(holder.expiresAt, sub.current_period_end, 'it ends when the lender lapses');
});

test('a released seat entitles to nothing', () => {
  const sub = lender('team_tier1');
  const released = [{ ...seatOn(sub)[0], released_at: new Date().toISOString() }];
  const after = resolveEntitlements({ subscription: null, seat: released, grants: [] });
  assert.equal(after.tier, 'free');
  assert.equal(after.source, 'free');
});

test('a seat dies with the subscription that lent it', () => {
  const dead = lender('team_tier1', { status: 'cancelled' });
  const holder = resolveEntitlements({ subscription: null, seat: seatOn(dead), grants: [] });
  assert.equal(holder.tier, 'free', 'the owner cancelling takes the seat with it');
});

test('their own better plan wins, and is what the page names', () => {
  const seat = lender('team_tier3');
  const own = { id: 'sub-own', plan_id: 'solo_elite', status: 'active', current_period_end: null };
  const both = resolveEntitlements({ subscription: own, seat: seatOn(seat), grants: [] });

  // team_tier3 outranks solo_elite, so the tier is the seat's...
  assert.equal(both.tier, 'team_tier3');
  assert.equal(both.source, 'seat');
  // ...but merging keeps the STRONGER value per capability, so the Solo Elite
  // unlimited model runs survive being on a Tier 3 seat.
  assert.equal(both.capabilities[CAP.DEMOS_MAP_CONTROL], -1);
});

test('the best seat wins when someone sits on two teams', () => {
  const small = lender('team_tier3');
  const big = lender('team_tier1');
  const holder = resolveEntitlements({
    subscription: null,
    seat: [...seatOn(small, 'a'), ...seatOn(big, 'b')],
    grants: []
  });
  assert.equal(holder.tier, 'team_tier1');
  assert.equal(holder.seat.teamId, 'b');
});

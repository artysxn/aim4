-- ===========================================================================
-- 0011_tier_rework.sql
-- Four plans become seven, and the billing terms grow a six-month option.
--
-- The old ladder was free / premium / team_premium / team_elite. The new one is
-- two parallel ladders over four bands:
--
--   free
--   solo_lite     team_tier3    (low)
--   solo_premium  team_tier2    (middle)
--   solo_elite    team_tier1    (high)
--
-- Capabilities are NOT written here. shared/entitlements/catalogue.js is
-- canonical and 0003_seed_plans.sql (generated from it) carries them, which is
-- also what a deploy pushes. This file only does the things a generated seed
-- cannot: it adds columns, widens constraints, and moves existing rows off plan
-- ids that are about to stop existing.
--
-- Safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The six-month term.
--
-- Two changes: a price column on plans, and room in the subscriptions check
-- constraint. Dropping and recreating the constraint is the only way to widen
-- it; the drop is guarded so a partially-applied run does not fail here.
-- ---------------------------------------------------------------------------
alter table public.plans add column if not exists price_halfyear_cents int;

alter table public.subscriptions drop constraint if exists subscriptions_term_check;
alter table public.subscriptions add constraint subscriptions_term_check
  check (term in ('month', 'quarter', 'halfyear', 'year', 'lifetime'));

-- ---------------------------------------------------------------------------
-- 2. Quota subjects.
--
-- A quota used to belong to a person. The expensive capabilities now belong to
-- the SUBSCRIPTION: a Tier 3 team gets one anti-strat a day between all seven
-- seats, not one each. The server therefore passes a subscription id into
-- consume_quota for those capabilities, and the foreign key to auth.users is
-- what stops it.
--
-- The column keeps its name so consume_quota / peek_quota keep their
-- signatures and the "read own counters" policy keeps working for the personal
-- counters it was written for. A row keyed by a subscription id simply matches
-- no auth.uid(), which is the correct answer for a shared counter.
--
-- Losing the cascade means counter rows outlive a deleted account. They are
-- swept 48h after their window closes (sweep_usage_counters), so the leak is
-- bounded by two days rather than being permanent.
-- ---------------------------------------------------------------------------
alter table public.usage_counters drop constraint if exists usage_counters_user_id_fkey;

comment on column public.usage_counters.user_id is
  'Quota subject. An auth.users id for personal quotas, or a public.subscriptions id for quotas shared across every seat on one subscription. Deliberately not a foreign key: it references two tables.';

-- ---------------------------------------------------------------------------
-- 3. The new plan rows.
--
-- Minimal rows, inserted before anything is repointed at them so the foreign
-- key from subscriptions holds at every moment. 0003_seed_plans.sql fills in
-- capabilities and prices; if it has already run, `do nothing` leaves its work
-- alone.
-- ---------------------------------------------------------------------------
insert into public.plans (id, name, rank, seat_capacity, team_capacity)
values
  ('free',         'Free',         0,  0, 0),
  ('solo_lite',    'Solo Lite',    10, 0, 0),
  ('solo_premium', 'Solo Premium', 20, 0, 0),
  ('solo_elite',   'Solo Elite',   30, 0, 0),
  ('team_tier3',   'Team Tier 3',  40, 7,  1),
  ('team_tier2',   'Team Tier 2',  50, 14, 2),
  ('team_tier1',   'Team Tier 1',  60, 20, 3)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Move everything off the old ids.
--
-- Mapped by what the plan could do, not by what it cost:
--
--   premium       -> solo_premium  the solo plan, one band up in the new shape
--   team_premium  -> team_tier3    1 team, 7 seats, the entry team plan
--   team_elite    -> team_tier1    everything unlimited, the top team plan
--
-- Order matters. This has to happen before the old rows are deleted, and
-- before anything recomputes entitlements: resolve.js drops a plan id it does
-- not recognise and silently resolves the account to Free, so an unmigrated
-- subscription row is a silent downgrade rather than an error.
-- ---------------------------------------------------------------------------
update public.subscriptions set plan_id = 'solo_premium' where plan_id = 'premium';
update public.subscriptions set plan_id = 'team_tier3'   where plan_id = 'team_premium';
update public.subscriptions set plan_id = 'team_tier1'   where plan_id = 'team_elite';

update public.entitlement_grants set plan_id = 'solo_premium' where plan_id = 'premium';
update public.entitlement_grants set plan_id = 'team_tier3'   where plan_id = 'team_premium';
update public.entitlement_grants set plan_id = 'team_tier1'   where plan_id = 'team_elite';

-- profiles.effective_tier is a denormalised copy that recomputeUser() rewrites.
-- Moving it here as well means the admin user list and any SQL reporting are
-- correct immediately rather than only after every account has been recomputed.
update public.profiles set effective_tier = 'solo_premium' where effective_tier = 'premium';
update public.profiles set effective_tier = 'team_tier3'   where effective_tier = 'team_premium';
update public.profiles set effective_tier = 'team_tier1'   where effective_tier = 'team_elite';

-- ---------------------------------------------------------------------------
-- 5. Retire the old rows.
--
-- Guarded rather than unconditional: if anything anywhere still points at one
-- of these, the delete is skipped and the row survives as a read-only relic
-- instead of the migration failing on a foreign key at 3am. `is_public = false`
-- keeps it off the pricing page either way.
-- ---------------------------------------------------------------------------
update public.plans set is_public = false
 where id in ('premium', 'team_premium', 'team_elite');

delete from public.plans p
 where p.id in ('premium', 'team_premium', 'team_elite')
   and not exists (select 1 from public.subscriptions s where s.plan_id = p.id)
   and not exists (select 1 from public.entitlement_grants g where g.plan_id = p.id);

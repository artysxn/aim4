-- ===========================================================================
-- 0015_redemption_codes.sql
-- Trial codes: a string someone types to get a plan for a while, free.
--
-- Only TRIAL codes live here. A promo code is a discount on a payment, which
-- means it only exists at checkout, which means Paddle owns it: Paddle applies
-- it, counts its redemptions, and enforces its limits. Storing a second copy
-- would be a second source of truth for money.
--
-- A redeemed trial code creates an entitlement_grants row. That table is
-- already time-aware at read (resolve.js grantIsActive), already swept, already
-- audited, and already merges with a paid subscription by taking the stronger
-- of the two. A trial code is therefore a way of writing a grant, not a new
-- kind of access, which is why there is no plan resolution logic here.
-- ===========================================================================

create table if not exists public.redemption_codes (
  id             uuid primary key default gen_random_uuid(),
  -- Stored uppercase and compared uppercase; humans retype these from Discord
  -- messages and stream overlays, and case is not a meaningful difference.
  code           text not null,
  plan_id        text not null references public.plans(id),
  -- How long the grant lasts once redeemed, counted from the redemption, not
  -- from when the code was made. A code minted in January and redeemed in March
  -- gives the same run as one redeemed the day it was created.
  duration_days  int  not null,
  -- null = unlimited. 1 makes a single-use code, which is the common case for
  -- codes handed to one person.
  max_redemptions int,
  times_redeemed int  not null default 0,
  -- When the CODE stops being redeemable. Unrelated to how long the grant it
  -- creates lasts.
  expires_at     timestamptz,
  -- Free-text label shared by everything generated in one go, so a batch can be
  -- found, counted and archived together.
  batch          text,
  note           text,
  created_by     uuid not null references auth.users(id),
  created_at     timestamptz not null default now(),
  -- Archived codes are refused but kept: the redemptions below reference them
  -- and the audit trail should not develop holes.
  archived_at    timestamptz,
  constraint redemption_codes_duration_check check (duration_days > 0 and duration_days <= 3650),
  constraint redemption_codes_max_check check (max_redemptions is null or max_redemptions > 0)
);

-- Case-insensitive uniqueness. Two codes differing only in case would be one
-- code to every human who types it.
create unique index if not exists redemption_codes_code_key
  on public.redemption_codes (upper(code));

create index if not exists redemption_codes_batch_idx
  on public.redemption_codes (batch) where archived_at is null;

-- ---------------------------------------------------------------------------
-- One row per redemption. Exists to stop the same account redeeming a code
-- twice, and to answer "who used this batch" without reading the audit log.
-- ---------------------------------------------------------------------------
create table if not exists public.code_redemptions (
  id          uuid primary key default gen_random_uuid(),
  code_id     uuid not null references public.redemption_codes(id),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- The grant this redemption produced, so revoking the access and finding the
  -- redemption that caused it are the same lookup.
  grant_id    uuid references public.entitlement_grants(id),
  redeemed_at timestamptz not null default now()
);

-- The real guard against double redemption. Checking times_redeemed in
-- application code loses a race between two tabs; this cannot.
create unique index if not exists code_redemptions_once_per_user
  on public.code_redemptions (code_id, user_id);

create index if not exists code_redemptions_user_idx
  on public.code_redemptions (user_id);

comment on table public.redemption_codes is
  'Trial codes. Redeeming one writes an entitlement_grants row. Promo codes '
  'are Paddle discounts and are not stored here.';

-- Written only by the backend with the service role; nothing in the browser
-- has any reason to read the code list.
alter table public.redemption_codes enable row level security;
alter table public.code_redemptions enable row level security;

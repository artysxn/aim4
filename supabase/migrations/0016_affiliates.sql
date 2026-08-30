-- ===========================================================================
-- 0016_affiliates.sql
-- Affiliate codes: a share link, and a share of what it sells.
--
-- Paddle Billing has no affiliate concept, so all four tables here are ours.
-- What Paddle does give us is the two things that make attribution survivable:
-- custom_data on a server-created transaction, which it echoes onto the
-- subscription (so renewals stay attributed), and details.totals.earnings on
-- transaction.completed, which is the money that actually reached us.
--
-- COMMISSION IS PAID ON `earnings`, NOT ON WHAT THE CUSTOMER PAID.
-- Those differ by a lot. On Paddle's own example, a 65215 charge is 59900
-- subtotal + 5315 tax, and after Paddle's 3311 fee the earnings are 56589.
-- The tax was never ours (Paddle remits it as merchant of record) and the fee
-- was never ours either. A percentage of the gross would pay affiliates out of
-- money the business does not have, and the gap widens with every tax
-- jurisdiction. See server/affiliates/commissions.js.
--
-- Nothing here moves money. The commission rows are a ledger an admin reads
-- and settles by hand: Paddle cannot pay a third party on our behalf, so a
-- payout is a bank transfer someone makes and then records below.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- One row per user who has a code.
-- ---------------------------------------------------------------------------
create table if not exists public.affiliates (
  id             uuid primary key default gen_random_uuid(),
  -- One code per account. A second code for the same person would split their
  -- own earnings across two ledgers for no benefit to anyone.
  user_id        uuid not null unique references auth.users(id) on delete cascade,
  -- Vanity, uppercase, chosen by the affiliate. People put these in video
  -- descriptions and read them aloud, so they are not random like trial codes.
  code           text not null,
  -- Percent of earnings. Numeric rather than int so 12.5 is expressible.
  commission_pct numeric(5,2) not null default 20,
  -- Does the affiliate keep earning when the customer renews, or only on the
  -- first payment? Recurring is the norm for subscription referrals and is the
  -- default; per-affiliate so a one-off campaign deal can differ.
  recurring      boolean not null default true,
  -- Stop paying after this many months of one customer's life. null = forever.
  -- Only meaningful when `recurring`.
  max_months     int,
  -- active | suspended. Suspended keeps the row and the history but earns
  -- nothing further, which is what fraud needs: reversible, and auditable.
  status         text not null default 'active',
  -- Optional Paddle discount given to the BUYER when this code is used, so a
  -- code is worth typing. Paddle owns the discount itself (see
  -- server/billing/promoCodes.js); this is only the reference.
  paddle_discount_id text,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  suspended_at   timestamptz,
  suspended_reason text,
  constraint affiliates_pct_check check (commission_pct >= 0 and commission_pct <= 100),
  constraint affiliates_status_check check (status in ('active', 'suspended')),
  constraint affiliates_max_months_check check (max_months is null or max_months > 0),
  -- Long enough to be a name, short enough to say out loud.
  constraint affiliates_code_shape check (code ~ '^[A-Z0-9][A-Z0-9_-]{2,23}$')
);

-- Case-insensitive uniqueness, same reasoning as redemption_codes: two codes
-- differing only in case are one code to everyone who types one.
create unique index if not exists affiliates_code_key
  on public.affiliates (upper(code));

-- ---------------------------------------------------------------------------
-- Who was referred by whom. One row per referred customer, FIRST TOUCH WINS.
--
-- The unique constraint on user_id is the whole policy: whoever's code was
-- attached to an account first keeps it. Last-touch would mean an affiliate
-- could take someone else's customer by getting a link in front of them the
-- day they happen to upgrade, and the customer's own later visits with a
-- different code would silently move the commission.
-- ---------------------------------------------------------------------------
create table if not exists public.affiliate_referrals (
  id            uuid primary key default gen_random_uuid(),
  affiliate_id  uuid not null references public.affiliates(id) on delete cascade,
  -- The referred customer.
  user_id       uuid not null unique references auth.users(id) on delete cascade,
  -- The code as it was actually used, kept even though the affiliate is
  -- referenced: it is what the customer typed or clicked, and it is the thing
  -- a support conversation will be about.
  code          text not null,
  attributed_at timestamptz not null default now(),
  -- Which checkout carried it, when there was one.
  first_transaction_id text
);

create index if not exists affiliate_referrals_affiliate_idx
  on public.affiliate_referrals (affiliate_id);

-- ---------------------------------------------------------------------------
-- The ledger. One row per commissionable payment.
-- ---------------------------------------------------------------------------
create table if not exists public.affiliate_commissions (
  id             uuid primary key default gen_random_uuid(),
  affiliate_id   uuid not null references public.affiliates(id) on delete cascade,
  referral_id    uuid references public.affiliate_referrals(id) on delete set null,
  -- Who paid. Kept directly so a deleted referral does not orphan the money.
  user_id        uuid,
  provider       text not null default 'paddle',
  provider_transaction_id text not null,
  provider_subscription_id text,
  -- All amounts in the currency's minor unit (cents), like Paddle sends them.
  -- Integers only: a float share of a payment is a rounding bug with a
  -- customer attached.
  base_amount    bigint not null,
  commission_amount bigint not null,
  currency       text not null,
  -- The rate as it was WHEN THIS WAS EARNED. Frozen on purpose: changing an
  -- affiliate's rate must not silently restate what they already earned.
  commission_pct numeric(5,2) not null,
  -- pending  : inside the refund window, not yet payable
  -- approved : payable, waiting for someone to send the money
  -- paid     : settled, see payout_id
  -- reversed : refunded or charged back, owed nothing
  status         text not null default 'pending',
  is_renewal     boolean not null default false,
  occurred_at    timestamptz not null,
  -- occurred_at plus the refund hold. Nothing should be paid out before this.
  payable_at     timestamptz not null,
  payout_id      uuid,
  paid_at        timestamptz,
  reversed_at    timestamptz,
  reversed_reason text,
  created_at     timestamptz not null default now(),
  constraint affiliate_commissions_status_check
    check (status in ('pending', 'approved', 'paid', 'reversed'))
);

-- Idempotency, and the reason the webhook handler can be careless about
-- retries: Paddle re-delivers aggressively, and one payment must produce one
-- commission no matter how many times it is announced.
create unique index if not exists affiliate_commissions_txn_key
  on public.affiliate_commissions (provider, provider_transaction_id);

create index if not exists affiliate_commissions_affiliate_idx
  on public.affiliate_commissions (affiliate_id, status);

create index if not exists affiliate_commissions_payable_idx
  on public.affiliate_commissions (status, payable_at);

-- ---------------------------------------------------------------------------
-- A settlement someone actually made, by hand, outside this system.
--
-- Recorded rather than performed. Paddle pays the seller, not the seller's
-- affiliates, so there is no API call that could live here; a payout is a bank
-- transfer and this is the note saying it happened.
-- ---------------------------------------------------------------------------
create table if not exists public.affiliate_payouts (
  id           uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  amount       bigint not null,
  currency     text not null,
  -- Free text: "SEPA", "PayPal", "Wise". Not an enum, because the list is
  -- whatever the finance side actually used that month.
  method       text,
  -- Bank reference, PayPal transaction id, whatever proves it was sent.
  reference    text,
  note         text,
  paid_at      timestamptz not null default now(),
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now()
);

create index if not exists affiliate_payouts_affiliate_idx
  on public.affiliate_payouts (affiliate_id);

-- Added after the fact because affiliate_commissions is declared first, and a
-- forward reference would not resolve in a script that runs top to bottom.
-- Worth having rather than leaving payout_id a bare uuid: a commission marked
-- paid should not be able to point at a payout that was never recorded.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'affiliate_commissions_payout_fk'
  ) then
    alter table public.affiliate_commissions
      add constraint affiliate_commissions_payout_fk
      foreign key (payout_id) references public.affiliate_payouts(id) on delete set null;
  end if;
end $$;

comment on table public.affiliates is
  'Affiliate codes. Commission is a percentage of Paddle earnings (after '
  'Paddle fees and excluding tax), never of the gross charge.';
comment on table public.affiliate_commissions is
  'Commission ledger. Nothing here moves money: payouts are made by hand and '
  'recorded in affiliate_payouts.';

-- Backend-only, with the service role. Nothing in the browser reads another
-- account's earnings, and the account page goes through the API for its own.
alter table public.affiliates enable row level security;
alter table public.affiliate_referrals enable row level security;
alter table public.affiliate_commissions enable row level security;
alter table public.affiliate_payouts enable row level security;

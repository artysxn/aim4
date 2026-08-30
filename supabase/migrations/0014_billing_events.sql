-- ===========================================================================
-- 0014_billing_events.sql
-- Webhook idempotency that survives a restart and a second instance.
--
-- routes.js deduplicated events in a per-process Map. That is correct for one
-- long-lived backend and wrong the moment there are two, or one that restarts:
-- providers retry aggressively on any non-2xx, each instance holds its own
-- map, and a retry landing on a different instance (or after a deploy) is
-- applied a second time.
--
-- The primary key IS the check. Inserting the event id either succeeds, which
-- means this process is the first to see it, or raises 23505, which means
-- someone already handled it. No read-then-write, so two instances racing the
-- same retry cannot both decide they are first.
-- ===========================================================================

create table if not exists public.billing_events (
  id          text primary key,          -- the provider's event id, evt_...
  provider    text,                      -- 'paddle' | 'stripe'
  event_type  text,                      -- 'subscription.updated', etc.
  received_at timestamptz not null default now()
);

-- Events are only interesting for as long as a provider might retry them.
-- Paddle retries for up to three days; a month is generous and keeps the table
-- small enough that the index stays hot.
create index if not exists billing_events_received_idx
  on public.billing_events (received_at);

comment on table public.billing_events is
  'Webhook idempotency. One row per provider event id, inserted before the '
  'event is applied. Safe to prune rows older than a month.';

-- No RLS policies on purpose: this table is written only by the backend with
-- the service role, and nothing in the browser has any reason to read it.
alter table public.billing_events enable row level security;

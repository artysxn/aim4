-- ===========================================================================
-- 0010_steam_identity.sql
-- A linked Steam identity on the profile.
--
-- Username registration is self-serve now, and a username alone proves
-- nothing. Uploading demos requires the account to be anchored to a real
-- identity: a Google account (a Supabase identity) or a Steam account (this
-- column). Steam is not a Supabase OAuth provider, so the link lives here,
-- written only by the server after it has verified Steam's OpenID assertion.
--
-- The unique index is the rule "one Steam account anchors one aim4 account".
-- Partial, because most rows hold null and null must not collide.
-- ===========================================================================

alter table public.profiles
  add column if not exists steam_id text;

create unique index if not exists profiles_steam_id_key
  on public.profiles (steam_id)
  where steam_id is not null;

-- No RLS change: the column is written through the service role by the
-- server's link route, never by the browser. Owners read it back via /api/me.

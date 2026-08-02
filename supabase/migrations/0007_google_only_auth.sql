-- ===========================================================================
-- 0007_google_only_auth.sql
-- The username picker, and the flag that forces it.
--
-- Registration used to collect a username, so every account had one it chose.
-- Google sign-in has no such step, and _ensureProfile() falls through to
-- player_<first 8 of uuid>. That name is already visible on leaderboards.
--
-- Google-only therefore needs a first-run picker, and the picker needs to know
-- whether a name was chosen or generated.
--
-- IMPORTANT: this migration does NOT disable the email provider. Existing
-- password accounts must be able to sign in and link Google first. Disabling
-- Email under Authentication -> Providers is a dashboard action, and it comes
-- after the migration window has closed, not with this file.
-- ===========================================================================

-- Default true so existing accounts are untouched: they picked their username
-- at registration. The trigger below sets false for new ones that arrive
-- without a name.
alter table public.profiles
  add column if not exists username_chosen boolean not null default true;

create index if not exists profiles_username_unchosen_idx
  on public.profiles (id) where username_chosen = false;

-- ---------------------------------------------------------------------------
-- handle_new_user
--
-- Replaces the version in schema.sql. Same behaviour for a signup that carries
-- user_metadata.username (email registration, and admin-created accounts);
-- for one that does not (Google), it stamps a provisional name and marks it
-- unchosen so the client blocks on the picker.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text := nullif(trim(new.raw_user_meta_data ->> 'username'), '');
  v_chosen   boolean := v_username is not null;
begin
  if v_username is null then
    v_username := 'player_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;

  -- A provisional name can collide, and a failed insert here fails the whole
  -- signup. Widen it rather than let the trigger abort account creation.
  begin
    insert into public.profiles (id, username, username_chosen)
    values (new.id, lower(v_username), v_chosen);
  exception
    when unique_violation then
      insert into public.profiles (id, username, username_chosen)
      values (new.id, lower(v_username) || '_' || substr(replace(new.id::text, '-', ''), 9, 4), v_chosen)
      on conflict (id) do nothing;
  end;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- claim_username: pick a name, atomically, once.
--
-- Done as a function rather than a client-side "check then update" because
-- between the check and the update someone else can take the name, and the
-- error the user then sees is a raw constraint violation.
-- ---------------------------------------------------------------------------
create or replace function public.claim_username(p_username text)
returns table (ok boolean, error text, username text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clean text := lower(trim(leading '@' from trim(p_username)));
begin
  if auth.uid() is null then
    return query select false, 'not_signed_in', null::text;
    return;
  end if;
  if v_clean !~ '^[a-z0-9_]{3,20}$' then
    return query select false, 'invalid', null::text;
    return;
  end if;

  begin
    update public.profiles p
       set username = v_clean, username_chosen = true
     where p.id = auth.uid();
  exception
    when unique_violation then
      return query select false, 'taken', null::text;
      return;
  end;

  return query select true, null::text, v_clean;
end $$;

revoke all on function public.claim_username(text) from public;
grant execute on function public.claim_username(text) to authenticated;

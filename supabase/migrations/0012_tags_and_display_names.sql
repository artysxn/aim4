-- ===========================================================================
-- 0012_tags_and_display_names.sql
-- An @ tag everyone gets for free, and a display name they choose.
--
-- Two separate things, which the site had collapsed into one:
--
--   · username  — the @ tag. Unique, lowercase, no spaces. It addresses an
--                 account: @s1mple, the thing you type to find someone.
--   · display_name — what a person calls themselves. Not unique, spaces and
--                 accents allowed, and purely cosmetic.
--
-- Before this, a sign-in that carried no username (Google, and now Steam, X
-- and Discord) was stamped `player_<8 hex of the uuid>` with username_chosen
-- = false, which made the client block on a modal before the account could be
-- used. That is a wall in front of a brand-new user for a decision they have
-- no basis to make yet. Now they get a real tag immediately and can change it,
-- and their display name, whenever they like.
--
-- Existing provisional rows (username_chosen = false — nobody ever picked
-- those names) are re-tagged by the same rule, which also retires the modal:
-- with no unchosen rows left, it has nothing to block on.
-- ===========================================================================

alter table public.profiles
  add column if not exists display_name text;

-- ---------------------------------------------------------------------------
-- random_tag: 6 to 8 lowercase letters.
--
-- Letters only, no digits: a tag is read aloud and typed by other people, and
-- 0/O and 1/l cost more in mistyped mentions than the extra entropy is worth.
-- 26^6 is 300 million, so collisions are rare and the caller retries anyway.
-- ---------------------------------------------------------------------------
create or replace function public.random_tag()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_len int := 6 + floor(random() * 3)::int;   -- 6, 7 or 8
  v_out text := '';
  i int;
begin
  for i in 1..v_len loop
    v_out := v_out || substr('abcdefghijklmnopqrstuvwxyz', 1 + floor(random() * 26)::int, 1);
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- free_tag: a random tag nothing else is using.
--
-- Bounded retries, then a uuid-derived suffix that cannot collide. An
-- unbounded loop here would hang account creation on a full keyspace.
-- ---------------------------------------------------------------------------
create or replace function public.free_tag(p_seed uuid)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_tag text;
  i int;
begin
  for i in 1..10 loop
    v_tag := public.random_tag();
    if not exists (select 1 from public.profiles p where p.username = v_tag) then
      return v_tag;
    end if;
  end loop;
  return substr(replace(p_seed::text, '-', ''), 1, 8);
end $$;

-- ---------------------------------------------------------------------------
-- handle_new_user
--
-- Replaces the 0007 version. A signup carrying user_metadata.username still
-- keeps it (username registration, admin-seeded accounts). Everything else —
-- every OAuth provider, and Steam — now gets a random tag rather than a
-- player_<id> placeholder, and is marked chosen so nothing blocks on it.
--
-- display_name comes from whatever the provider called them: full_name and
-- name are what Google, Discord and X send, and Steam's persona is passed as
-- full_name by server/account/steamAuth.js. Null when there is nothing, and
-- the UI falls back to the tag.
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
  v_display  text := nullif(trim(coalesce(
                       new.raw_user_meta_data ->> 'full_name',
                       new.raw_user_meta_data ->> 'name',
                       new.raw_user_meta_data ->> 'user_name',
                       ''
                     )), '');
begin
  if v_username is null then
    -- Not a placeholder any more: a tag the account can keep.
    v_username := public.free_tag(new.id);
    v_chosen := true;
  end if;

  -- A tag can still lose a race with a concurrent signup, and a failed insert
  -- here fails the whole signup. Widen rather than abort.
  begin
    insert into public.profiles (id, username, username_chosen, display_name)
    values (new.id, lower(v_username), v_chosen, left(v_display, 32));
  exception
    when unique_violation then
      insert into public.profiles (id, username, username_chosen, display_name)
      values (
        new.id,
        lower(v_username) || '_' || substr(replace(new.id::text, '-', ''), 9, 4),
        v_chosen,
        left(v_display, 32)
      )
      on conflict (id) do nothing;
  end;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Retire the provisional names.
--
-- Only rows nobody ever chose, so no name a person picked is touched. This is
-- also what empties the blocking picker's queue: needsUsername reads
-- username_chosen = false, and after this there are none.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select id from public.profiles where username_chosen = false loop
    update public.profiles
       set username = public.free_tag(r.id),
           username_chosen = true
     where id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- claim_username: unchanged in spirit, but no longer one-shot.
--
-- The 0007 version existed to convert a provisional name once. A tag is now
-- something an account keeps and can change, so this is just "rename me,
-- atomically" — the atomicity is still the point, because a check followed by
-- an update hands the loser a raw constraint violation.
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

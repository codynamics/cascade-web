-- CAS-1098: complete_membership() transaction + membership_completed_at
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000 and 0001, in one block. Safe to
-- re-run — every statement is idempotent.
--
-- Background: server-first rework (Confluence Cascade/64815105). Product rule (Lee, 2026-09-30):
-- there is no partly-signed-up state — agents built in onboarding exist only if membership
-- completes; otherwise they are lost. Today the onboarding draft reaches the server through the
-- generic sync before the account is loaded, which duplicated agents on existing accounts and
-- dropped onboarding's services and occasions. complete_membership() replaces that: one
-- transaction, all of the draft or none of it, and an existing account keeps what it has (the
-- draft is discarded, never merged).
--
-- Verification (run after):
--   select version from public.schema_migrations order by version;
--   -- expected to include '0002'

-- ---------------------------------------------------------------------------
-- 1. user_prefs.membership_completed_at — set when an account finishes onboarding through
--    complete_membership() below. Backfilled so every existing member already reads complete.
-- ---------------------------------------------------------------------------
alter table public.user_prefs add column if not exists membership_completed_at timestamptz;

update public.user_prefs
set membership_completed_at = coalesce(membership_completed_at, updated_at, now())
where membership_completed_at is null;

-- ---------------------------------------------------------------------------
-- 2. complete_membership(p jsonb) — the ONLY way an onboarding draft reaches the server.
--    security invoker: each table's own RLS (cascades_owner, user_prefs_owner,
--    notify_prefs_owner) already confines every write below to auth.uid(), so this runs as the
--    calling user rather than needing elevated rights.
-- ---------------------------------------------------------------------------
create or replace function public.complete_membership(p jsonb)
returns text
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- An existing account (in ANY of the six tables an onboarding draft could touch) keeps what
  -- it has; the draft is discarded, never merged. Deleted cascades rows still count — a soft
  -- delete is still "this account already exists".
  if exists (select 1 from public.cascades     where user_id = auth.uid())
     or exists (select 1 from public.user_prefs   where user_id = auth.uid())
     or exists (select 1 from public.notify_prefs where user_id = auth.uid())
     or exists (select 1 from public.user_films   where user_id = auth.uid())
     or exists (select 1 from public.film_picks   where user_id = auth.uid())
     or exists (select 1 from public.film_watch   where user_id = auth.uid())
  then
    return 'account_exists';
  end if;

  insert into public.cascades (id, user_id, name, criteria, alert_moments, active)
  select
    (elem->>'id')::uuid,
    auth.uid(),
    coalesce(elem->>'name', 'My agent'),
    coalesce(elem->'criteria', '{}'::jsonb),
    coalesce((select array_agg(v) from jsonb_array_elements_text(elem->'alert_moments') as v),
             '{hits_rent,hits_stream}'::text[]),
    coalesce((elem->>'active')::boolean, true)
  from jsonb_array_elements(coalesce(p->'agents', '[]'::jsonb)) as elem;

  insert into public.user_prefs (
    user_id, sub_services, store_services, services_only, taste, watch_windows,
    occasions, touched, never_show, onb_depth, framing, membership_completed_at
  ) values (
    auth.uid(),
    coalesce((select array_agg(v) from jsonb_array_elements_text(p->'prefs'->'sub_services') as v),
             '{}'::text[]),
    coalesce((select array_agg(v) from jsonb_array_elements_text(p->'prefs'->'store_services') as v),
             '{}'::text[]),
    coalesce((p->'prefs'->>'services_only')::boolean, false),
    coalesce(p->'prefs'->'taste', '{}'::jsonb),
    coalesce(p->'prefs'->'watch_windows', '{}'::jsonb),
    p->'prefs'->'occasions',
    (p->'prefs'->>'touched')::boolean,
    (select array_agg(v) from jsonb_array_elements_text(p->'prefs'->'never_show') as v),
    p->'prefs'->>'onb_depth',
    (p->'prefs'->>'framing')::boolean,
    now()
  )
  on conflict (user_id) do update set
    sub_services             = excluded.sub_services,
    store_services            = excluded.store_services,
    services_only             = excluded.services_only,
    taste                     = excluded.taste,
    watch_windows             = excluded.watch_windows,
    occasions                 = excluded.occasions,
    touched                   = excluded.touched,
    never_show                = excluded.never_show,
    onb_depth                 = excluded.onb_depth,
    framing                   = excluded.framing,
    membership_completed_at   = excluded.membership_completed_at;

  insert into public.notify_prefs (user_id, in_app, email_on, email_address, excluded_moments)
  values (
    auth.uid(),
    coalesce((p->'notify'->>'in_app')::boolean, true),
    coalesce((p->'notify'->>'email_on')::boolean, false),
    p->'notify'->>'email_address',
    coalesce((select array_agg(v) from jsonb_array_elements_text(p->'notify'->'excluded_moments') as v),
             '{}'::text[])
  )
  on conflict (user_id) do update set
    in_app            = excluded.in_app,
    email_on          = excluded.email_on,
    email_address     = excluded.email_address,
    excluded_moments  = excluded.excluded_moments;

  return 'created';
end;
$$;

revoke all on function public.complete_membership(jsonb) from public;
grant execute on function public.complete_membership(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. email_has_account(p_email text) — Sign in (CAS-1088) needs to know whether an email is
--    already a member before sending a magic link. security definer so it can read auth.users
--    (an authenticated/anon caller's own role has no privilege over that table); the boolean it
--    reveals is a deliberate, Lee-accepted narrowing (CAS-1088), not a leak.
-- ---------------------------------------------------------------------------
create or replace function public.email_has_account(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then
    return false;
  end if;

  return exists (select 1 from public.user_prefs
                 where user_id = uid and membership_completed_at is not null)
      or exists (select 1 from public.cascades where user_id = uid);
end;
$$;

revoke all on function public.email_has_account(text) from public;
grant execute on function public.email_has_account(text) to anon, authenticated;

insert into public.schema_migrations (version) values ('0002') on conflict do nothing;

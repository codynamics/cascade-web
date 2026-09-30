-- CAS-1102: clients may delete at most one account row per statement; agents cannot be hard-deleted
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000, 0001 and 0002, in one block. Safe to
-- re-run — every statement is idempotent.
--
-- PRECONDITION FOR APPLYING (the build chat's, not the worker's): the minimum-build gate (CAS-1108)
-- is live, a TestFlight build containing it is on testers' devices, and app_config.min_client_build
-- has been raised to the first build carrying the sign-out ticket (CAS-1100). Until then, old
-- clients still bulk-delete, and they would fail on bulk_delete_blocked.
--
-- Background: server-first rework (Confluence Cascade/64815105). After that rework the client
-- deletes one row per user action; this migration makes the database enforce it, so no future
-- client bug can wipe an account the way the 2026-09-30 incident (CAS-1092) did.
--
-- Verification (run after):
--   select version from public.schema_migrations order by version;
--   -- expected to include '0003'

-- ---------------------------------------------------------------------------
-- 1. cascades — agents are removed only via delete_agent(), which soft-deletes (CAS-1092). Hard
--    delete is no longer permitted for a client at all.
-- ---------------------------------------------------------------------------
revoke delete on public.cascades from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. block_bulk_delete() — a statement-level AFTER DELETE trigger, using a transition table so it
--    sees every row a single statement removed at once rather than once per row. current_user (not
--    auth.role()) is the guard: for a plain client call it is 'authenticated'/'anon', but inside a
--    SECURITY DEFINER function it is the function's OWNER (see archive_deleted_row()'s own note in
--    migrations/0001), so this never fires for the service role or for the security-definer
--    delete_my_account() — confirmed: delete_my_account() is declared `security definer` with no
--    explicit owner change, so it runs as whichever role owns the function (the migration-applying
--    role, e.g. postgres/supabase_admin), which is neither 'authenticated' nor 'anon'.
-- ---------------------------------------------------------------------------
create or replace function public.block_bulk_delete()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') and (select count(*) from old_rows) > 1 then
    raise exception 'bulk_delete_blocked';
  end if;
  return null;
end;
$$;

drop trigger if exists block_bulk_delete on public.user_films;
create trigger block_bulk_delete after delete on public.user_films
  referencing old table as old_rows
  for each statement execute function public.block_bulk_delete();

drop trigger if exists block_bulk_delete on public.film_watch;
create trigger block_bulk_delete after delete on public.film_watch
  referencing old table as old_rows
  for each statement execute function public.block_bulk_delete();

drop trigger if exists block_bulk_delete on public.film_picks;
create trigger block_bulk_delete after delete on public.film_picks
  referencing old table as old_rows
  for each statement execute function public.block_bulk_delete();

drop trigger if exists block_bulk_delete on public.list_films;
create trigger block_bulk_delete after delete on public.list_films
  referencing old table as old_rows
  for each statement execute function public.block_bulk_delete();

drop trigger if exists block_bulk_delete on public.lists;
create trigger block_bulk_delete after delete on public.lists
  referencing old table as old_rows
  for each statement execute function public.block_bulk_delete();

drop trigger if exists block_bulk_delete on public.friends;
create trigger block_bulk_delete after delete on public.friends
  referencing old table as old_rows
  for each statement execute function public.block_bulk_delete();

drop trigger if exists block_bulk_delete on public.push_tokens;
create trigger block_bulk_delete after delete on public.push_tokens
  referencing old table as old_rows
  for each statement execute function public.block_bulk_delete();

drop trigger if exists block_bulk_delete on public.agent_films;
create trigger block_bulk_delete after delete on public.agent_films
  referencing old table as old_rows
  for each statement execute function public.block_bulk_delete();

insert into public.schema_migrations (version) values ('0003') on conflict do nothing;

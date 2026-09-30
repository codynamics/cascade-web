-- CAS-1092: migration ledger + account safety net (delete archive, agent soft delete, policy fixes)
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000, in one block. Safe to re-run —
-- every statement is idempotent.
--
-- Background (supabase/schema.sql @ dadcd44): every account table was owner `for all`
-- (select/insert/update/delete) with no archive, history or soft delete except
-- watchlists.deleted_at. On 2026-09-30 a client sync bug deleted every agent on an account with
-- no way back. This migration adds:
--   1. A migration ledger (schema_migrations), so repo<->live drift (CAS-1074) stops happening.
--   2. An archive-on-delete safety net (account_deleted_rows) for the 12 account tables that are
--      not high-volume/derived/analytics (agent_films, notifications and analytics tables are
--      deliberately excluded — see 2a).
--   3. Soft delete for agents specifically (delete_agent), independent of the archive.
--   4. A handful of RLS/trigger/index fixes that were overdue independent of the incident.
--
-- Verification (run after):
--   select version from public.schema_migrations order by version;
--   -- expected to include '0001'

-- ---------------------------------------------------------------------------
-- 0. Migration ledger
-- ---------------------------------------------------------------------------
create table if not exists public.schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);
alter table public.schema_migrations enable row level security;
-- No client policies — nobody but service_role/the SQL editor's own postgres role ever reads
-- or writes this table.

-- ---------------------------------------------------------------------------
-- 1a. account_deleted_rows — the archive, + the archive_deleted_row() trigger function
-- ---------------------------------------------------------------------------
create table if not exists public.account_deleted_rows (
  id           bigserial primary key,
  table_name   text not null,
  row_data     jsonb not null,
  deleted_by   uuid default auth.uid(),
  deleted_role text default current_user,
  deleted_at   timestamptz not null default now()
);
alter table public.account_deleted_rows enable row level security;
-- No client policies — this is a write-only-by-trigger, read-only-by-Lee ledger.

-- security definer: runs as the function's owner so it can insert into account_deleted_rows
-- (which has no client policies) no matter which table's own RLS-less trigger context invoked
-- it. deleted_role records the CALLING role (via auth.role()), not the definer's own elevated
-- role, which is why `current_user` alone is not enough — inside a security definer trigger
-- `current_user` is always the function's owner. Skips the archive entirely mid a self-service
-- account deletion (CAS-980): delete_my_account() below sets the cascade.account_delete flag
-- before it deletes anything, so a deleted account is not retained here either.
create or replace function public.archive_deleted_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('cascade.account_delete', true) = 'on' then
    return old;
  end if;
  insert into public.account_deleted_rows (table_name, row_data, deleted_role)
  values (TG_TABLE_NAME, to_jsonb(old), coalesce(auth.role(), current_user));
  return old;
end;
$$;

-- Attached AFTER DELETE on the 12 tables named by the ticket. Deliberately NOT on agent_films
-- (derived, high volume), notifications, or any analytics table.
drop trigger if exists archive_deleted_row on public.cascades;
create trigger archive_deleted_row after delete on public.cascades
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.user_films;
create trigger archive_deleted_row after delete on public.user_films
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.user_prefs;
create trigger archive_deleted_row after delete on public.user_prefs
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.notify_prefs;
create trigger archive_deleted_row after delete on public.notify_prefs
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.film_picks;
create trigger archive_deleted_row after delete on public.film_picks
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.film_watch;
create trigger archive_deleted_row after delete on public.film_watch
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.lists;
create trigger archive_deleted_row after delete on public.lists
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.list_films;
create trigger archive_deleted_row after delete on public.list_films
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.watchlists;
create trigger archive_deleted_row after delete on public.watchlists
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.friends;
create trigger archive_deleted_row after delete on public.friends
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.invites;
create trigger archive_deleted_row after delete on public.invites
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.push_tokens;
create trigger archive_deleted_row after delete on public.push_tokens
  for each row execute function public.archive_deleted_row();

-- ---------------------------------------------------------------------------
-- 1b. cascades soft delete — delete_agent()
-- ---------------------------------------------------------------------------
alter table public.cascades add column if not exists deleted_at timestamptz;
create index if not exists cascades_not_deleted_idx on public.cascades (user_id) where deleted_at is null;

-- security invoker (the default — stated explicitly): runs as the calling user, so
-- cascades_owner's own RLS already confines the UPDATE to the caller's rows; the explicit
-- user_id = auth.uid() below is redundant with that policy but kept because the ticket names it.
-- Hard deletes remain permitted for now (a later ticket removes them) — this RPC is an
-- additional, softer path, not a replacement for the existing DELETE policy.
create or replace function public.delete_agent(p_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.cascades
  set deleted_at = now()
  where id = p_id and user_id = auth.uid() and deleted_at is null;

  if not found then
    raise exception 'delete_agent: no matching active agent %', p_id;
  end if;
end;
$$;

revoke all on function public.delete_agent(uuid) from public;
grant execute on function public.delete_agent(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 1c. notifications — the client updates only read_at (confirmed against app_template.html:
-- markRealAlertsRead's only write is .update({read_at:now})); lock the column grant to match.
-- The row policy (notifications_mark_read) is unchanged.
-- ---------------------------------------------------------------------------
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- ---------------------------------------------------------------------------
-- 1d. watchlists — enforce the one-row-per-user invariant the app already keeps
-- ---------------------------------------------------------------------------
do $$
declare
  dupes text;
begin
  select string_agg(user_id::text, ', ' order by user_id) into dupes
  from (
    select user_id from public.watchlists group by user_id having count(*) > 1
  ) d;
  if dupes is not null then
    raise exception 'watchlists: unique(user_id) violated by existing rows for user_id(s): %', dupes;
  end if;
end $$;

create unique index if not exists watchlists_user_id_key on public.watchlists (user_id);

-- ---------------------------------------------------------------------------
-- 1e. list_films / agent_films — with-check also verifies the parent list/cascade is the
-- caller's, not just user_id (which a client could otherwise pair with someone else's list_id/
-- cascade_id). `using` is unchanged.
-- ---------------------------------------------------------------------------
drop policy if exists list_films_owner on public.list_films;
create policy list_films_owner on public.list_films
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.lists l where l.id = list_id and l.user_id = auth.uid())
  );

drop policy if exists agent_films_owner on public.agent_films;
create policy agent_films_owner on public.agent_films
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.cascades c where c.id = cascade_id and c.user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 1f. set_updated_at() also fires BEFORE INSERT, so a client-supplied updated_at is never
-- accepted on insert. Same function, each table's own trigger widened from BEFORE UPDATE to
-- BEFORE INSERT OR UPDATE.
-- ---------------------------------------------------------------------------
drop trigger if exists cascades_set_updated_at on public.cascades;
create trigger cascades_set_updated_at
  before insert or update on public.cascades
  for each row execute function public.set_updated_at();

drop trigger if exists user_films_set_updated_at on public.user_films;
create trigger user_films_set_updated_at
  before insert or update on public.user_films
  for each row execute function public.set_updated_at();

drop trigger if exists notify_prefs_set_updated_at on public.notify_prefs;
create trigger notify_prefs_set_updated_at
  before insert or update on public.notify_prefs
  for each row execute function public.set_updated_at();

drop trigger if exists film_picks_set_updated_at on public.film_picks;
create trigger film_picks_set_updated_at
  before insert or update on public.film_picks
  for each row execute function public.set_updated_at();

drop trigger if exists film_watch_set_updated_at on public.film_watch;
create trigger film_watch_set_updated_at
  before insert or update on public.film_watch
  for each row execute function public.set_updated_at();

drop trigger if exists user_prefs_set_updated_at on public.user_prefs;
create trigger user_prefs_set_updated_at
  before insert or update on public.user_prefs
  for each row execute function public.set_updated_at();

drop trigger if exists lists_set_updated_at on public.lists;
create trigger lists_set_updated_at
  before insert or update on public.lists
  for each row execute function public.set_updated_at();

drop trigger if exists list_films_set_updated_at on public.list_films;
create trigger list_films_set_updated_at
  before insert or update on public.list_films
  for each row execute function public.set_updated_at();

drop trigger if exists watchlists_set_updated_at on public.watchlists;
create trigger watchlists_set_updated_at
  before insert or update on public.watchlists
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 1g. indexes the rate-limit triggers already query but never had
-- ---------------------------------------------------------------------------
create index if not exists recommendations_sender_created_idx
  on public.recommendations (sender_id, created_at);
create index if not exists usage_events_client_created_idx
  on public.usage_events (client_key, created_at);
create index if not exists contact_messages_client_created_idx
  on public.contact_messages (client_key, created_at);

-- ---------------------------------------------------------------------------
-- 1h. delete_my_account() — set the account-delete flag before deleting anything, so the
-- archive trigger (1a) skips a deleted account instead of retaining it.
-- ---------------------------------------------------------------------------
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'delete_my_account: not signed in';
  end if;

  perform set_config('cascade.account_delete', 'on', true);

  delete from public.agent_films      where user_id = uid;
  delete from public.cascades         where user_id = uid;
  delete from public.user_films       where user_id = uid;
  delete from public.film_watch       where user_id = uid;
  delete from public.notifications    where user_id = uid;
  delete from public.usage_events     where user_id = uid;
  delete from public.push_tokens      where user_id = uid;
  delete from public.friends          where owner_id = uid;
  delete from public.invites          where sender_id = uid;
  delete from public.invite_replies   where replier_id = uid;
  delete from public.contact_messages where user_id = uid;
  delete from public.analytics_admins where user_id = uid;

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------
-- 1i. purge_deleted_rows — service_role-only maintenance step over the archive
-- ---------------------------------------------------------------------------
create or replace function public.purge_deleted_rows(p_days int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count int;
begin
  delete from public.account_deleted_rows
  where deleted_at < now() - (p_days || ' days')::interval;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.purge_deleted_rows(int) from public, anon, authenticated;
grant execute on function public.purge_deleted_rows(int) to service_role;

-- ---------------------------------------------------------------------------
-- 1j. app_config — server-read, no client write; seeds min_client_build (CAS-1108)
-- ---------------------------------------------------------------------------
create table if not exists public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;

drop policy if exists app_config_read on public.app_config;
create policy app_config_read on public.app_config
  for select to anon, authenticated using (true);

insert into public.app_config (key, value) values ('min_client_build', '0'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1k. admin_cascades / admin_members — count only cascades rows with deleted_at is null, now
-- that cascades can carry a soft delete. Same security_invoker=false + analytics_admins guard
-- as migrations/0000 (CAS-1074); do not drop that guard when editing these.
-- ---------------------------------------------------------------------------
create or replace view public.admin_cascades
with (security_invoker = false) as
select id, user_id, name, criteria, alert_moments, active, created_at, updated_at
from public.cascades
where deleted_at is null
  and exists (select 1 from public.analytics_admins a where a.user_id = auth.uid());

create or replace view public.admin_members
with (security_invoker = false) as
with ev as (
  select
    usage_events.user_id,
    min(usage_events.created_at) as first_seen_at,
    max(usage_events.created_at) as last_seen_at,
    count(*) as events,
    count(distinct usage_events.session) as sessions,
    count(distinct usage_events.client_key) as devices,
    count(distinct date_trunc('day', usage_events.created_at)) as active_days
  from public.usage_events
  where usage_events.user_id is not null
  group by usage_events.user_id
),
ag as (
  select
    cascades.user_id,
    count(*) as agents,
    max(cascades.updated_at) as last_agent_edit
  from public.cascades
  where cascades.deleted_at is null
  group by cascades.user_id
)
select
  coalesce(ev.user_id, ag.user_id) as user_id,
  left(coalesce(ev.user_id, ag.user_id)::text, 8) as short_id,
  ev.first_seen_at, ev.last_seen_at, ev.events, ev.sessions, ev.devices, ev.active_days,
  coalesce(ag.agents, 0) as agents,
  ag.last_agent_edit
from ev
full join ag on ag.user_id = ev.user_id
where exists (select 1 from public.analytics_admins a where a.user_id = auth.uid());

revoke all on public.admin_cascades from anon, public;
revoke all on public.admin_members  from anon, public;
grant select on public.admin_cascades to authenticated;
grant select on public.admin_members  to authenticated;

insert into public.schema_migrations (version) values ('0001') on conflict do nothing;

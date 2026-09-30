-- CAS-1074: Admin views return only the signed-in admin's own rows (Members 8 vs 15)
--
-- Apply this in the Supabase dashboard, SQL Editor, on project ypccfyatejejslzlfrbf, in one block.
-- Safe to re-run (every statement is idempotent).
--
-- What this does:
--   1. Adds the analytics_admins_select_self policy (already live per Lee's 27 Sep read, included
--      here only so the live project and this file agree — running it again is a no-op).
--   2. Redefines admin_members / admin_member_activity / admin_member_onboarding with
--      security_invoker = false plus an analytics_admins guard, so an admin's own RLS on cascades/
--      usage_events no longer truncates the aggregates. admin_member_emails already ran this way
--      live; it is included so its guard is never accidentally dropped by a future edit that
--      forgets it exists.
--   3. Adds admin_cascades: an admin-only view over cascades, so the Admin site's all-members
--      cascades count no longer has to read the RLS-protected cascades table directly (which
--      limited it to the signed-in admin's own 5).
--   4. Locks all five down to `authenticated` only (no anon, no PUBLIC).
--
-- Verification (run after, signed in as an admin listed in analytics_admins):
--   select count(*) from public.admin_members;
--   -- expected: 15 (the live member count, not 8)

drop policy if exists analytics_admins_select_self on public.analytics_admins;
create policy analytics_admins_select_self on public.analytics_admins
  for select to authenticated using (user_id = auth.uid());

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

create or replace view public.admin_member_activity
with (security_invoker = false) as
select user_id, type as feature, count(*) as events, min(created_at) as first_at, max(created_at) as last_at
from public.usage_events
where user_id is not null
  and exists (select 1 from public.analytics_admins a where a.user_id = auth.uid())
group by user_id, type;

create or replace view public.admin_member_onboarding
with (security_invoker = false) as
select
  user_id,
  coalesce(data ->> 'step', data ->> 'key', '(unknown)') as step,
  count(*) filter (where type = 'onbstep_shown')    as shown,
  count(*) filter (where type = 'onbstep_continue') as continued,
  count(*) filter (where type = 'onbstep_skipped')  as skipped,
  max(created_at) as last_at
from public.usage_events
where user_id is not null
  and type like 'onbstep_%'
  and exists (select 1 from public.analytics_admins a where a.user_id = auth.uid())
group by user_id, (coalesce(data ->> 'step', data ->> 'key', '(unknown)'));

create or replace view public.admin_member_emails
with (security_invoker = false) as
select id as user_id, email::text as email
from auth.users u
where exists (select 1 from public.analytics_admins a where a.user_id = auth.uid());

create or replace view public.admin_cascades
with (security_invoker = false) as
select id, user_id, name, criteria, alert_moments, active, created_at, updated_at
from public.cascades
where exists (select 1 from public.analytics_admins a where a.user_id = auth.uid());

revoke all on public.admin_members          from anon, public;
revoke all on public.admin_member_activity  from anon, public;
revoke all on public.admin_member_onboarding from anon, public;
revoke all on public.admin_member_emails    from anon, public;
revoke all on public.admin_cascades         from anon, public;

grant select on public.admin_members          to authenticated;
grant select on public.admin_member_activity  to authenticated;
grant select on public.admin_member_onboarding to authenticated;
grant select on public.admin_member_emails    to authenticated;
grant select on public.admin_cascades         to authenticated;

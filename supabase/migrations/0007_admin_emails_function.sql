-- CAS-1227: Supabase flags public.admin_member_emails as a SECURITY DEFINER view exposing
-- auth.users (its "User data exposed through a view" CRITICAL alert, auth_users_exposed). The
-- view ran with security_invoker = false (its owner's rights) and selected straight from
-- auth.users, gated only by the analytics_admins exists-check inside the view body — which the
-- advisor can't see, so it flags the view regardless. This migration moves the auth.users read
-- into an explicit SECURITY DEFINER function carrying the same guard, and turns the view into a
-- thin security_invoker = true wrapper around that function, so no public view depends on
-- auth.users directly any more. The other four admin views (admin_members,
-- admin_member_activity, admin_member_onboarding, admin_cascades) never needed anything but
-- SELECT — this also drops the INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER grants Supabase
-- adds to every view by default.
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000-0006, in one block.
-- Safe to re-run — every statement is idempotent.
-- Do NOT apply this to production from this commit — the build chat applies it on Lee's go.

create or replace function public.admin_member_emails_list()
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.email::text
  from auth.users u
  where exists (select 1 from public.analytics_admins a where a.user_id = auth.uid())
$$;

revoke all on function public.admin_member_emails_list() from public, anon;
grant execute on function public.admin_member_emails_list() to authenticated;

create or replace view public.admin_member_emails
with (security_invoker = true) as
select user_id, email from public.admin_member_emails_list();

revoke all on public.admin_member_emails from public, anon, authenticated;
grant select on public.admin_member_emails to authenticated;

revoke insert, update, delete, truncate, references, trigger on public.admin_members from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.admin_member_activity from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.admin_member_onboarding from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.admin_cascades from authenticated;

insert into public.schema_migrations (version) values ('0007') on conflict do nothing;

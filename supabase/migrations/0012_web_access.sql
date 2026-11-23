-- CAS-1531: web_access — the approved-email list for cascademovies.com (invite-only).
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000-0011. Safe to re-run (idempotent).
-- NOT applied by the worker — Lee-gated.
--
-- A signed-in account whose email is in this table is treated as a member (source "web_access"). Lee adds
-- people in the SQL editor, e.g.:
--   insert into public.web_access (email, note) values ('someone@example.com', 'tester') on conflict do nothing;
-- Emails are stored and matched lower-case.
create table if not exists public.web_access (
  email    text primary key,
  note     text,
  added_at timestamptz not null default now()
);
-- RLS on with NO policy for any client role: a client can neither list nor write the table. The only read
-- path is is_web_access_approved() below, which answers yes/no for the caller's own email.
alter table public.web_access enable row level security;

create or replace function public.is_web_access_approved()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.web_access w
    where lower(w.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_web_access_approved() from public;
grant execute on function public.is_web_access_approved() to authenticated;

-- The CAS-1458 testing bypass is retired (LifeOS task 28: off before App Review).
delete from public.app_config where key = 'membership_bypass';

insert into public.schema_migrations (version) values ('0012') on conflict do nothing;

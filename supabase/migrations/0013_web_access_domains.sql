-- CAS-<this ticket>: web_access also approves whole domains. A row whose email starts with '@' approves every
-- address at that domain (e.g. '@codynamics.com.au'). Applied to production by the build chat 23 Nov 2026.
-- Safe to re-run.
create or replace function public.is_web_access_approved()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with me as (select lower(coalesce(auth.jwt() ->> 'email', '')) as e)
  select exists (
    select 1 from public.web_access w, me
    where me.e <> ''
      and ( lower(w.email) = me.e
         or (left(w.email,1) = '@' and split_part(me.e,'@',2) = lower(substr(w.email,2))) )
  );
$$;
revoke all on function public.is_web_access_approved() from public;
grant execute on function public.is_web_access_approved() to authenticated;
insert into public.web_access (email, note) values ('@codynamics.com.au', 'Whole domain (Lee, 23 Nov)') on conflict do nothing;

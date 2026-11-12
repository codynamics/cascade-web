-- CAS-971: memberships — the server-side entitlement for the iOS in-app purchase.
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000-0009. Safe to re-run (idempotent).
-- NOT applied by the worker — Lee-gated.

-- Cascade is an iOS-only paid app (Apple in-app purchase). Nothing about membership lives only on the
-- device: the app reads this row to decide whether the account may use the app. Rows are written ONLY by
-- the membership-verify and membership-notifications Edge Functions (service_role bypasses RLS) and by
-- Lee, for comps — so there is deliberately no insert/update/delete policy for any client role.
--   status  : 'active' | 'expired' | 'revoked' | 'grace' | 'billing_retry'
--   source  : 'apple' (a verified App Store transaction) | 'comp' (granted by hand — see below)
-- A comp is a row with source = 'comp' and a far-future expires_at, e.g. run as postgres/service_role:
--   insert into public.memberships (user_id, product_id, status, expires_at, source)
--   values ('<auth.users id>', 'comp', 'active', '2099-12-31', 'comp')
--   on conflict (user_id) do update set status='active', expires_at='2099-12-31', source='comp', updated_at=now();
create table if not exists public.memberships (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  original_transaction_id text unique,
  product_id              text not null,
  status                  text not null default 'active',
  expires_at              timestamptz not null,
  is_trial                boolean not null default false,
  source                  text not null default 'apple',
  updated_at              timestamptz not null default now()
);
alter table public.memberships enable row level security;

drop policy if exists memberships_select_own on public.memberships;
create policy memberships_select_own on public.memberships
  for select to authenticated using (auth.uid() = user_id);

-- The one definition of "active member" the client and any future server check share: a row that has not
-- expired and has not been revoked/refunded. Grace and billing-retry still count (Apple is still trying).
create or replace function public.is_active_member(p_user uuid default auth.uid())
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = p_user
      and m.status in ('active','grace','billing_retry')
      and m.expires_at > now()
  );
$$;
revoke all on function public.is_active_member(uuid) from public;
grant execute on function public.is_active_member(uuid) to authenticated;

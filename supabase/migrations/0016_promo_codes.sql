-- CAS-1565: promo codes replace the web approved list (Lee, 25 Nov 2026). Safe to re-run.
create table if not exists public.promo_codes (
  code       text primary key,                 -- stored upper-case
  months     int  not null check (months between 1 and 120),
  max_uses   int,                              -- null = unlimited
  active     boolean not null default true,
  note       text,
  created_at timestamptz not null default now()
);
alter table public.promo_codes enable row level security;   -- no policies: invisible to every client role

create table if not exists public.promo_redemptions (
  user_id     uuid primary key references auth.users(id) on delete cascade,   -- one code per account, ever
  code        text not null references public.promo_codes(code),
  redeemed_at timestamptz not null default now(),
  counts      boolean not null default true    -- false for the 25 Nov backfill of the approved list
);
alter table public.promo_redemptions enable row level security;
drop policy if exists promo_redemptions_select_own on public.promo_redemptions;
create policy promo_redemptions_select_own on public.promo_redemptions
  for select to authenticated using (auth.uid() = user_id);

-- Before an account exists (the sign-up email step): is this code usable right now? Yes/no only.
create or replace function public.check_promo_code(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.promo_codes c
    where c.code = upper(trim(coalesce(p_code,''))) and c.active
      and (c.max_uses is null or (select count(*) from public.promo_redemptions r where r.code = c.code and r.counts) < c.max_uses)
  );
$$;
revoke all on function public.check_promo_code(text) from public;
grant execute on function public.check_promo_code(text) to anon, authenticated;

-- Signed in: redeem for the caller. Grants a 'promo' membership for the code's months.
create or replace function public.redeem_promo_code(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  c    public.promo_codes;
  used int;
  m    public.memberships;
  exp  timestamptz;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'signed_out'); end if;
  select * into c from public.promo_codes where code = upper(trim(coalesce(p_code,''))) for update;
  if not found or not c.active then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if exists (select 1 from public.promo_redemptions where user_id = uid) then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;
  select count(*) into used from public.promo_redemptions where code = c.code and counts;
  if c.max_uses is not null and used >= c.max_uses then return jsonb_build_object('ok', false, 'error', 'used_up'); end if;
  select * into m from public.memberships where user_id = uid;
  if found and m.source = 'apple' and m.status in ('active','grace','billing_retry') and m.expires_at > now() then
    return jsonb_build_object('ok', false, 'error', 'already_member');
  end if;
  exp := now() + make_interval(months => c.months);
  insert into public.promo_redemptions (user_id, code) values (uid, c.code);
  insert into public.memberships (user_id, product_id, status, expires_at, is_trial, source)
    values (uid, 'promo:' || c.code, 'active', exp, false, 'promo')
    on conflict (user_id) do update set product_id = excluded.product_id, status = 'active',
      expires_at = excluded.expires_at, is_trial = false, source = 'promo', updated_at = now();
  return jsonb_build_object('ok', true, 'expires_at', exp);
end;
$$;
revoke all on function public.redeem_promo_code(text) from public;
grant execute on function public.redeem_promo_code(text) to authenticated;

insert into public.promo_codes (code, months, max_uses, active, note)
  values ('CASCADEFRIENDS', 12, 25, true, 'Friends of Cascade (Lee, 25 Nov 2026)')
  on conflict (code) do nothing;

-- §1b BACKFILL (migration only, not schema.sql): everyone the retired approved list lets in today keeps access.
-- A free year, recorded as a CASCADEFRIENDS redemption that does NOT count towards the 25 uses. Accounts that
-- already have an active membership (e.g. Apple) are left alone.
do $$
begin
  if to_regclass('public.web_access') is not null then
    insert into public.promo_redemptions (user_id, code, counts)
      select u.id, 'CASCADEFRIENDS', false from auth.users u
      where exists (select 1 from public.web_access w
                    where lower(u.email) = lower(w.email)
                       or (left(w.email,1) = '@' and split_part(lower(u.email),'@',2) = lower(substr(w.email,2))))
        and not exists (select 1 from public.memberships m where m.user_id = u.id
                        and m.status in ('active','grace','billing_retry') and m.expires_at > now())
      on conflict (user_id) do nothing;
    insert into public.memberships (user_id, product_id, status, expires_at, is_trial, source)
      select r.user_id, 'promo:CASCADEFRIENDS', 'active', now() + interval '12 months', false, 'promo'
      from public.promo_redemptions r
      where r.code = 'CASCADEFRIENDS' and not r.counts
        and not exists (select 1 from public.memberships m where m.user_id = r.user_id
                        and m.status in ('active','grace','billing_retry') and m.expires_at > now())
      on conflict (user_id) do update set product_id = excluded.product_id, status = 'active',
        expires_at = excluded.expires_at, is_trial = false, source = 'promo', updated_at = now();
  end if;
end $$;

-- CAS-1504: alerts by channel — record at 03:00, one push at 07:30, 17:00 email of only unseen alerts.
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000-0010 and BEFORE the release that carries
-- CAS-1504 is promoted (the app and the monitor both read/write the new columns). Safe to re-run.
-- NOT applied by the worker — Lee-gated.
--
-- Until now `emailed_at` doubled as the row's creation time (default now()). Rows now exist from the
-- 03:00 "find and record" run, hours before any push or email, so the three facts get their own columns:
--   found_at   when the monitor recorded the alert (the app orders and windows Alerts by this)
--   pushed_at  when the 07:30 push covered this row     (null = not pushed)
--   emailed_at when the 17:00 digest covered this row   (null = not emailed) — now means what it says
--   detail     the transition's services/price, so the 17:00 email can render the same card as before
--              without re-running the catalogue diff

alter table public.notifications add column if not exists found_at  timestamptz not null default now();
alter table public.notifications add column if not exists pushed_at timestamptz;
alter table public.notifications add column if not exists detail    jsonb;

-- Every existing row was created at its own emailed_at and has already been delivered by whatever
-- channels were on, so carry the old timestamp across and mark it pushed — the new phases must never
-- re-send history.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'notifications' and column_name = 'emailed_at'
               and (is_nullable = 'NO' or column_default is not null)) then
    update public.notifications set found_at = emailed_at, pushed_at = emailed_at
      where emailed_at is not null and pushed_at is null and found_at > emailed_at;
    alter table public.notifications alter column emailed_at drop not null;
    alter table public.notifications alter column emailed_at drop default;
  end if;
end $$;

create index if not exists notifications_found_at_idx on public.notifications (found_at);

-- CAS-1535: alert batches, the day +1 catch-up's ledger shape, and the email-answer columns.
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000-0013 and BEFORE the release that carries
-- CAS-1535 is promoted (the monitor writes the new table/columns). Safe to re-run.
-- NOT applied by the worker - Lee-gated.
--
-- CAS-1535: every alert email is a "batch" - one member's alerts for one Sydney night - that opens its own
-- view in Alerts (?dl=alerts:batch:<id>), plus the day +1 catch-up (kind 'catchup'), plus the answer
-- columns the one-tap email answers (T3) and the "From your email" view (T2) share.
create table if not exists public.alert_batches (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  sydney_date date not null,
  kind        text not null default 'daily' check (kind in ('daily', 'catchup')),
  headline    text,
  created_at  timestamptz not null default now(),
  emailed_at  timestamptz,
  pushed_at   timestamptz,
  unique (user_id, sydney_date)
);

alter table public.alert_batches enable row level security;

-- A member reads only their own batches. No insert/update/delete policy: the monitor writes them with
-- the service_role key, which bypasses RLS.
drop policy if exists alert_batches_read_own on public.alert_batches;
create policy alert_batches_read_own on public.alert_batches
  for select using (auth.uid() = user_id);

alter table public.notifications add column if not exists batch_id    uuid references public.alert_batches(id) on delete set null;
alter table public.notifications add column if not exists answer      text;
alter table public.notifications add column if not exists answered_at timestamptz;
alter table public.notifications drop constraint if exists notifications_answer_check;
alter table public.notifications add constraint notifications_answer_check
  check (answer is null or answer in ('cinema', 'home', 'notfor'));

create index if not exists notifications_batch_id_idx on public.notifications (batch_id);
create index if not exists alert_batches_user_idx on public.alert_batches (user_id);

-- The client's writes to the ledger: stamping a row read, and answering it from the email view.
revoke update on public.notifications from authenticated;
grant update (read_at, answer, answered_at) on public.notifications to authenticated;

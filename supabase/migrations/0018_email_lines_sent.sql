-- CAS-1592: "once per account, recorded durably" for one-time email lines (the first is the Taste line,
-- "<agent> has learned something"). Add-only and backward compatible: a new table nothing else reads. The monitor
-- reads it before an alert email and writes it only AFTER the send landed.
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0017. Safe to re-run. NOT applied by the worker - Lee-gated.
-- Until it is applied the monitor cannot tell whether the line was sent, so it leaves the line out (never guesses).
create table if not exists public.email_lines_sent (
  user_id uuid not null references auth.users(id) on delete cascade,
  line    text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, line)
);

-- No policy: only the monitor (service_role, which bypasses RLS) reads or writes it.
alter table public.email_lines_sent enable row level security;

insert into public.schema_migrations (version) values ('0018') on conflict do nothing;

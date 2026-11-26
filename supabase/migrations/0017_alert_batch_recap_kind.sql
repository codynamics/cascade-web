-- CAS-1567: the day-7 recap email ("Your first week with <agent>") is its own alert batch kind, so "once per
-- member" is durable (the member's batch for that Sydney date is kind 'recap' with emailed_at set) and the
-- recap's links open its own "From your email" view like every other alert email.
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0014 and BEFORE the release that carries CAS-1567 is
-- promoted (the monitor writes kind = 'recap'). Safe to re-run. NOT applied by the worker - Lee-gated.
alter table public.alert_batches drop constraint if exists alert_batches_kind_check;
alter table public.alert_batches add constraint alert_batches_kind_check
  check (kind in ('daily', 'catchup', 'recap'));

insert into public.schema_migrations (version) values ('0017') on conflict do nothing;

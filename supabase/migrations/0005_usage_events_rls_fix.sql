-- CAS-1137: usage_events_insert's with check rejected every row where data is null
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000-0004, in one block.
-- Safe to re-run — every statement is idempotent.
--
-- Background: every signed-in user's usage_events writes were being dropped (42501, "new row
-- violates row-level security policy"). The policy's `pg_column_size(data) <= 4096` check had no
-- null guard — pg_column_size(null) is null, and a with check that evaluates to null (not true)
-- fails the row. queueUsageEvent's many call sites with no data argument (splash_shown,
-- flow_start, search_used, etc.) always sent data: null, and one bad row fails the whole batched
-- insert, taking the rest of that flush down with it. Fixed by guarding the size check the same
-- way the session length check just above it already guards a null session. This migration also
-- adds the owner check the original policy never had: user_id stays nullable (an anon/pre-login
-- event), but a row may no longer be attributed to a different auth.uid() than the caller's own.
--
-- Verification (run after):
--   select version from public.schema_migrations order by version;
--   -- expected to include '0005'

drop policy if exists usage_events_insert on public.usage_events;
create policy usage_events_insert on public.usage_events
  for insert to anon, authenticated with check (
    length(type) <= 64
    and length(client_key) <= 200
    and length(coalesce(session,'')) <= 200
    and (data is null or pg_column_size(data) <= 4096)
    and (user_id is null or user_id = auth.uid())
  );

insert into public.schema_migrations (version) values ('0005') on conflict do nothing;

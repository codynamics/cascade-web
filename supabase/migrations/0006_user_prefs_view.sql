-- CAS-1220: user_prefs.view — the server home for per-account view state
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000-0005, in one block.
-- Safe to re-run — every statement is idempotent.
--
-- Background: Lee's rule — the only data a device holds is the film catalogue; everything else is
-- saved to and drawn from the server. Some per-account state has no server home yet: the selected
-- occasion, the selected agent, per-tab "my services only", tutorial seen, review-prompt state, the
-- Found list as last looked at. This migration only adds the column; a separate ticket moves the
-- app over to it. No policy change: user_prefs_owner already covers the row.
--
-- Verification (run after):
--   select version from public.schema_migrations order by version;
--   -- expected to include '0006'

alter table public.user_prefs add column if not exists view jsonb;

insert into public.schema_migrations (version) values ('0006') on conflict do nothing;

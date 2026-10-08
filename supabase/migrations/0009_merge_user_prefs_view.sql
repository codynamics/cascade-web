-- CAS-1222: merge_user_prefs_view(p_patch) — a per-field, concurrency-safe merge into user_prefs.view.
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000-0008, in one block.
-- Safe to re-run — every statement is idempotent.
--
-- Background: view holds several independent per-account UI-state fields (selected agent(s), per-tab
-- "my services only", the Found list as last looked at, tutorial seen, the two review-prompt values, the
-- onboarding invite draft, the admission-drift diagnostic) that two devices can change at the same moment
-- (e.g. one device changes the selected agent while another changes my-services-only). Every other
-- user_prefs column (taste/watch_windows/moving_seen/occasions) is written as a whole-object upsert on the
-- rule that "last write wins IS the update" — fine when a column holds one person's one setting, but wrong
-- here: whichever device's whole-column push lands second would silently clobber the first device's field.
-- This function merges the patch INTO whatever `view` already holds, server-side, in the write itself (the
-- jsonb `||` operator keeps every key the caller's patch doesn't name), so the order two devices' pushes
-- arrive in never matters.
--
-- security invoker (the default — stated explicitly): user_prefs_owner's own RLS (auth.uid() = user_id)
-- confines both branches of this upsert to the caller's own row.
--
-- Verification (run after):
--   select version from public.schema_migrations order by version;
--   -- expected to include '0009'

create or replace function public.merge_user_prefs_view(p_patch jsonb)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.user_prefs (user_id, view)
  values (auth.uid(), p_patch)
  on conflict (user_id) do update
    set view = coalesce(public.user_prefs.view, '{}'::jsonb) || excluded.view;
$$;

revoke all on function public.merge_user_prefs_view(jsonb) from public;
grant execute on function public.merge_user_prefs_view(jsonb) to authenticated;

insert into public.schema_migrations (version) values ('0009') on conflict do nothing;

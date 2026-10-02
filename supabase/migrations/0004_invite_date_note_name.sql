-- CAS-1120: invite suggested date and note, and a sender display name
--
-- Apply this in the Supabase dashboard SQL editor, AFTER 0000, 0001, 0002 and 0003, in one block.
-- Safe to re-run — every statement is idempotent.
--
-- Background: Lee's decision (2026-10-01) — an invite carries an optional suggested date and an
-- optional note, shown in the invite email and on the invite page. The email must say who invited
-- you; today sender_name is the sender's email local part (e.g. lee+c20), because accounts have no
-- name. display_name lets a member set one to be used instead (CAS-1121, needs-lee on this
-- migration, picks up the sending/rendering side once this is applied).
--
-- Verification (run after):
--   select version from public.schema_migrations order by version;
--   -- expected to include '0004'

-- ---------------------------------------------------------------------------
-- 1. invites.suggested_date / invites.note — both optional, surfaced by invite_by_token() below
--    the same way every other invites column already is.
-- ---------------------------------------------------------------------------
alter table public.invites add column if not exists suggested_date date;
alter table public.invites add column if not exists note text;

alter table public.invites drop constraint if exists invites_note_check;
alter table public.invites add constraint invites_note_check
  check (note is null or char_length(note) <= 500);

-- ---------------------------------------------------------------------------
-- 2. invite_by_token(p_token text) — now also returns suggested_date and note, the signed-out
--    recipient's only way to read an invite (CAS-944).
-- ---------------------------------------------------------------------------
create or replace function public.invite_by_token(p_token text)
returns json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'token', token,
    'sender_name', sender_name,
    'tmdb_id', tmdb_id,
    'film_title', film_title,
    'to_name', to_name,
    'suggested_date', suggested_date,
    'note', note,
    'created_at', created_at
  )
  from public.invites
  where token = p_token;
$$;

-- ---------------------------------------------------------------------------
-- 3. user_prefs.display_name — an account-level name a member can set, so the invite email can
--    say who invited you by name rather than the sender's email local part.
-- ---------------------------------------------------------------------------
alter table public.user_prefs add column if not exists display_name text;

alter table public.user_prefs drop constraint if exists user_prefs_display_name_check;
alter table public.user_prefs add constraint user_prefs_display_name_check
  check (display_name is null or char_length(display_name) between 1 and 60);

insert into public.schema_migrations (version) values ('0004') on conflict do nothing;

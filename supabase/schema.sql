-- Cascade Web — database schema + row-level security
-- Source of truth: Confluence "Cascade Web — Architecture & CC Build Spec" §3.
-- Apply this in the Supabase SQL editor (see supabase/README.md). Safe to re-run.
-- This file is the full current state, kept in sync with supabase/migrations/ (CAS-1092): a
-- schema change lands as a new numbered migration AND the matching edit here, in the same commit.
--
-- Twenty-three tables:
--   schema_migrations — the migration ledger (CAS-1092): one row per applied migration file.
--   cascades      — one row per saved agent, per user (the user owns their rows via RLS).
--                   Soft-deletable since CAS-1092 (deleted_at) via the delete_agent() RPC; a hard
--                   DELETE is archived into account_deleted_rows (below) rather than lost for good.
--   user_prefs    — the account-level defaults a NEW agent starts from, plus the services the
--                   user actually pays for. CAS-211.
--   user_films    — one row per (user, film) the user has said something about: liked, so-so,
--                   didn't like, don't-want-to-watch, watch-again ("wow"), or enjoyed-but-not-
--                   watch-again. CAS-183, CAS-278/349 (wow/enjoyed), CAS-738 (persisted).
--   notify_prefs  — one row per user: how they want to be told, and which alert TYPES they
--                   have muted everywhere. CAS-185.
--   film_picks    — one row per (user, film) the user has hand-added or hand-removed from
--                   their Found list. An "off" here outranks their own Cascade. CAS-185. Also
--                   carries `pinned_to`/`not_in`, the CAS-279 hand-move override. CAS-739.
--   film_watch    — one row per (user, film) carrying the set of windows the user's per-film
--                   "Watch it" control has ticked. A real, independent notification source —
--                   the daily job fires on it whether or not any agent's own bell is on. CAS-484.
--                   Also carries `sources` — auto/manual per ticked window, mirroring the client's
--                   winsSource, so provenance survives a reload on another device. CAS-726.
--   agent_films   — one row per (user, cascade, film) an agent has admitted: the score/status it
--                   was admitted under and the agent's own signature at that moment. Membership
--                   itself stays derived until CAS-728 makes it sticky against this table; this
--                   table is the storage CAS-727/728 write through. CAS-726.
--   lists         — one row per user-curated collection (name only). Manual, not criteria-driven
--                   — the opposite of a cascade. CAS-428.
--   list_films    — one row per (user, film, list): a film can sit in several lists at once, so
--                   this is a true join table, unlike user_films/film_picks. CAS-428.
--   watchlists    — the Watch screen's own persisted filter record: which services/agents/watched-
--                   verdicts/tiers/sort it's currently scoped to. Shaped like `cascades` (id +
--                   opaque criteria jsonb) on purpose, not `user_prefs`'s one-row-per-user shape, so
--                   CAS-590 can grow this into several named lists with no schema change. CAS-589.
--   notifications — the alert ledger; the daily monitoring job writes it with the
--                   service_role key (which bypasses RLS) and de-dupes against it so the
--                   same (cascade, movie, moment) is never delivered twice. The app reads
--                   its own rows back to fill the 🔔 bell.
--   push_tokens   — one row per (user, device) APNs token, registered on sign-in/re-registration.
--                   The monitor (service_role) reads it to know where to push; the user manages
--                   only their own rows. CAS-464.
--   usage_events  — the CAS-809/810/811 sink: a batched copy of the client's local usage log
--                   (event type + small data payload, never free text). Insert-only, unreadable
--                   through the anon key — the app writes, only service_role reads. CAS-835.
--   contact_messages — Contact us submissions (CAS-836/M10). An unauthenticated write on a
--                   public origin, so it is rate limited by client_key via a security definer
--                   trigger from day one. Insert-only, unreadable through the anon key — the
--                   daily monitor reads unsent rows with service_role and stamps sent_at once
--                   its digest email has gone out.
--   invites       — one row per Invite send (CAS-883/M12). A real record, not a stateless
--                   ref-code link: a per-send token, the sender, the film, and the name the
--                   sender gave the recipient. Readable by anon (token only) so a signed-out
--                   recipient can open the invite they were sent.
--   invite_replies — one row per (invite, client_key) Yes/No reply. Insertable AND updatable by
--                   anon (CAS-885) so a signed-out recipient can answer, then overwrite their own
--                   reply on a repeat visit; readable only by the invite's own sender. `digested_at`
--                   (CAS-887) is stamped by the daily monitor once a reply has led an email digest —
--                   a separate column from `seen_at`, which stays the app's alone (opening the
--                   Invites screen), so a digest run can never clear a badge nobody has actually seen.
--   recommendations — Recommend Cascade sends (CAS-884/M11), read by the hourly recommend.yml
--                   workflow and sent with the service_role key.
--   invite_emails — the outgoing queue for a multi-recipient Invite's email leg (CAS-930/M12).
--   friends       — the shared recipient picker's own saved people (CAS-928/M12); readable only
--                   by their owner.
--   analytics_admins — the allowlist gating the admin_* views and the usage_events read policy
--                   below (CAS-942).
--   account_deleted_rows — the CAS-1092 archive: every row hard-deleted from the 12 tables the
--                   archive_deleted_row() trigger is attached to lands here first, so a client
--                   sync bug or a fat-fingered delete is recoverable. Not written for agent_films
--                   (derived, high volume), notifications, or any analytics table.
--   app_config    — small server-read/no-client-write config, e.g. min_client_build (CAS-1108).

-- gen_random_uuid() lives in pgcrypto. It is pre-installed on Supabase, but declaring the
-- dependency keeps this file self-contained and portable to a plain Postgres.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- schema_migrations — the migration ledger (CAS-1092)
-- ---------------------------------------------------------------------------
create table if not exists public.schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);
alter table public.schema_migrations enable row level security;
-- No client policies — nobody but service_role/the SQL editor's own postgres role ever reads
-- or writes this table.

-- ---------------------------------------------------------------------------
-- cascades — one row per saved agent, per user
-- ---------------------------------------------------------------------------
create table if not exists public.cascades (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null default 'My agent',
  -- The WHOLE agent config, as one object the front-end owns end to end: kind (cinema |
  -- stream), the availability windows and their finer watch moments, the bar's four dials,
  -- genres, language, the age list, the year window and the per-window service scope.
  -- Deliberately not a column each (CAS-211): every one of those has changed shape at least
  -- once this release — age went from a lo..hi band to a list, scale from a band index to a
  -- dollar floor — and each change would have been a migration against live rows. The
  -- monitor reads only alert_moments and criteria, and matching.py mirrors the front-end's
  -- own matcher field for field.
  criteria      jsonb not null default '{}'::jsonb,
  alert_moments text[] not null default '{hits_rent,hits_stream}',
                 -- subset of: hits_cinema | past_opening_weekend | hits_pvod | hits_rent | hits_stream
                 -- hits_pvod added by CAS-103 (the editor's Purchase bell). No migration is needed:
                 -- the column is an unconstrained text[], so existing rows stay valid and simply
                 -- never carry the new value until the user switches Purchase on.
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.cascades enable row level security;

-- A user can read and write only their own cascades.
drop policy if exists cascades_owner on public.cascades;
create policy cascades_owner on public.cascades
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The monitoring job pulls active cascades grouped by user; index the hot columns.
create index if not exists cascades_user_id_idx on public.cascades (user_id);
create index if not exists cascades_active_idx  on public.cascades (active) where active;

-- CAS-1092: soft delete for agents, independent of the archive-on-hard-delete safety net below.
-- Hard deletes remain permitted for now (a later ticket removes them) — delete_agent() is an
-- additional, softer path, not a replacement for cascades_owner's own DELETE grant.
alter table public.cascades add column if not exists deleted_at timestamptz;
create index if not exists cascades_not_deleted_idx on public.cascades (user_id) where deleted_at is null;

-- security invoker (the default — stated explicitly): runs as the calling user, so
-- cascades_owner's own RLS already confines the UPDATE to the caller's rows; the explicit
-- user_id = auth.uid() below is redundant with that policy but kept for clarity.
create or replace function public.delete_agent(p_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.cascades
  set deleted_at = now()
  where id = p_id and user_id = auth.uid() and deleted_at is null;

  if not found then
    raise exception 'delete_agent: no matching active agent %', p_id;
  end if;
end;
$$;

revoke all on function public.delete_agent(uuid) from public;
grant execute on function public.delete_agent(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- user_films — what the user has said about a film (CAS-183)
-- ---------------------------------------------------------------------------
-- One row per (user, film), not one per answer: the six statuses are mutually
-- exclusive by definition — you cannot have both liked and disliked the same film —
-- so the primary key enforces that rather than the application remembering to.
-- Clearing an answer DELETES the row; "no opinion" is the absence of a row, which is
-- also what makes the local sets and this table the same shape.
-- movie_id is text to match notifications.movie_id (TMDB ids arrive as numbers from the
-- catalogue and as strings from the monitor; one type across both tables, always).
-- 'wow' and 'enjoyed' (CAS-738) ride the same row/CHECK as the original four — they are
-- watched-film opinions like the rest, not a second concept needing their own column.
create table if not exists public.user_films (
  user_id    uuid not null references auth.users(id) on delete cascade,
  movie_id   text not null,
  status     text not null check (status in ('liked','soso','disliked','notfor','wow','enjoyed')),
  updated_at timestamptz not null default now(),
  primary key (user_id, movie_id)
);

-- CAS-1039: CAS-738 widened the CHECK to six values only inside this create-table statement, which never
-- alters a table that already exists — the live constraint stayed at the original four values, so a single
-- 'wow'/'enjoyed' row in a batched upsert made the WHOLE user_films sync fail every time (23514). Drop and
-- re-add the constraint idempotently so a live table converges to the current six values on every re-run,
-- the same pattern every other table on this file already follows for a column/constraint added after its
-- table went live (e.g. user_prefs' watch_windows, film_picks' pinned_to/not_in below).
alter table public.user_films drop constraint if exists user_films_status_check;
alter table public.user_films add constraint user_films_status_check
  check (status in ('liked','soso','disliked','notfor','wow','enjoyed'));

alter table public.user_films enable row level security;

-- A user can read and write only their own rows.
drop policy if exists user_films_owner on public.user_films;
create policy user_films_owner on public.user_films
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The app loads a user's whole set on sign-in; the primary key already indexes user_id
-- first, so no extra index is needed.

-- ---------------------------------------------------------------------------
-- user_prefs — account-level defaults and services (CAS-211)
-- ---------------------------------------------------------------------------
-- Two different things live here, and they are different from everything on a
-- cascade row:
--   the SERVICES the user pays for — an account fact, not an agent's opinion. The
--   agent's own per-window scope ("only show me things I can already watch") stays
--   in its criteria; this is the list that scope is measured against.
--   the TASTE DEFAULTS a new agent starts from — genres, how-far-back, languages and
--   the age range. Since CAS-182 every agent carries its OWN copy of those four, so
--   this is a starting point and never a live filter over anyone's agents. Changing
--   it must not silently re-narrow an agent the user already made.
-- `taste` is jsonb for the same reason cascades.criteria is: it is one small object
-- the front-end owns end to end, and a column per dimension would need a migration
-- every time a dimension is added.
create table if not exists public.user_prefs (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  sub_services   text[] not null default '{}',
  store_services text[] not null default '{}',
  services_only  boolean not null default false,
  taste          jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);

-- CAS-561: Where & when you'll watch (Track/Alert per window) was a second CAS-532 "one answer for
-- every agent" setting that, like `taste`, had stayed localStorage-only — added here rather than a new
-- table since it is the same shape (one small object the front-end owns whole), the same owner, and the
-- same debounced upsert path already carries `taste`.
alter table public.user_prefs add column if not exists watch_windows jsonb not null default '{}'::jsonb;

-- CAS-740: touched/never_show/onb_depth/framing carry account-level settings that used to be
-- localStorage-only (prefs.touched, cascade_onb_answers' never/depth, cascade_ux). Left NULLABLE with no
-- default, deliberately unlike sub_services/services_only above: a NOT NULL DEFAULT would make every
-- pre-existing row read back as a real "false"/"[]"/"best" answer the moment this migration runs, which is
-- indistinguishable from a device genuinely having answered that way — the app would adopt the default over
-- whatever this device's own local value already was. NULL is the one value that unambiguously means "no
-- device has saved this under the new column yet", so the front end can tell "unanswered" apart from a
-- real answer and carry the local value up instead of overwriting it (same rule CAS-561 applied to taste/
-- watch_windows above, extended here to scalars and an array that can legitimately be empty/false).
alter table public.user_prefs add column if not exists touched boolean;
alter table public.user_prefs add column if not exists never_show text[];
alter table public.user_prefs add column if not exists onb_depth text;
alter table public.user_prefs add column if not exists framing boolean;

-- CAS-742: the Moving screen's own seen-state ({filmId: lastSeenGroupKey}) was device-local — clearing the
-- badge on one device left it lit on every other. Same whole-object jsonb shape and carry-up rule as taste/
-- watch_windows above (an empty/absent object is read as "no device has saved this yet", not "the account
-- has decided nothing is seen"), the cheapest home for a second front-end-owned object this table already
-- carries whole.
alter table public.user_prefs add column if not exists moving_seen jsonb;

-- CAS-775: the Occasions register ([{id,name}]) — an Occasion used to be purely derived (the union of what
-- agents happened to carry, CAS-768), which could not hold one no agent yet carried, be renamed, or be
-- deleted. Same whole-object jsonb shape and NULL carry-up rule as taste/watch_windows/moving_seen above:
-- NULL means "no device has saved this yet"; an empty array is a real, distinct answer.
alter table public.user_prefs add column if not exists occasions jsonb;

-- CAS-837: an invite link carries the sender's ref code, not their user id (the code must not be
-- reversible to an account). NULL, same reasoning as CAS-740's columns above: no device has minted
-- one yet. Unique so two accounts can never collide on the same code.
alter table public.user_prefs add column if not exists ref_code text;
create unique index if not exists user_prefs_ref_code_idx
  on public.user_prefs (ref_code) where ref_code is not null;

alter table public.user_prefs enable row level security;

drop policy if exists user_prefs_owner on public.user_prefs;
create policy user_prefs_owner on public.user_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- notify_prefs — how a user wants to be told (CAS-185)
-- ---------------------------------------------------------------------------
-- One row per user, so "how do you want to hear from us" is asked and answered once
-- rather than per agent. `email_address` is deliberately its own column and NOT assumed
-- to be auth.users.email: a person can sign in with one address and want alerts at
-- another, and the monitor must never guess which. Null means "use the account address".
-- `excluded_moments` is the global mute (CAS-103 AC4) — an alert TYPE switched off here
-- outranks every one of that user's Cascades.
create table if not exists public.notify_prefs (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  in_app           boolean not null default true,
  email_on         boolean not null default false,
  email_address    text,
  excluded_moments text[] not null default '{}',
  updated_at       timestamptz not null default now()
);

alter table public.notify_prefs enable row level security;

drop policy if exists notify_prefs_owner on public.notify_prefs;
create policy notify_prefs_owner on public.notify_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- film_picks — the personal override on a Found list (CAS-100, stored CAS-185)
-- ---------------------------------------------------------------------------
-- 'mine' = the user added this film by hand; 'off' = they took it off, and it stays off;
-- null = the film carries neither, only a pin/move below. The monitor reads the 'off' rows
-- and says nothing about those films, every run, until the user changes their mind: your
-- answer outranks your own Cascade. Held on the device until CAS-185.
-- CAS-739: pinned_to/not_in are CAS-279's hand-move override (which agent a film is forced
-- IN to / OUT of, regardless of criteria) — the other class of per-film hand decision, added
-- to this table rather than a new one since both key on the same (user_id, movie_id) and a
-- film can carry a pick state and a pin/move at once.
create table if not exists public.film_picks (
  user_id    uuid not null references auth.users(id) on delete cascade,
  movie_id   text not null,
  state      text check (state in ('mine','off')),
  pinned_to  text[] not null default '{}',
  not_in     text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, movie_id)
);
alter table public.film_picks alter column state drop not null;
alter table public.film_picks add column if not exists pinned_to text[] not null default '{}';
alter table public.film_picks add column if not exists not_in text[] not null default '{}';

alter table public.film_picks enable row level security;

drop policy if exists film_picks_owner on public.film_picks;
create policy film_picks_owner on public.film_picks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- film_watch — real per-film "Watch it" alerts (CAS-484)
-- ---------------------------------------------------------------------------
-- One row per (user, film): the set of windows (in_cinema | premium | rent | stream) the user has
-- explicitly ticked on that film's Watch-it control. Its own table, not a column on film_picks —
-- that table's `state` is a CHECK'd 'mine'/'off' with a different meaning ("hide this film from
-- Found"), where this is "tell me when this film reaches X", an independent choice (CAS-434's
-- honesty guardrail: only an explicit tick ever lands a row here, never the agent's own config).
-- The monitor's match_film_watches() (matching.py) reads this as a SECOND, agent-independent
-- source of hits alongside a Cascade's own alert_moments — it fires whether or not any agent's
-- bell for that window is on. A row with an empty `windows` array is deleted rather than kept
-- (mirrors film_picks/user_films: "no ticks" is the absence of a row, not a row saying so).
create table if not exists public.film_watch (
  user_id    uuid not null references auth.users(id) on delete cascade,
  movie_id   text not null,
  windows    text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, movie_id)
);

alter table public.film_watch enable row level security;

drop policy if exists film_watch_owner on public.film_watch;
create policy film_watch_owner on public.film_watch
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- CAS-726: window key -> "auto" | "manual", mirroring the client's winsSource — which of `windows`
-- an agent armed vs the account holder ticked by hand. A window absent here reads as source-unknown
-- (no colour, no overwrite protection), exactly today's behaviour, until the user next sets it —
-- so an old row migrates for free with the column's own default.
alter table public.film_watch add column if not exists sources jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- agent_films — the admitted set, per agent (CAS-726)
-- ---------------------------------------------------------------------------
-- One row per (user, cascade, film) a cascade has admitted. Membership is sticky (CAS-728): recomputeFound
-- reads and writes this table every pass instead of re-deriving membership from scratch. `agent_sig` is the
-- cascSigOf(c) value in force when the row was written — CAS-728's re-evaluation compares it to the agent's
-- CURRENT signature to know whether the row still reflects the agent's settings. A row with nothing to say
-- (the film left the agent, or was watched/dismissed) is deleted rather than kept, same convention as
-- film_picks/user_films/film_watch.
create table if not exists public.agent_films (
  user_id          uuid not null references auth.users(id) on delete cascade,
  cascade_id       uuid not null references public.cascades(id) on delete cascade,
  movie_id         text not null,
  admitted_at      timestamptz not null default now(),
  admission_score  int not null,
  admission_status text not null,
  agent_sig        text not null,
  primary key (user_id, cascade_id, movie_id)
);

alter table public.agent_films enable row level security;

-- CAS-1092: with-check also verifies the parent cascade is the caller's, not just user_id (which
-- a client could otherwise pair with someone else's cascade_id). `using` is unchanged.
drop policy if exists agent_films_owner on public.agent_films;
create policy agent_films_owner on public.agent_films
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.cascades c where c.id = cascade_id and c.user_id = auth.uid())
  );

create index if not exists agent_films_cascade_id_idx on public.agent_films (cascade_id);

-- ---------------------------------------------------------------------------
-- lists — a user's own hand-picked collections (CAS-428)
-- ---------------------------------------------------------------------------
-- Same small-row-per-item shape as cascades, but deliberately not jsonb: a list is just a name,
-- with none of the shape-changes-every-release history that criteria has, so a plain column stays
-- honest instead of anticipating a flexibility this table has never needed.
create table if not exists public.lists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null default 'My list',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lists enable row level security;

drop policy if exists lists_owner on public.lists;
create policy lists_owner on public.lists
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists lists_user_id_idx on public.lists (user_id);

-- ---------------------------------------------------------------------------
-- list_films — film <-> list membership (CAS-428)
-- ---------------------------------------------------------------------------
-- One row per (user, film, list) — a genuine join table, unlike user_films/film_picks, whose one
-- row per (user, film) encodes a single mutually-exclusive answer. A film can be in several lists
-- at once, so the primary key has to include list_id. list_id cascades on delete so removing a
-- list from `lists` cleans up its memberships for free, matching what the client's removeList()
-- already does to its own local `listMembership` object.
create table if not exists public.list_films (
  user_id    uuid not null references auth.users(id) on delete cascade,
  movie_id   text not null,
  list_id    uuid not null references public.lists(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (user_id, movie_id, list_id)
);

alter table public.list_films enable row level security;

-- CAS-1092: with-check also verifies the parent list is the caller's, not just user_id (which a
-- client could otherwise pair with someone else's list_id). `using` is unchanged.
drop policy if exists list_films_owner on public.list_films;
create policy list_films_owner on public.list_films
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.lists l where l.id = list_id and l.user_id = auth.uid())
  );

create index if not exists list_films_list_id_idx on public.list_films (list_id);

-- ---------------------------------------------------------------------------
-- watchlists — the Watch screen's own persisted filter record (CAS-589)
-- ---------------------------------------------------------------------------
-- Shaped exactly like `cascades` — a thin id/user_id pair plus an opaque `criteria` jsonb blob —
-- rather than `user_prefs`'s single-row-per-user shape, even though the app upserts only one row
-- per user today. That is deliberate: CAS-590 (multiple named watch lists) turns this into a real
-- array of rows with no further schema change, the same way a new cascade field never needs a
-- migration because criteria is opaque to the database.
create table if not exists public.watchlists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- svcOn / cascOff / watchedOn / watchTiers / sort — the five fields the Watch screen's filters
  -- keep between visits (CAS-589). cascOff is the COMPLEMENT — ids explicitly unticked — so a newly
  -- created agent is included by default without this row needing to know about it.
  criteria   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.watchlists enable row level security;

drop policy if exists watchlists_owner on public.watchlists;
create policy watchlists_owner on public.watchlists
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists watchlists_user_id_idx on public.watchlists (user_id);

-- CAS-692: a deletion is a positive, replicated fact — a device deletes a list by setting deleted_at
-- rather than removing the row, so an offline device that hasn't seen the deletion can't read an absent
-- row as "never existed" and silently resurrect it. Rows are never hard-deleted by a client; a row
-- tombstoned for more than 90 days MAY be hard-deleted by a maintenance step, never by client code.
alter table public.watchlists add column if not exists deleted_at timestamptz;
create index if not exists watchlists_deleted_at_idx on public.watchlists (deleted_at);

-- CAS-1092: the app keeps one row per user; enforce it. Raises a clear exception naming the
-- offending user_ids instead of failing the index build with an opaque duplicate-key error, and
-- never deletes a row itself.
do $$
declare
  dupes text;
begin
  select string_agg(user_id::text, ', ' order by user_id) into dupes
  from (
    select user_id from public.watchlists group by user_id having count(*) > 1
  ) d;
  if dupes is not null then
    raise exception 'watchlists: unique(user_id) violated by existing rows for user_id(s): %', dupes;
  end if;
end $$;

create unique index if not exists watchlists_user_id_key on public.watchlists (user_id);

-- ---------------------------------------------------------------------------
-- notifications — the alert ledger (de-dupe: never email the same
-- movie+moment twice per cascade)
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  cascade_id  uuid references public.cascades(id) on delete cascade,
  movie_id    text not null,
  moment      text not null,
  emailed_at  timestamptz not null default now(),
  unique (cascade_id, movie_id, moment)
);

-- CAS-185: the ledger is now the IN-APP delivery as well as the email de-dupe, so it
-- carries what the bell needs to draw a row without re-deriving it from the catalogue —
-- and `read_at` so an unread badge means something. Both columns are added rather than
-- assumed, so this file stays safe to re-run against a database that predates them.
alter table public.notifications add column if not exists cascade_name text;
alter table public.notifications add column if not exists title text;
alter table public.notifications add column if not exists read_at timestamptz;

alter table public.notifications enable row level security;

-- A user may read their own notification history, and mark it read. There is deliberately
-- no insert or delete policy for end users: inserts are done only by the daily job using
-- the service_role key, which bypasses RLS.
drop policy if exists notifications_read_own on public.notifications;
create policy notifications_read_own on public.notifications
  for select using (auth.uid() = user_id);

drop policy if exists notifications_mark_read on public.notifications;
create policy notifications_mark_read on public.notifications
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- CAS-1092: the client's only write is markRealAlertsRead's .update({read_at:now}) — confirmed
-- against app_template.html. Lock the column grant to match; the row policy above is unchanged.
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- The de-dupe check filters by user; the unique() above already indexes
-- (cascade_id, movie_id, moment).
create index if not exists notifications_user_id_idx on public.notifications (user_id);

-- ---------------------------------------------------------------------------
-- push_tokens — one row per (user, device) APNs token (CAS-464)
-- ---------------------------------------------------------------------------
-- Registered by CAS-463's sign-in/re-registration flow, read by the monitor (CAS-465) to
-- know who/where to push. platform is constrained to 'ios' because that is the only app
-- shell this repo builds today (CAS-453); widen the check when a second platform ships.
-- unique(user_id, device_token) doubles as the user_id lookup index, same reasoning as
-- user_films above, so no separate index is added.
create table if not exists public.push_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  device_token  text not null,
  platform      text not null default 'ios' check (platform in ('ios')),
  app_version   text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (user_id, device_token)
);

alter table public.push_tokens enable row level security;

-- A user can read and write only their own tokens (insert/update/delete on sign-in,
-- sign-out, re-registration). The monitor's service_role key bypasses RLS for delivery
-- reads, same convention as notifications — no separate policy needed for it.
drop policy if exists push_tokens_owner on public.push_tokens;
create policy push_tokens_owner on public.push_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- usage_events — batched sink for the client's local usage log (CAS-835)
-- ---------------------------------------------------------------------------
-- Feeds CAS-808/810 (M11/M13); this ticket builds the sink only, no reporting. A signed-out
-- visitor must be able to write, so this is insert-only for anon+authenticated with no
-- auth.uid() gate, and unreadable through the anon key — the app writes, service_role reads.
-- client_key is the per-device id from localStorage (cascade_client_key), not an account.
create table if not exists public.usage_events (
  id          bigserial primary key,
  user_id     uuid references auth.users(id) on delete set null,
  client_key  text not null,
  session     text,
  type        text not null,
  data        jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists usage_events_created_idx on public.usage_events (created_at desc);
create index if not exists usage_events_type_idx    on public.usage_events (type);
-- CAS-1092: usage_events_rate_limit() below queries (client_key, created_at) on every insert.
create index if not exists usage_events_client_created_idx on public.usage_events (client_key, created_at);

alter table public.usage_events enable row level security;

drop policy if exists usage_events_insert on public.usage_events;
create policy usage_events_insert on public.usage_events
  for insert to anon, authenticated with check (
    length(type) <= 64
    and length(client_key) <= 200
    and length(coalesce(session,'')) <= 200
    and pg_column_size(data) <= 4096
  );

-- security definer: counts every client_key's own rows to enforce the rate limit, the same
-- shape as contact_messages_rate_limit below. app_template.html has 89 logEvent( call sites
-- (CAS-948: `grep -c "logEvent(" app_template.html` = 90, minus the function's own definition
-- line); the client batches them into flushes of at most USAGE_QUEUE_MAX=200 rows, debounced
-- ~10s apart, so genuine heavy use tops out at a few hundred rows/hour. Set comfortably above.
create or replace function public.usage_events_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.usage_events
      where client_key = new.client_key and created_at > now() - interval '1 hour') >= 3000 then
    raise exception 'usage_events: rate limit exceeded (3000/hour)';
  end if;
  if (select count(*) from public.usage_events
      where client_key = new.client_key and created_at > now() - interval '24 hours') >= 15000 then
    raise exception 'usage_events: rate limit exceeded (15000/day)';
  end if;
  return new;
end;
$$;

drop trigger if exists usage_events_rate_limit on public.usage_events;
create trigger usage_events_rate_limit
  before insert on public.usage_events
  for each row execute function public.usage_events_rate_limit();

-- ---------------------------------------------------------------------------
-- contact_messages — Contact us submissions + rate limiting (CAS-836)
-- ---------------------------------------------------------------------------
-- An unauthenticated write on a public origin, so the abuse controls ship here rather than
-- waiting for CAS-812. No select, update or delete policy is created — the anon key must
-- never read this table; the daily monitor reads unsent rows and stamps sent_at with the
-- service_role key, which bypasses RLS.
create table if not exists public.contact_messages (
  id          bigserial primary key,
  user_id     uuid references auth.users(id) on delete set null,
  client_key  text not null,
  category    text not null,
  email       text,
  message     text not null,
  diagnostics text,
  build       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index if not exists contact_messages_unsent_idx
  on public.contact_messages (created_at) where sent_at is null;
-- CAS-1092: contact_messages_rate_limit() below queries (client_key, created_at) on every insert.
create index if not exists contact_messages_client_created_idx on public.contact_messages (client_key, created_at);

alter table public.contact_messages enable row level security;

drop policy if exists contact_messages_insert on public.contact_messages;
create policy contact_messages_insert on public.contact_messages
  for insert to anon, authenticated with check (
    length(message) between 1 and 2000
    and length(coalesce(email,'')) <= 200
    and length(coalesce(diagnostics,'')) <= 8000
    -- bug/suggestion/account/other are the #contact sheet's own categories (CAS-838/927); broken/idea/
    -- film/billing are the Feedback sheet's (CAS-978) — a distinct taxonomy for a distinct entry point,
    -- both writing into this same table.
    and category in ('bug','suggestion','account','other','broken','idea','film','billing')
  );

-- security definer: counts every client_key's own rows to enforce the rate limit, including
-- rows the anon role that just inserted has no select grant on.
create or replace function public.contact_messages_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.contact_messages
      where client_key = new.client_key and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'contact_messages: rate limit exceeded (5/hour)';
  end if;
  if (select count(*) from public.contact_messages
      where client_key = new.client_key and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'contact_messages: rate limit exceeded (20/day)';
  end if;
  return new;
end;
$$;

drop trigger if exists contact_messages_rate_limit on public.contact_messages;
create trigger contact_messages_rate_limit
  before insert on public.contact_messages
  for each row execute function public.contact_messages_rate_limit();

-- ---------------------------------------------------------------------------
-- contact_messages attachment — one optional screenshot per message (CAS-864)
-- ---------------------------------------------------------------------------
-- The bucket is private (no select policy): the anon key that uploads must never be able to
-- read it back, and the monitor mints a signed URL with the service_role key for the digest.
-- Insert-only, for the same reason contact_messages itself is: the sender may be signed out.
alter table public.contact_messages add column if not exists attachment_path text;

insert into storage.buckets (id, name, public)
values ('contact-attachments', 'contact-attachments', false)
on conflict (id) do nothing;

-- CAS-948: caps enforced server-side so a direct storage API call can't bypass the client's own
-- CONTACT_ATTACH_MAX_BYTES/CONTACT_ATTACH_TYPES checks (app_template.html).
update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/png','image/jpeg','image/webp']
where id = 'contact-attachments';

-- CAS-948: the caller is anonymous, so there is no verifiable identity to bind the path to —
-- client_key is a value the client asserts, not a claim RLS can check (the same limitation
-- contact_messages_rate_limit's own client_key already has). What IS enforceable is shape: the
-- object name must be exactly one folder segment deep (storage.foldername returns null/{} for a
-- bare filename and 2+ elements for a nested path), matching the `${CLIENT_KEY}/<file>` path the
-- client already writes — this blocks path traversal and arbitrary top-level names, which is the
-- concrete gap the previous `bucket_id = ...`-only check left open.
drop policy if exists contact_attachments_insert on storage.objects;
create policy contact_attachments_insert on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'contact-attachments'
    and array_length(storage.foldername(name), 1) = 1
    and length((storage.foldername(name))[1]) between 1 and 200
  );

-- ---------------------------------------------------------------------------
-- invites / invite_replies — Invite to a movie (CAS-883/M12)
-- ---------------------------------------------------------------------------
create table if not exists public.invites (
  token       text primary key,
  sender_id   uuid not null references auth.users(id) on delete cascade,
  sender_name text,
  tmdb_id     bigint not null,
  film_title  text,
  to_name     text,
  created_at  timestamptz not null default now()
);
create index if not exists invites_sender_idx on public.invites (sender_id, created_at desc);

alter table public.invites enable row level security;

drop policy if exists invites_owner on public.invites;
create policy invites_owner on public.invites
  for all using (auth.uid() = sender_id) with check (auth.uid() = sender_id);

-- CAS-944: the anon SELECT policy this table used to carry allowed any caller to list every row —
-- RLS cannot see the client's WHERE clause, so `using (true)` passes every row a query asks for,
-- not just the one row a caller's token actually proves access to. The equally permissive INSERT
-- and client-driven UPDATE policies on invite_replies below had the same shape: client_key is a
-- value the client sends, not an identity, so anyone could forge or rewrite any reply. All three
-- are replaced by a pair of security definer RPCs — public.invite_by_token() and
-- public.answer_invite(), further down this section — that enforce "by token only" server-side.
-- Dropping the three permissive policies against the live project is a separate Lee-gated step,
-- applied 2026-09-12 onward.
drop policy if exists invites_read_by_token on public.invites;

-- CAS-944: returns exactly one row for a given token, or null when it doesn't exist — the
-- signed-out recipient's only way to read an invite now that the table has no anon SELECT policy.
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
    'created_at', created_at
  )
  from public.invites
  where token = p_token;
$$;

create table if not exists public.invite_replies (
  id           bigserial primary key,
  token        text not null references public.invites(token) on delete cascade,
  client_key   text not null,
  replier_id   uuid references auth.users(id) on delete set null,
  answer       text not null check (answer in ('yes','no')),
  created_at   timestamptz not null default now(),
  seen_at      timestamptz,
  unique (token, client_key)
);
create index if not exists invite_replies_token_idx on public.invite_replies (token, created_at desc);

-- CAS-887: the daily monitor's own "already led a digest" marker, stamped with the service_role
-- key (which bypasses RLS, same as every other table the monitor writes) — never by the anon/
-- authenticated policies below, and never the same column as `seen_at`.
alter table public.invite_replies add column if not exists digested_at timestamptz;

-- CAS-967: the same-day reply-arrived email's own "already told the sender" marker — a third,
-- independent stamp alongside `seen_at` (the app's own read marker, CAS-886) and `digested_at`
-- (the next-morning digest's own marker, CAS-887). None of the three may set another.
alter table public.invite_replies add column if not exists notified_at timestamptz;
create index if not exists invite_replies_unnotified_idx
  on public.invite_replies (created_at) where notified_at is null;

alter table public.invite_replies enable row level security;

drop policy if exists invite_replies_insert on public.invite_replies;

drop policy if exists invite_replies_sender_read on public.invite_replies;
create policy invite_replies_sender_read on public.invite_replies
  for select to authenticated using (
    exists (select 1 from public.invites i
            where i.token = invite_replies.token and i.sender_id = auth.uid()));

drop policy if exists invite_replies_sender_update on public.invite_replies;
create policy invite_replies_sender_update on public.invite_replies
  for update to authenticated using (
    exists (select 1 from public.invites i
            where i.token = invite_replies.token and i.sender_id = auth.uid()));

drop policy if exists invite_replies_client_update on public.invite_replies;

-- CAS-944: upserts on (token, client_key) — a recipient who reloads and answers differently
-- overwrites their own row rather than creating a second one (the same shape CAS-885 built into
-- the policy this replaces). replier_id is set from auth.uid() here, server-side, never trusted
-- from the client. Rate limited to 20/hour per client_key so a stolen or guessed token can't be
-- used to spam replies.
create or replace function public.answer_invite(p_token text, p_client_key text, p_answer text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_answer not in ('yes','no') then
    raise exception 'answer_invite: answer must be yes or no';
  end if;
  if (select count(*) from public.invite_replies
      where client_key = p_client_key and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'answer_invite: rate limit exceeded (20/hour)';
  end if;
  insert into public.invite_replies (token, client_key, answer, replier_id)
  values (p_token, p_client_key, p_answer, auth.uid())
  on conflict (token, client_key) do update
    set answer = excluded.answer, replier_id = excluded.replier_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- recommendations — Recommend Cascade, the send half of Refer a friend (CAS-884/M11)
-- ---------------------------------------------------------------------------
-- Signed-in only (no anonymous path here removes it as an open mail relay). A new hourly
-- workflow (.github/workflows/recommend.yml) reads unsent rows with the service_role key and
-- emails them via monitor/recommend.py; CAS-808 still owns attribution and any reward.
create table if not exists public.recommendations (
  id          bigserial primary key,
  sender_id   uuid not null references auth.users(id) on delete cascade,
  sender_name text,
  to_name     text,
  to_email    text not null,
  message     text not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index if not exists recommendations_unsent_idx
  on public.recommendations (created_at) where sent_at is null;
-- CAS-1092: recommendations_rate_limit() below queries (sender_id, created_at) on every insert.
create index if not exists recommendations_sender_created_idx on public.recommendations (sender_id, created_at);

alter table public.recommendations enable row level security;

drop policy if exists recommendations_owner on public.recommendations;
create policy recommendations_owner on public.recommendations
  for all to authenticated using (auth.uid() = sender_id)
  with check (auth.uid() = sender_id
    and length(to_email) between 3 and 200
    and length(message) between 1 and 2000);

-- security definer: counts every sender_id's own rows to enforce the rate limit, the same
-- 5/hour + 20/day shape as contact_messages_rate_limit above, keyed on sender_id since every
-- row here is authenticated (no client_key to fall back on).
create or replace function public.recommendations_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.recommendations
      where sender_id = new.sender_id and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'recommendations: rate limit exceeded (5/hour)';
  end if;
  if (select count(*) from public.recommendations
      where sender_id = new.sender_id and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'recommendations: rate limit exceeded (20/day)';
  end if;
  return new;
end;
$$;

drop trigger if exists recommendations_rate_limit on public.recommendations;
create trigger recommendations_rate_limit
  before insert on public.recommendations
  for each row execute function public.recommendations_rate_limit();

-- ---------------------------------------------------------------------------
-- invite_emails — the outgoing queue for a multi-recipient Invite's email leg (CAS-930/M12)
-- ---------------------------------------------------------------------------
-- A WhatsApp/SMS recipient's own device app is opened for them; only an email recipient needs
-- Cascade to actually send anything. Queued here rather than sent from the browser (same
-- send-before-ledger discipline as recommendations above), read by the new second step in
-- .github/workflows/recommend.yml (monitor/invitemail.py), which joins back to invites by token
-- for the film + sender context this table does not itself carry.
create table if not exists public.invite_emails (
  id         bigserial primary key,
  token      text not null references public.invites(token) on delete cascade,
  to_email   text not null,
  to_name    text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index if not exists invite_emails_unsent_idx
  on public.invite_emails (created_at) where sent_at is null;

alter table public.invite_emails enable row level security;

-- No sender_id column here (only a token) — ownership is proven the same way
-- invite_replies_sender_read/update above prove it, by joining back to invites.
drop policy if exists invite_emails_owner on public.invite_emails;
create policy invite_emails_owner on public.invite_emails
  for all to authenticated using (
    exists (select 1 from public.invites i
            where i.token = invite_emails.token and i.sender_id = auth.uid())
  ) with check (
    exists (select 1 from public.invites i
            where i.token = invite_emails.token and i.sender_id = auth.uid())
    and length(to_email) between 3 and 200
  );

-- ---------------------------------------------------------------------------
-- friends — the shared recipient picker's own list of people (CAS-928/M12)
-- ---------------------------------------------------------------------------
-- Third-party personal data (someone else's name, email and/or mobile) — never readable by anyone but
-- its owner (CAS-812). Saved automatically the first time they're picked; there is no separate save step.
create table if not exists public.friends (
  id           bigserial primary key,
  owner_id     uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  email        text,
  mobile       text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  constraint friends_need_a_channel check (coalesce(email, mobile) is not null)
);
create index if not exists friends_owner_idx on public.friends (owner_id, last_used_at desc nulls last);
create unique index if not exists friends_owner_email_idx
  on public.friends (owner_id, lower(email)) where email is not null;

alter table public.friends enable row level security;

drop policy if exists friends_owner on public.friends;
create policy friends_owner on public.friends
  for all to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- account_deleted_rows — a hard-delete archive on the account tables (CAS-1092)
-- ---------------------------------------------------------------------------
-- On 2026-09-30 a client sync bug deleted every agent on an account with no way back. This is
-- the safety net: every hard DELETE on the 12 tables below is archived here first, before it is
-- gone. Deliberately NOT on agent_films (derived, high volume), notifications, or any analytics
-- table.
create table if not exists public.account_deleted_rows (
  id           bigserial primary key,
  table_name   text not null,
  row_data     jsonb not null,
  deleted_by   uuid default auth.uid(),
  deleted_role text default current_user,
  deleted_at   timestamptz not null default now()
);
alter table public.account_deleted_rows enable row level security;
-- No client policies — this is a write-only-by-trigger, read-only-by-Lee ledger.

-- security definer: runs as the function's owner so it can insert into account_deleted_rows no
-- matter which table's own RLS-less trigger context invoked it. deleted_role records the CALLING
-- role (via auth.role()), not the definer's own elevated role — inside a security definer
-- trigger `current_user` is always the function's owner. Skips the archive entirely mid a
-- self-service account deletion (CAS-980): delete_my_account() below sets the
-- cascade.account_delete flag before it deletes anything, so a deleted account is not retained.
create or replace function public.archive_deleted_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('cascade.account_delete', true) = 'on' then
    return old;
  end if;
  insert into public.account_deleted_rows (table_name, row_data, deleted_role)
  values (TG_TABLE_NAME, to_jsonb(old), coalesce(auth.role(), current_user));
  return old;
end;
$$;

drop trigger if exists archive_deleted_row on public.cascades;
create trigger archive_deleted_row after delete on public.cascades
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.user_films;
create trigger archive_deleted_row after delete on public.user_films
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.user_prefs;
create trigger archive_deleted_row after delete on public.user_prefs
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.notify_prefs;
create trigger archive_deleted_row after delete on public.notify_prefs
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.film_picks;
create trigger archive_deleted_row after delete on public.film_picks
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.film_watch;
create trigger archive_deleted_row after delete on public.film_watch
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.lists;
create trigger archive_deleted_row after delete on public.lists
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.list_films;
create trigger archive_deleted_row after delete on public.list_films
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.watchlists;
create trigger archive_deleted_row after delete on public.watchlists
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.friends;
create trigger archive_deleted_row after delete on public.friends
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.invites;
create trigger archive_deleted_row after delete on public.invites
  for each row execute function public.archive_deleted_row();

drop trigger if exists archive_deleted_row on public.push_tokens;
create trigger archive_deleted_row after delete on public.push_tokens
  for each row execute function public.archive_deleted_row();

-- security definer, service_role only: the archive is designed to grow forever until swept.
create or replace function public.purge_deleted_rows(p_days int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count int;
begin
  delete from public.account_deleted_rows
  where deleted_at < now() - (p_days || ' days')::interval;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.purge_deleted_rows(int) from public, anon, authenticated;
grant execute on function public.purge_deleted_rows(int) to service_role;

-- ---------------------------------------------------------------------------
-- app_config — server-read, no client write (CAS-1092); seeds min_client_build (CAS-1108)
-- ---------------------------------------------------------------------------
create table if not exists public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;

drop policy if exists app_config_read on public.app_config;
create policy app_config_read on public.app_config
  for select to anon, authenticated using (true);

insert into public.app_config (key, value) values ('min_client_build', '0'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- keep cascades.updated_at honest on every write
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists cascades_set_updated_at on public.cascades;
create trigger cascades_set_updated_at
  before insert or update on public.cascades
  for each row execute function public.set_updated_at();

drop trigger if exists user_films_set_updated_at on public.user_films;
create trigger user_films_set_updated_at
  before insert or update on public.user_films
  for each row execute function public.set_updated_at();

drop trigger if exists notify_prefs_set_updated_at on public.notify_prefs;
create trigger notify_prefs_set_updated_at
  before insert or update on public.notify_prefs
  for each row execute function public.set_updated_at();

drop trigger if exists film_picks_set_updated_at on public.film_picks;
create trigger film_picks_set_updated_at
  before insert or update on public.film_picks
  for each row execute function public.set_updated_at();

drop trigger if exists film_watch_set_updated_at on public.film_watch;
create trigger film_watch_set_updated_at
  before insert or update on public.film_watch
  for each row execute function public.set_updated_at();

drop trigger if exists user_prefs_set_updated_at on public.user_prefs;
create trigger user_prefs_set_updated_at
  before insert or update on public.user_prefs
  for each row execute function public.set_updated_at();

drop trigger if exists lists_set_updated_at on public.lists;
create trigger lists_set_updated_at
  before insert or update on public.lists
  for each row execute function public.set_updated_at();

drop trigger if exists list_films_set_updated_at on public.list_films;
create trigger list_films_set_updated_at
  before insert or update on public.list_films
  for each row execute function public.set_updated_at();

drop trigger if exists watchlists_set_updated_at on public.watchlists;
create trigger watchlists_set_updated_at
  before insert or update on public.watchlists
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- analytics_admins + usage_events read path (CAS-942)
-- ---------------------------------------------------------------------------
-- usage_events (above) is insert-only for anon/authenticated — this is the read side, gated to
-- a small allowlist rather than every signed-in user. RLS enabled, no policy: only service_role
-- (which bypasses RLS) or a row inserted here can ever read it.
create table if not exists public.analytics_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.analytics_admins enable row level security;

-- Lee's auth.users id on project ypccfyatejejslzlfrbf, read from the live database 2026-09-12.
-- Guarded by an existence check: on a brand-new database (e.g. npm run test:integrity's local
-- Supabase stack, CAS-1093) that user doesn't exist yet, and an unconditional insert violates
-- analytics_admins_user_id_fkey.
insert into public.analytics_admins (user_id)
select 'c7e9b361-368f-4488-84b5-baf0ac7a0751'
where exists (select 1 from auth.users where id = 'c7e9b361-368f-4488-84b5-baf0ac7a0751')
on conflict (user_id) do nothing;

-- CAS-1074: repo drift — this policy was applied live but never recorded here. Lets an admin
-- confirm their own admin-ness (e.g. to decide whether to show admin UI) without needing
-- service_role; it grants no visibility into any OTHER row of this table.
drop policy if exists analytics_admins_select_self on public.analytics_admins;
create policy analytics_admins_select_self on public.analytics_admins
  for select to authenticated using (user_id = auth.uid());

drop policy if exists usage_events_select_admin on public.usage_events;
create policy usage_events_select_admin on public.usage_events
  for select to authenticated
  using (exists (select 1 from public.analytics_admins a where a.user_id = auth.uid()));

-- Every view below is `security_invoker = true`, so it runs with the CALLING user's own role and
-- row-security — the usage_events_select_admin policy above is what actually gates them. A
-- non-admin authenticated caller gets zero rows back, not an error; a signed-out (anon) caller has
-- no select grant on usage_events at all, so the same is true for them.

-- analytics_sessions — one row per (client_key, session), with the app_open facts for that
-- session flattened in (a session with no app_open row yet just carries nulls for those columns).
create or replace view public.analytics_sessions
with (security_invoker = true) as
select
  ue.client_key,
  ue.session,
  min(ue.created_at) as first_at,
  max(ue.created_at) as last_at,
  extract(epoch from (max(ue.created_at) - min(ue.created_at)))::bigint as duration_seconds,
  max(ue.user_id::text)::uuid as user_id,
  count(*) as event_count,
  max(ue.data->>'plat') filter (where ue.type = 'app_open') as plat,
  max(ue.data->>'ver')  filter (where ue.type = 'app_open') as ver,
  bool_or((ue.data->>'ret')::boolean) filter (where ue.type = 'app_open') as ret,
  bool_or((ue.data->>'onb')::boolean) filter (where ue.type = 'app_open') as onb,
  max(ue.data#>>'{acq,src}')    filter (where ue.type = 'app_open') as acq_src,
  max(ue.data#>>'{acq,med}')    filter (where ue.type = 'app_open') as acq_med,
  max(ue.data#>>'{acq,cmp}')    filter (where ue.type = 'app_open') as acq_cmp,
  max(ue.data#>>'{acq,con}')    filter (where ue.type = 'app_open') as acq_con,
  max(ue.data#>>'{acq,trm}')    filter (where ue.type = 'app_open') as acq_trm,
  max(ue.data#>>'{acq,ref}')    filter (where ue.type = 'app_open') as acq_ref,
  max(ue.data#>>'{acq,landed}') filter (where ue.type = 'app_open') as acq_landed
from public.usage_events ue
group by ue.client_key, ue.session;

-- analytics_acquisition — by day and by acq source/medium/campaign, off analytics_sessions above.
-- A session with no acq object at all (the very first session on a device, before CAS-940's
-- first-touch capture has written anything to read back) counts as 'direct', per the ticket.
create or replace view public.analytics_acquisition
with (security_invoker = true) as
with signed_up as (
  select distinct client_key from public.usage_events where user_id is not null
)
select
  date_trunc('day', s.first_at)::date as day,
  coalesce(s.acq_src, 'direct') as source,
  coalesce(s.acq_med, '(none)') as medium,
  coalesce(s.acq_cmp, '(none)') as campaign,
  count(*) as sessions,
  count(distinct s.client_key) as devices,
  count(distinct s.client_key)
    filter (where coalesce(s.ret,false) = false) as new_devices,
  count(distinct s.client_key)
    filter (where coalesce(s.ret,false) = false and s.client_key in (select client_key from signed_up))
    as new_devices_signed_up
from public.analytics_sessions s
where s.plat is not null   -- only sessions that actually produced an app_open carry acquisition facts
group by 1,2,3,4;

-- analytics_onboarding_funnel — one row per onboarding step key (whichever keys actually appear
-- in the data, not a hardcoded list), plus splash_shown/splash_cta as the two arrival rows ahead
-- of the first real step.
create or replace view public.analytics_onboarding_funnel
with (security_invoker = true) as
with steps as (
  select distinct data->>'step' as step
  from public.usage_events
  where type in ('onbstep_shown','onbstep_continue','onbstep_skipped')
    and data->>'step' is not null
),
step_counts as (
  select
    s.step,
    count(distinct e.session) filter (where e.type = 'onbstep_shown')    as shown,
    count(distinct e.session) filter (where e.type = 'onbstep_continue') as continued,
    count(distinct e.session) filter (where e.type = 'onbstep_skipped')  as skipped
  from steps s
  left join public.usage_events e
    on e.data->>'step' = s.step
   and e.type in ('onbstep_shown','onbstep_continue','onbstep_skipped')
  group by s.step
),
arrival as (
  select
    'splash_shown'::text as step,
    count(distinct session) filter (where type = 'splash_shown') as shown,
    count(distinct session) filter (where type = 'splash_cta')   as continued,
    0::bigint as skipped
  from public.usage_events
  where type in ('splash_shown','splash_cta')
  union all
  select
    'splash_cta'::text as step,
    count(distinct session) filter (where type = 'splash_cta')     as shown,
    count(distinct session) filter (where type = 'onbstep_shown')  as continued,
    0::bigint as skipped
  from public.usage_events
  where type in ('splash_cta','onbstep_shown')
)
select
  step, shown, continued, skipped,
  case when shown = 0 then null else round(100.0 * (shown - continued) / shown, 1) end as drop_pct
from (
  select * from arrival
  union all
  select * from step_counts
) all_steps;

-- analytics_activation — by day: how many devices reached each activation milestone. The final
-- onboarding step is 'v2_done' per both FLOWS lanes (cinema/stream) as of CAS-911/915 — update
-- this if a future ticket renames it.
create or replace view public.analytics_activation
with (security_invoker = true) as
select
  date_trunc('day', created_at)::date as day,
  count(distinct client_key) filter (where type = 'app_open')    as devices_app_open,
  count(distinct client_key) filter (where type = 'splash_cta')  as devices_splash_cta,
  count(distinct client_key)
    filter (where type = 'onbstep_shown' and data->>'step' = 'v2_done') as devices_finished_onboarding,
  count(distinct client_key)
    filter (where type in ('agent_created','cascade_created')) as devices_created_agent,
  count(distinct client_key) filter (where user_id is not null) as devices_signed_up
from public.usage_events
group by 1;

-- analytics_retention — by first-seen week and platform: cohort size and how many devices came
-- back on exactly day 1, day 7 and day 30 after their very first event (any type, not just app_open).
create or replace view public.analytics_retention
with (security_invoker = true) as
with first_seen as (
  select client_key, min(created_at) as first_at
  from public.usage_events
  group by client_key
),
first_plat as (
  select distinct on (client_key) client_key, data->>'plat' as plat
  from public.usage_events
  where type = 'app_open'
  order by client_key, created_at asc
),
opens as (
  select client_key, created_at from public.usage_events where type = 'app_open'
)
select
  date_trunc('week', fs.first_at)::date as cohort_week,
  coalesce(fp.plat, 'unknown') as plat,
  count(distinct fs.client_key) as cohort_size,
  count(distinct o1.client_key)  as returned_d1,
  count(distinct o7.client_key)  as returned_d7,
  count(distinct o30.client_key) as returned_d30
from first_seen fs
left join first_plat fp on fp.client_key = fs.client_key
left join opens o1  on o1.client_key  = fs.client_key
  and o1.created_at  >= fs.first_at + interval '1 day'  and o1.created_at  < fs.first_at + interval '2 days'
left join opens o7  on o7.client_key  = fs.client_key
  and o7.created_at  >= fs.first_at + interval '7 days' and o7.created_at  < fs.first_at + interval '8 days'
left join opens o30 on o30.client_key = fs.client_key
  and o30.created_at >= fs.first_at + interval '30 days' and o30.created_at < fs.first_at + interval '31 days'
group by 1,2;

-- analytics_feature_usage — per event type over the trailing 28 days, plus card_expand/watch_tab
-- broken out by their own `tab` value as additional rows alongside the plain per-type ones.
create or replace view public.analytics_feature_usage
with (security_invoker = true) as
with base as (
  select type as feature, client_key, user_id, created_at
  from public.usage_events
  where created_at > now() - interval '28 days'
),
tab_breakout as (
  select type || ':' || coalesce(data->>'tab', '(none)') as feature, client_key, user_id, created_at
  from public.usage_events
  where created_at > now() - interval '28 days'
    and type in ('card_expand','watch_tab')
)
select
  feature,
  count(distinct client_key) as devices,
  count(distinct user_id) as users,
  count(*) as events,
  max(created_at) as last_seen_at
from (
  select * from base
  union all
  select * from tab_breakout
) combined
group by feature;

grant select on public.analytics_sessions          to authenticated;
grant select on public.analytics_acquisition       to authenticated;
grant select on public.analytics_onboarding_funnel to authenticated;
grant select on public.analytics_activation        to authenticated;
grant select on public.analytics_retention         to authenticated;
grant select on public.analytics_feature_usage     to authenticated;

-- ---------------------------------------------------------------------------
-- admin_members / admin_member_activity / admin_member_onboarding / admin_member_emails /
-- admin_cascades — the Cascade Admin site's member-list reads (CAS-1074)
-- ---------------------------------------------------------------------------
-- These four existed only live, with NO record in this file, until CAS-1074 (repo drift). All but
-- admin_member_emails ran `security_invoker = true` — the view runs with the CALLING user's own
-- row-security, so the `ag`/cascades read inside admin_members was silently narrowed to the signed-
-- in admin's OWN cascades by cascades_owner's RLS, undercounting every admin's Members/With-an-agent
-- totals. `security_invoker = false` (the default) makes each view run as its OWNER instead, which
-- bypasses RLS on the tables it reads — safe here ONLY because every view ends with its own
-- `exists (select 1 from analytics_admins ...)` guard, so a non-admin caller still gets zero rows,
-- same as admin_member_emails already did live. Do not drop that guard when editing these.
-- admin_cascades is new: the Admin site's all-members cascades count used to read public.cascades
-- directly, which the same cascades_owner RLS also limits to the caller's own rows — an admin view
-- is added here rather than loosening cascades' RLS (out of scope, and would expose ordinary users'
-- own cascades to each other via the app itself, not just the Admin site).
create or replace view public.admin_members
with (security_invoker = false) as
with ev as (
  select
    usage_events.user_id,
    min(usage_events.created_at) as first_seen_at,
    max(usage_events.created_at) as last_seen_at,
    count(*) as events,
    count(distinct usage_events.session) as sessions,
    count(distinct usage_events.client_key) as devices,
    count(distinct date_trunc('day', usage_events.created_at)) as active_days
  from public.usage_events
  where usage_events.user_id is not null
  group by usage_events.user_id
),
ag as (
  select
    cascades.user_id,
    count(*) as agents,
    max(cascades.updated_at) as last_agent_edit
  from public.cascades
  where cascades.deleted_at is null
  group by cascades.user_id
)
select
  coalesce(ev.user_id, ag.user_id) as user_id,
  left(coalesce(ev.user_id, ag.user_id)::text, 8) as short_id,
  ev.first_seen_at, ev.last_seen_at, ev.events, ev.sessions, ev.devices, ev.active_days,
  coalesce(ag.agents, 0) as agents,
  ag.last_agent_edit
from ev
full join ag on ag.user_id = ev.user_id
where exists (select 1 from public.analytics_admins a where a.user_id = auth.uid());

create or replace view public.admin_member_activity
with (security_invoker = false) as
select user_id, type as feature, count(*) as events, min(created_at) as first_at, max(created_at) as last_at
from public.usage_events
where user_id is not null
  and exists (select 1 from public.analytics_admins a where a.user_id = auth.uid())
group by user_id, type;

create or replace view public.admin_member_onboarding
with (security_invoker = false) as
select
  user_id,
  coalesce(data ->> 'step', data ->> 'key', '(unknown)') as step,
  count(*) filter (where type = 'onbstep_shown')    as shown,
  count(*) filter (where type = 'onbstep_continue') as continued,
  count(*) filter (where type = 'onbstep_skipped')  as skipped,
  max(created_at) as last_at
from public.usage_events
where user_id is not null
  and type like 'onbstep_%'
  and exists (select 1 from public.analytics_admins a where a.user_id = auth.uid())
group by user_id, (coalesce(data ->> 'step', data ->> 'key', '(unknown)'));

create or replace view public.admin_member_emails
with (security_invoker = false) as
select id as user_id, email::text as email
from auth.users u
where exists (select 1 from public.analytics_admins a where a.user_id = auth.uid());

-- CAS-1092: cascades can now carry a soft delete (deleted_at); exclude those rows here too.
create or replace view public.admin_cascades
with (security_invoker = false) as
select id, user_id, name, criteria, alert_moments, active, created_at, updated_at
from public.cascades
where deleted_at is null
  and exists (select 1 from public.analytics_admins a where a.user_id = auth.uid());

revoke all on public.admin_members          from anon, public;
revoke all on public.admin_member_activity  from anon, public;
revoke all on public.admin_member_onboarding from anon, public;
revoke all on public.admin_member_emails    from anon, public;
revoke all on public.admin_cascades         from anon, public;

grant select on public.admin_members          to authenticated;
grant select on public.admin_member_activity  to authenticated;
grant select on public.admin_member_onboarding to authenticated;
grant select on public.admin_member_emails    to authenticated;
grant select on public.admin_cascades         to authenticated;

-- ---------------------------------------------------------------------------
-- delete_my_account — self-service account deletion (CAS-980)
-- ---------------------------------------------------------------------------
-- The typed-DELETE confirmation sheet lives in the client; this is the one thing it calls.
-- security definer so it can reach the final `delete from auth.users` (an authenticated caller's
-- own role has no privilege over that table) and the tables above whose owner FK is `on delete set
-- null` rather than `cascade` — usage_events and contact_messages — which the auth.users delete
-- alone would only anonymise, not remove. Every other table the ticket names is ALSO deleted
-- explicitly here even where the auth.users delete below would already cascade it away, so this
-- stays correct if a future migration ever loosens one of those FKs. invite_replies is deleted by
-- replier_id (this user answering someone else's invite) separately from invites by sender_id (this
-- user's own sent invites, which already cascades to that sender's invite_replies/invite_emails
-- rows) since the two are different relationships to the same table. auth.uid() is captured once,
-- up front: once the auth.users row is gone, auth.uid() itself would start reading back null.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'delete_my_account: not signed in';
  end if;

  -- CAS-1092: a deleted account is not retained in account_deleted_rows — set the flag
  -- archive_deleted_row() checks before any of the deletes below run.
  perform set_config('cascade.account_delete', 'on', true);

  delete from public.agent_films      where user_id = uid;
  delete from public.cascades         where user_id = uid;
  delete from public.user_films       where user_id = uid;
  delete from public.film_watch       where user_id = uid;
  delete from public.notifications    where user_id = uid;
  delete from public.usage_events     where user_id = uid;
  delete from public.push_tokens      where user_id = uid;
  delete from public.friends          where owner_id = uid;
  delete from public.invites          where sender_id = uid;
  delete from public.invite_replies   where replier_id = uid;
  delete from public.contact_messages where user_id = uid;
  delete from public.analytics_admins where user_id = uid;

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------
-- complete_membership / email_has_account — server-first onboarding (CAS-1098)
-- ---------------------------------------------------------------------------
-- There is no partly-signed-up state (product rule, Lee, 2026-09-30): agents built in onboarding
-- exist only if membership completes; otherwise they are lost. The onboarding draft used to reach
-- the server through the generic sync before the account was loaded, which duplicated agents on
-- existing accounts and dropped onboarding's services and occasions. complete_membership() is now
-- the ONLY way that draft reaches the server: one transaction, all of it or none of it, and an
-- existing account keeps what it has — the draft is discarded, never merged.
alter table public.user_prefs add column if not exists membership_completed_at timestamptz;

update public.user_prefs
set membership_completed_at = coalesce(membership_completed_at, updated_at, now())
where membership_completed_at is null;

-- security invoker: each table's own RLS (cascades_owner, user_prefs_owner, notify_prefs_owner)
-- already confines every write below to auth.uid(), so this runs as the calling user rather than
-- needing elevated rights.
create or replace function public.complete_membership(p jsonb)
returns text
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- An existing account (in ANY of the six tables an onboarding draft could touch) keeps what
  -- it has; the draft is discarded, never merged. Deleted cascades rows still count — a soft
  -- delete is still "this account already exists".
  if exists (select 1 from public.cascades     where user_id = auth.uid())
     or exists (select 1 from public.user_prefs   where user_id = auth.uid())
     or exists (select 1 from public.notify_prefs where user_id = auth.uid())
     or exists (select 1 from public.user_films   where user_id = auth.uid())
     or exists (select 1 from public.film_picks   where user_id = auth.uid())
     or exists (select 1 from public.film_watch   where user_id = auth.uid())
  then
    return 'account_exists';
  end if;

  insert into public.cascades (id, user_id, name, criteria, alert_moments, active)
  select
    (elem->>'id')::uuid,
    auth.uid(),
    coalesce(elem->>'name', 'My agent'),
    coalesce(elem->'criteria', '{}'::jsonb),
    coalesce((select array_agg(v) from jsonb_array_elements_text(elem->'alert_moments') as v),
             '{hits_rent,hits_stream}'::text[]),
    coalesce((elem->>'active')::boolean, true)
  from jsonb_array_elements(coalesce(p->'agents', '[]'::jsonb)) as elem;

  insert into public.user_prefs (
    user_id, sub_services, store_services, services_only, taste, watch_windows,
    occasions, touched, never_show, onb_depth, framing, membership_completed_at
  ) values (
    auth.uid(),
    coalesce((select array_agg(v) from jsonb_array_elements_text(p->'prefs'->'sub_services') as v),
             '{}'::text[]),
    coalesce((select array_agg(v) from jsonb_array_elements_text(p->'prefs'->'store_services') as v),
             '{}'::text[]),
    coalesce((p->'prefs'->>'services_only')::boolean, false),
    coalesce(p->'prefs'->'taste', '{}'::jsonb),
    coalesce(p->'prefs'->'watch_windows', '{}'::jsonb),
    p->'prefs'->'occasions',
    (p->'prefs'->>'touched')::boolean,
    (select array_agg(v) from jsonb_array_elements_text(p->'prefs'->'never_show') as v),
    p->'prefs'->>'onb_depth',
    (p->'prefs'->>'framing')::boolean,
    now()
  )
  on conflict (user_id) do update set
    sub_services             = excluded.sub_services,
    store_services            = excluded.store_services,
    services_only             = excluded.services_only,
    taste                     = excluded.taste,
    watch_windows             = excluded.watch_windows,
    occasions                 = excluded.occasions,
    touched                   = excluded.touched,
    never_show                = excluded.never_show,
    onb_depth                 = excluded.onb_depth,
    framing                   = excluded.framing,
    membership_completed_at   = excluded.membership_completed_at;

  insert into public.notify_prefs (user_id, in_app, email_on, email_address, excluded_moments)
  values (
    auth.uid(),
    coalesce((p->'notify'->>'in_app')::boolean, true),
    coalesce((p->'notify'->>'email_on')::boolean, false),
    p->'notify'->>'email_address',
    coalesce((select array_agg(v) from jsonb_array_elements_text(p->'notify'->'excluded_moments') as v),
             '{}'::text[])
  )
  on conflict (user_id) do update set
    in_app            = excluded.in_app,
    email_on          = excluded.email_on,
    email_address     = excluded.email_address,
    excluded_moments  = excluded.excluded_moments;

  return 'created';
end;
$$;

revoke all on function public.complete_membership(jsonb) from public;
grant execute on function public.complete_membership(jsonb) to authenticated;

-- security definer so it can read auth.users (an authenticated/anon caller's own role has no
-- privilege over that table); the boolean it reveals is a deliberate, Lee-accepted narrowing for
-- Sign in (CAS-1088), not a leak.
create or replace function public.email_has_account(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then
    return false;
  end if;

  return exists (select 1 from public.user_prefs
                 where user_id = uid and membership_completed_at is not null)
      or exists (select 1 from public.cascades where user_id = uid);
end;
$$;

revoke all on function public.email_has_account(text) from public;
grant execute on function public.email_has_account(text) to anon, authenticated;

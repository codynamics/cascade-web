# Supabase backend — Cascade Web

This folder holds the database schema for the live, account-based Cascade service — the
backend surface the browser talks to, plus the ledger the daily monitoring job writes.

- **`schema.sql`** — the full current state of the schema (every table, RLS policy, trigger,
  index, function and view). Updated in the **same commit** as every migration below, so it is
  always the single, up-to-date source of truth — never apply it partially or read it as a diff.
- **`migrations/NNNN_<name>.sql`** — the numbered, ordered history of how the live database got
  to that state. Each migration is a standalone file, safe to re-run (`create ... if not exists`,
  `drop ... if exists` before every `create`, etc.), and records itself in
  `public.schema_migrations` on success.

> The full one-time account setup (create the Supabase project, enable magic-link auth, create
> Resend, add the GitHub Actions secrets, fill `config.js`) lives in **`SETUP-cascade-web.md`**.
> This file covers just the database step.

## Environments (CAS-1521)

There are two Supabase projects: **production** (`ypccfyatejejslzlfrbf`) and **staging**
(`oenvezqluwqdwlzfhisc`). Apply every migration to both, staging first. The tracked `config.js` holds
both projects' anon keys and picks one at load:

1. `cascademovies.com` / `www.cascademovies.com` → production.
2. Otherwise `window.CASCADE_ENV` if set — the iOS build's `environment` input (`ios-testflight.yml`)
   writes it to `www/env.js`, loaded before `config.js` in the bundled app only.
3. Otherwise → staging (`*.pages.dev` previews, localhost, Playwright).

The result is `window.CASCADE_CONFIG.ENV`, shown in the footer build stamp and the diagnostics panel.
`tests/js/env-config.test.mjs` pins the mapping. Only anon keys ever go in `config.js`.

### Staging is migrated automatically (CAS-1546)

`.github/workflows/migrate-staging.yml` runs on every push to `staging` that touches
`supabase/migrations/**` (and on manual dispatch). It applies each migration not yet recorded in
staging's `public.schema_migrations`, in filename order, via `ci/migrate_staging.py` using the
`SUPABASE_DB_URL` secret of the `staging` GitHub Environment. It refuses to run against the
production ref. **Production is migrated only by the gated release step — never by this workflow.**

## How to apply a change (Lee — one time per migration)

1. Open the Supabase project → **SQL Editor** → **New query**.
2. Apply every file under `migrations/` **in number order** that is not yet recorded in
   `public.schema_migrations` (`select version from public.schema_migrations order by version;`).
   Paste one file's contents and click **Run**, then move to the next number.
3. `schema.sql` needs nothing further applied — it is kept in sync with the migrations in the
   same commit, so once every migration up to the latest number has run, the live project already
   matches it. It exists as the single readable end-state, and as the script to run against a
   brand-new project instead of replaying every migration from scratch.

> CC (the build agent) never runs SQL against a live project — it validates every file offline
> against the PostgreSQL grammar (`pglast`) and never applies anything itself. Applying a
> migration to the live project is always a Lee step.

## Adding a new schema change

1. Write `migrations/NNNN_<name>.sql` (next number after the highest one present), ending with
   `insert into public.schema_migrations(version) values ('NNNN') on conflict do nothing;`.
   Idempotent, so it is safe to re-run.
2. Make the same change in `schema.sql`, in the same commit, so the two never drift (CAS-1074 was
   exactly this kind of drift — a change applied live with no record in either file).
3. `git diff --stat` for the commit should show only `supabase/` (and, when a migration is
   asserted by a test, `tests/`) — a migration never touches runtime code.

## Notes

- `gen_random_uuid()` comes from the `pgcrypto` extension (pre-installed on Supabase; the script
  enables it defensively so the file also works on a plain Postgres).
- `updated_at` on the tables that carry it is kept current automatically by each table's own
  `set_updated_at` trigger (fires on both insert and update since CAS-1092), so the app never has
  to set it by hand.
- Deleting a user (`auth.users`) cascades to their owned rows (`on delete cascade`); most hard
  deletes on the account tables are archived first into `account_deleted_rows` (CAS-1092) — see
  `schema.sql`'s header for exactly which tables and which are deliberately excluded.

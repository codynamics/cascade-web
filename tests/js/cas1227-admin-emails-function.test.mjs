// tests/js/cas1227-admin-emails-function.test.mjs — CAS-1227: admin_member_emails must no longer
// be a view selecting directly from auth.users (Supabase's auth_users_exposed CRITICAL alert).
// After migration 0007, an admin caller must still read every member's row from
// admin_member_emails (via the admin_member_emails_list() SECURITY DEFINER function), a non-admin
// must get zero rows, and anon must be denied outright — same external behaviour as CAS-1074,
// different internals. Also asserts no public view depends on auth.users any more, and that all
// five admin views are read-only (SELECT only) for `authenticated`. Runs the real migration files
// (supabase/migrations/0000_cas1074_admin_views_guard.sql then 0007_admin_emails_function.sql)
// against an in-process real Postgres engine (pglite), on top of a minimal fixture mirroring the
// relevant slice of supabase/schema.sql — not a text-grep of the SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION_0000 = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '0000_cas1074_admin_views_guard.sql'),
  'utf8'
);
const MIGRATION_0007 = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '0007_admin_emails_function.sql'),
  'utf8'
);

const ADMIN   = '11111111-1111-1111-1111-111111111111';
const MEMBER1 = '22222222-2222-2222-2222-222222222222';
const MEMBER2 = '33333333-3333-3333-3333-333333333333';

const ADMIN_VIEWS = [
  'admin_members',
  'admin_member_activity',
  'admin_member_onboarding',
  'admin_member_emails',
  'admin_cascades',
];

async function asRole(db, role, sub) {
  await db.exec(`set role ${role};`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub ?? '']);
}

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });

  // Minimal fixture: only the objects the migrations themselves touch or depend on, mirroring
  // the real supabase/schema.sql definitions (cascades, usage_events, analytics_admins,
  // schema_migrations + their RLS), plus an auth.users/auth.uid() stub standing in for Supabase
  // Auth.
  await db.exec(`
    create extension if not exists pgcrypto;

    create schema auth;
    create table auth.users (
      id    uuid primary key,
      email text
    );
    create function auth.uid() returns uuid
    language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    create role anon;
    create role authenticated;
    grant usage on schema public to anon, authenticated;

    create table public.schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    );
    alter table public.schema_migrations enable row level security;

    create table public.cascades (
      id            uuid primary key default gen_random_uuid(),
      user_id       uuid not null references auth.users(id) on delete cascade,
      name          text not null default 'My agent',
      criteria      jsonb not null default '{}'::jsonb,
      alert_moments text[] not null default '{hits_rent,hits_stream}',
      active        boolean not null default true,
      created_at    timestamptz not null default now(),
      updated_at    timestamptz not null default now()
    );
    alter table public.cascades enable row level security;
    create policy cascades_owner on public.cascades
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
    grant select, insert, update, delete on public.cascades to authenticated;

    create table public.usage_events (
      id         bigserial primary key,
      user_id    uuid references auth.users(id) on delete set null,
      client_key text not null,
      session    text,
      type       text not null,
      data       jsonb,
      created_at timestamptz not null default now()
    );
    alter table public.usage_events enable row level security;
    grant select on public.usage_events to authenticated;

    create table public.analytics_admins (
      user_id uuid primary key references auth.users(id) on delete cascade
    );
    alter table public.analytics_admins enable row level security;
    grant select on public.analytics_admins to authenticated;

    create policy usage_events_select_admin on public.usage_events
      for select to authenticated
      using (exists (select 1 from public.analytics_admins a where a.user_id = auth.uid()));
  `);

  // The migrations under test, in sequence — CAS-1074's original guard, then CAS-1227's function
  // split — not a re-derivation of either.
  await db.exec(MIGRATION_0000);
  await db.exec(MIGRATION_0007);

  // Seed 3 users: one admin, two ordinary members.
  await db.query('insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)', [
    ADMIN, 'admin@example.com',
    MEMBER1, 'member1@example.com',
    MEMBER2, 'member2@example.com',
  ]);
  await db.query('insert into public.analytics_admins (user_id) values ($1)', [ADMIN]);

  await db.query(
    'insert into public.cascades (user_id, name) values ($1,$2), ($1,$3), ($4,$5)',
    [MEMBER1, 'Agent A', 'Agent B', MEMBER2, 'Agent C']
  );

  await db.query(
    `insert into public.usage_events (user_id, client_key, type, data) values
       ($1, 'k-admin',   'app_open', '{}'),
       ($2, 'k-member1', 'app_open', '{}'),
       ($3, 'k-member2', 'app_open', '{}')`,
    [ADMIN, MEMBER1, MEMBER2]
  );

  return db;
}

test('CAS-1227 AC1: admin reads every member row from admin_member_emails', async () => {
  const db = await setup();
  try {
    await asRole(db, 'authenticated', ADMIN);
    const emails = await db.query('select * from public.admin_member_emails order by email');
    assert.equal(emails.rows.length, 3, 'admin_member_emails must return all 3 seeded users');
    assert.deepEqual(
      emails.rows.map((r) => r.email),
      ['admin@example.com', 'member1@example.com', 'member2@example.com']
    );
  } finally {
    await db.close();
  }
});

test('CAS-1227 AC1: a non-admin gets zero rows from admin_member_emails', async () => {
  const db = await setup();
  try {
    await asRole(db, 'authenticated', MEMBER1);
    const res = await db.query('select * from public.admin_member_emails');
    assert.equal(res.rows.length, 0, 'admin_member_emails must return zero rows to a non-admin');
  } finally {
    await db.close();
  }
});

test('CAS-1227 AC1: anon is denied outright on admin_member_emails', async () => {
  const db = await setup();
  try {
    await asRole(db, 'anon', null);
    await assert.rejects(
      () => db.query('select * from public.admin_member_emails'),
      /permission denied/i,
      'anon must be denied on admin_member_emails'
    );
  } finally {
    await db.close();
  }
});

test('CAS-1227 AC2: no public view depends on auth.users', async () => {
  const db = await setup();
  try {
    const res = await db.query(`
      select distinct v.relname
      from pg_depend d
      join pg_rewrite r on r.oid = d.objid
      join pg_class v on v.oid = r.ev_class
      join pg_namespace vn on vn.oid = v.relnamespace
      where vn.nspname = 'public'
        and v.relkind in ('v','m')
        and d.refobjid = 'auth.users'::regclass
    `);
    assert.equal(res.rows.length, 0, 'no public view should depend on auth.users after CAS-1227');
  } finally {
    await db.close();
  }
});

test('CAS-1227 AC3: all five admin views are read-only (SELECT only) for authenticated', async () => {
  const db = await setup();
  try {
    for (const view of ADMIN_VIEWS) {
      const select = await db.query(
        `select has_table_privilege('authenticated', $1, 'SELECT') as ok`, [`public.${view}`]
      );
      assert.equal(select.rows[0].ok, true, `${view} must grant SELECT to authenticated`);

      for (const priv of ['INSERT', 'UPDATE', 'DELETE']) {
        const res = await db.query(
          `select has_table_privilege('authenticated', $1, $2) as ok`, [`public.${view}`, priv]
        );
        assert.equal(res.rows[0].ok, false, `${view} must not grant ${priv} to authenticated`);
      }
    }
  } finally {
    await db.close();
  }
});

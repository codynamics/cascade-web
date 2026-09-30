// tests/js/cas1074-admin-views.test.mjs — CAS-1074: admin_members/admin_member_activity/
// admin_member_onboarding/admin_member_emails/admin_cascades must return EVERY member's rows to
// an admin (not just the signed-in admin's own, the security_invoker=true bug) and ZERO rows to a
// non-admin, with anon denied outright. Runs the real migration file (supabase/migrations/
// 0000_cas1074_admin_views_guard.sql — brought into the numbered migration sequence unchanged by
// CAS-1092) against an in-process real Postgres engine (pglite), on top of a minimal fixture
// mirroring the relevant slice of supabase/schema.sql — not a text-grep of the SQL (AC1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION_SQL = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '0000_cas1074_admin_views_guard.sql'),
  'utf8'
);

const ADMIN   = '11111111-1111-1111-1111-111111111111';
const MEMBER1 = '22222222-2222-2222-2222-222222222222';
const MEMBER2 = '33333333-3333-3333-3333-333333333333';

const ADMIN_OBJECTS = [
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

  // Minimal fixture: only the objects the migration itself touches or depends on, mirroring the
  // real supabase/schema.sql definitions (cascades, usage_events, analytics_admins + their RLS),
  // plus an auth.users/auth.uid() stub standing in for Supabase Auth.
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

  // The migration under test — CAS-1074's actual deliverable, not a re-derivation of it.
  await db.exec(MIGRATION_SQL);

  // Seed 3 users: one admin, two ordinary members.
  await db.query('insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)', [
    ADMIN, 'admin@example.com',
    MEMBER1, 'member1@example.com',
    MEMBER2, 'member2@example.com',
  ]);
  await db.query('insert into public.analytics_admins (user_id) values ($1)', [ADMIN]);

  // Cascades: member1 has 2 agents, member2 has 1, admin has 0 — so "with an agent" only reads
  // right if the aggregate isn't silently narrowed to the admin's own (zero) rows.
  await db.query(
    'insert into public.cascades (user_id, name) values ($1,$2), ($1,$3), ($4,$5)',
    [MEMBER1, 'Agent A', 'Agent B', MEMBER2, 'Agent C']
  );

  // usage_events: all three users get an app_open (so admin_members' `ev` CTE includes all three);
  // member1 also gets a card_expand and an onboarding step pair, member2 and admin get neither.
  await db.query(
    `insert into public.usage_events (user_id, client_key, type, data) values
       ($1, 'k-admin',   'app_open', '{}'),
       ($2, 'k-member1', 'app_open', '{}'),
       ($2, 'k-member1', 'card_expand', '{}'),
       ($2, 'k-member1', 'onbstep_shown', '{"step":"step1"}'),
       ($2, 'k-member1', 'onbstep_continue', '{"step":"step1"}'),
       ($3, 'k-member2', 'app_open', '{}')`,
    [ADMIN, MEMBER1, MEMBER2]
  );

  return db;
}

test('CAS-1074: admin sees every member, not just their own rows', async () => {
  const db = await setup();
  try {
    await asRole(db, 'authenticated', ADMIN);

    const members = await db.query('select * from public.admin_members');
    assert.equal(members.rows.length, 3, 'admin_members must return all 3 seeded users, not just the admin');
    const agentsByUser = Object.fromEntries(members.rows.map((r) => [r.user_id, Number(r.agents)]));
    assert.equal(agentsByUser[MEMBER1], 2);
    assert.equal(agentsByUser[MEMBER2], 1);
    assert.equal(agentsByUser[ADMIN], 0);

    const activity = await db.query('select * from public.admin_member_activity');
    // One row per (user, event type): admin/app_open, member2/app_open, and member1's four
    // (app_open, card_expand, onbstep_shown, onbstep_continue).
    assert.equal(activity.rows.length, 6);

    const onboarding = await db.query('select * from public.admin_member_onboarding');
    assert.equal(onboarding.rows.length, 1);
    assert.equal(onboarding.rows[0].user_id, MEMBER1);
    assert.equal(Number(onboarding.rows[0].shown), 1);
    assert.equal(Number(onboarding.rows[0].continued), 1);

    const emails = await db.query('select * from public.admin_member_emails');
    assert.equal(emails.rows.length, 3, 'admin_member_emails must return all 3 seeded users');

    const cascades = await db.query('select * from public.admin_cascades');
    assert.equal(cascades.rows.length, 3, 'admin_cascades must return all 3 seeded cascades across every member');
  } finally {
    await db.close();
  }
});

test('CAS-1074: a non-admin gets zero rows from every admin view', async () => {
  const db = await setup();
  try {
    await asRole(db, 'authenticated', MEMBER1);
    for (const view of ADMIN_OBJECTS) {
      const res = await db.query(`select * from public.${view}`);
      assert.equal(res.rows.length, 0, `${view} must return zero rows to a non-admin`);
    }
  } finally {
    await db.close();
  }
});

test('CAS-1074: a non-admin still sees only their own rows on the underlying table', async () => {
  const db = await setup();
  try {
    await asRole(db, 'authenticated', MEMBER1);
    const own = await db.query('select * from public.cascades');
    assert.equal(own.rows.length, 2, 'member1 must see only their own 2 cascades, never member2\'s or the admin\'s');
    assert.ok(own.rows.every((r) => r.user_id === MEMBER1));
  } finally {
    await db.close();
  }
});

test('CAS-1074: anon is denied outright on every admin view', async () => {
  const db = await setup();
  try {
    await asRole(db, 'anon', null);
    for (const view of ADMIN_OBJECTS) {
      await assert.rejects(
        () => db.query(`select * from public.${view}`),
        /permission denied/i,
        `anon must be denied on ${view}`
      );
    }
  } finally {
    await db.close();
  }
});

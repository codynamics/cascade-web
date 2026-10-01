// tests/rls/matrix.mjs — CAS-949: RLS regression suite, run as the anonymous role against the
// LIVE Supabase project (no secret needed — the anon key is already public in config.js, and
// every probe below is one RLS is supposed to reject; a passing run writes nothing).
//
// The table list is derived from supabase/schema.sql at runtime (regex over `create table if
// not exists public.<name> (...)`), not hardcoded, so a new table with no policy fails the day
// it is added (AC3). Column names/types are parsed from the same block — the live REST OpenAPI
// root doc (GET /rest/v1/) requires the service_role key ("Only the `service_role` API key can
// be used for this endpoint"), so schema.sql is the only source available to an anon-only run.
// A table present in schema.sql but not yet applied to the live project (e.g. `friends`,
// `analytics_admins` as of this writing) answers every request 404 PGRST205 — reported as a
// distinct SKIPPED result, never a pass or a failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const configSrc = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
const urlMatch = configSrc.match(/SUPABASE_URL:\s*"([^"]+)"/);
const keyMatch = configSrc.match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/);
if (!urlMatch || !keyMatch) {
  throw new Error('tests/rls/matrix.mjs: could not read SUPABASE_URL/SUPABASE_ANON_KEY from config.js');
}
const REST = `${urlMatch[1]}/rest/v1`;
const ANON_KEY = keyMatch[1];

const schemaSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');

// One probe value per detected column "kind" — none of them can ever match a real row, so even
// a misconfigured (`using (true)`) policy can only touch rows that do not exist.
const PROBE_VALUE = { uuid: '00000000-0000-0000-0000-000000000000', int: '-1', text: '__cas949_rls_probe_no_match__' };
const ANCHOR_PRIORITY = ['id', 'user_id', 'token', 'owner_id', 'sender_id'];

function parseTables(src) {
  const tables = {};
  const re = /create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(src))) {
    const [, name, body] = m;
    let depth = 0, cur = '';
    const parts = [];
    for (const ch of body) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);

    const columns = [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (/^(primary key|unique|constraint|check)\b/.test(lower)) continue; // table-level, not a column
      const colName = trimmed.split(/\s+/)[0];
      const rest = trimmed.slice(colName.length).trim().toLowerCase();
      let kind = 'text';
      if (/^uuid/.test(rest)) kind = 'uuid';
      else if (/^(bigint|bigserial|int|integer|numeric|serial)/.test(rest)) kind = 'int';
      else if (/^boolean/.test(rest)) kind = 'bool';
      columns.push({ name: colName, kind });
    }
    tables[name] = columns;
  }
  return tables;
}

const TABLES = parseTables(schemaSrc);

// CAS-1141: app_config carries a deliberate `for select to anon` policy (min_client_build must
// be readable before sign-in, CAS-1092/CAS-1108) — the only such table in schema.sql. Track it
// explicitly so a new anon-read table is a decision (via checkPublicReadConsistency), not a
// silent pass, and so app_config's own anon SELECT verdicts PASS instead of FAIL.
export const PUBLIC_READ = new Set(['app_config']);

export function parsePublicReadTables(src) {
  const tables = new Set();
  const re = /create policy\s+\S+\s+on\s+public\.(\w+)\s+for\s+select\s+to\s+([^\n;]+)/gi;
  let m;
  while ((m = re.exec(src))) {
    const [, table, roles] = m;
    if (/\banon\b/i.test(roles)) tables.add(table);
  }
  return tables;
}

export function checkPublicReadConsistency(parsed, declared = PUBLIC_READ) {
  const errors = [];
  for (const table of parsed) {
    if (!declared.has(table)) errors.push(`app_config_read-style policy on ${table} is not in PUBLIC_READ`);
  }
  for (const table of declared) {
    if (!parsed.has(table)) errors.push(`PUBLIC_READ names ${table} which has no anon select policy`);
  }
  return errors;
}

export function selectVerdict(table, total, publicRead = PUBLIC_READ) {
  if (publicRead.has(table)) {
    if (total > 0) return { verdict: 'PASS', detail: 'expected public' };
    return { verdict: 'FAIL', detail: 'anon SELECT was rejected but the client needs this read' };
  }
  if (total === 0) return { verdict: 'PASS' };
  return { verdict: 'FAIL', detail: `anon SELECT returned ${total ?? 'an unknown number of'} row(s)` };
}

function authHeaders(extra = {}) {
  return { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, ...extra };
}

function anchorFor(columns) {
  if (columns.length === 0) return null;
  const preferredName = ANCHOR_PRIORITY.find((n) => columns.some((c) => c.name === n));
  const col = preferredName ? columns.find((c) => c.name === preferredName) : columns[0];
  return { name: col.name, value: PROBE_VALUE[col.kind] };
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

function rangeTotal(res) {
  const range = res.headers.get('content-range');
  if (!range) return null;
  const total = range.split('/')[1];
  return total === '*' ? null : Number(total);
}

async function countTable(table) {
  const res = await fetch(`${REST}/${table}?select=*&limit=1`, { headers: authHeaders({ Prefer: 'count=exact' }) });
  if (res.status === 404) return null;
  return rangeTotal(res);
}

async function probeSelect(table) {
  const res = await fetch(`${REST}/${table}?select=*&limit=5`, { headers: authHeaders({ Prefer: 'count=exact' }) });
  if (res.status === 404) return { verdict: 'SKIPPED', detail: 'not deployed (PGRST205)' };
  const total = rangeTotal(res);
  return selectVerdict(table, total, PUBLIC_READ);
}

function insertBody(table, columns) {
  // Two tables intentionally accept anon INSERT (usage_events, contact_messages) behind a
  // WITH CHECK cap (CAS-948). Per this ticket's own change note, probe those with a payload the
  // check must reject rather than a valid one, so a passing run never leaves a row behind.
  if (table === 'usage_events') {
    return { client_key: '__cas949_rls_probe__', type: 'x'.repeat(65) }; // length(type) <= 64
  }
  if (table === 'contact_messages') {
    return { client_key: '__cas949_rls_probe__', category: '__cas949_invalid__', message: 'rls probe' }; // category enum
  }
  const body = {};
  for (const { name, kind } of columns) body[name] = PROBE_VALUE[kind];
  return body;
}

async function probeInsert(table, columns) {
  const res = await fetch(`${REST}/${table}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(insertBody(table, columns)),
  });
  if (res.status === 404) return { verdict: 'SKIPPED', detail: 'not deployed (PGRST205)' };
  if (res.ok) return { verdict: 'FAIL', detail: `anon INSERT unexpectedly succeeded (status ${res.status})` };
  return { verdict: 'PASS' };
}

async function probeUpdate(table, anchor) {
  if (!anchor) return { verdict: 'SKIPPED', detail: 'no columns to anchor an update' };
  const res = await fetch(`${REST}/${table}?${anchor.name}=eq.${encodeURIComponent(anchor.value)}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json', Prefer: 'count=exact,return=minimal' }),
    body: JSON.stringify({ [anchor.name]: anchor.value }),
  });
  if (res.status === 404) return { verdict: 'SKIPPED', detail: 'not deployed (PGRST205)' };
  if (!res.ok) return { verdict: 'PASS' };
  const total = rangeTotal(res);
  if (!total) return { verdict: 'PASS' };
  return { verdict: 'FAIL', detail: `anon UPDATE affected ${total} row(s)` };
}

async function probeDelete(table, anchor) {
  if (!anchor) return { verdict: 'SKIPPED', detail: 'no columns to anchor a delete' };
  const res = await fetch(`${REST}/${table}?${anchor.name}=eq.${encodeURIComponent(anchor.value)}`, {
    method: 'DELETE',
    headers: authHeaders({ Prefer: 'count=exact,return=minimal' }),
  });
  if (res.status === 404) return { verdict: 'SKIPPED', detail: 'not deployed (PGRST205)' };
  if (!res.ok) return { verdict: 'PASS' };
  const total = rangeTotal(res);
  if (!total) return { verdict: 'PASS' };
  return { verdict: 'FAIL', detail: `anon DELETE affected ${total} row(s)` };
}

async function probeInviteByToken() {
  const res = await fetch(`${REST}/rpc/invite_by_token`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ p_token: '__cas949_probe_nonexistent__' }),
  });
  const body = await safeJson(res);
  if (res.ok && body === null) return { verdict: 'PASS' };
  return { verdict: 'FAIL', detail: `invite_by_token(random) -> status ${res.status}, body ${JSON.stringify(body)}` };
}

async function probeAnswerInvite() {
  const res = await fetch(`${REST}/rpc/answer_invite`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ p_token: '__cas949_probe_nonexistent__', p_client_key: '__cas949_probe__', p_answer: 'yes' }),
  });
  if (!res.ok) return { verdict: 'PASS' };
  return { verdict: 'FAIL', detail: `answer_invite(unknown token) unexpectedly succeeded (status ${res.status})` };
}

async function probeDeleteMyAccount() {
  // CAS-980: not signed in (no Authorization other than the bare anon key), so a correctly
  // gated function must refuse before it ever reaches its own `uid is null` check — either the
  // REVOKE/GRANT denies EXECUTE outright, or auth.uid() reads null and it raises. Either way,
  // an anon caller must never get a 2xx from this. The SQL is a Lee-gated live-apply step
  // (CAS-980), so a 404 ahead of that apply is expected and reported as SKIPPED, not a failure.
  const res = await fetch(`${REST}/rpc/delete_my_account`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  if (res.status === 404) return { verdict: 'SKIPPED', detail: 'not deployed (PGRST202)' };
  if (res.ok) return { verdict: 'FAIL', detail: `delete_my_account() unexpectedly succeeded for anon (status ${res.status})` };
  return { verdict: 'PASS' };
}

async function main() {
  const mismatches = checkPublicReadConsistency(parsePublicReadTables(schemaSrc), PUBLIC_READ);
  if (mismatches.length > 0) {
    for (const msg of mismatches) console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }

  const stabilityTables = ['invites', 'invite_replies'];
  const before = {};
  for (const t of stabilityTables) before[t] = await countTable(t);

  const results = [];
  for (const [table, columns] of Object.entries(TABLES)) {
    const anchor = anchorFor(columns);
    const sel = await probeSelect(table);
    results.push({ table, op: 'SELECT', ...sel });
    if (sel.verdict === 'SKIPPED') {
      results.push({ table, op: 'INSERT', verdict: 'SKIPPED', detail: sel.detail });
      results.push({ table, op: 'UPDATE', verdict: 'SKIPPED', detail: sel.detail });
      results.push({ table, op: 'DELETE', verdict: 'SKIPPED', detail: sel.detail });
      continue;
    }
    results.push({ table, op: 'INSERT', ...(await probeInsert(table, columns)) });
    results.push({ table, op: 'UPDATE', ...(await probeUpdate(table, anchor)) });
    results.push({ table, op: 'DELETE', ...(await probeDelete(table, anchor)) });
  }

  results.push({ table: 'rpc:invite_by_token', op: 'CALL', ...(await probeInviteByToken()) });
  results.push({ table: 'rpc:answer_invite', op: 'CALL', ...(await probeAnswerInvite()) });
  results.push({ table: 'rpc:delete_my_account', op: 'CALL', ...(await probeDeleteMyAccount()) });

  for (const t of stabilityTables) {
    const after = await countTable(t);
    if (before[t] === null || after === null) {
      results.push({ table: t, op: 'ROW-COUNT', verdict: 'SKIPPED', detail: 'not deployed (PGRST205)' });
    } else if (before[t] === after) {
      results.push({ table: t, op: 'ROW-COUNT', verdict: 'PASS' });
    } else {
      results.push({ table: t, op: 'ROW-COUNT', verdict: 'FAIL', detail: `row count changed: ${before[t]} -> ${after}` });
    }
  }

  let failed = 0;
  for (const r of results) {
    console.log(`[${r.verdict}] ${r.table} ${r.op}${r.detail ? ' — ' + r.detail : ''}`);
    if (r.verdict === 'FAIL') failed++;
  }
  console.log(`\n${results.length} checks, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

// Guarded so importing this module (tests/rls/matrix.test.mjs) for the pure parsing/verdict
// functions never triggers a live network run — only `node tests/rls/matrix.mjs` itself does.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('tests/rls/matrix.mjs crashed:', err);
    process.exit(1);
  });
}

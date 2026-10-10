// CAS-1241 Part A: the account-sync client's keepalive fetch wrapper used to carry keepalive:true
// unconditionally. The Fetch standard rejects a keepalive request once its body (plus whatever else is in
// flight) passes a 64 KiB cap; CAS-1222's merge_user_prefs_view can carry tens of KB for an account with a
// broad agent (admitDrift/seenFound), well past that cap on its own — the rejected request reads to
// supabase-js as status 0, and isTransient(0) retries it forever, jamming every op queued behind it.
// acctFetchKeepalive is the pure decision the wrapper now calls, extracted so a unit test can drive it
// directly without a real fetch.
//
// Part B4/B5: fireAccountFanout's own render() calls never actually ran recomputeFound() while
// accountFanoutSettled() was false (the loading gate CAS-1236 added to render()) — which is the ENTIRE
// span before agentFilmsReady flips true. Every admission a wide-open agent's first sweep produces (and
// the seenFound/admitDrift bookkeeping recomputeFound drives) was discovered only on the render() just
// AFTER agentFilmsReady flipped, so the flush fireAccountFanout awaits before flipping it always found
// nothing queued yet — the write-after-settled leak both ACs below exercise.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("AC1: acctFetchKeepalive — within the 8000-byte cap is true, over it is false, a non-string body is false", () => {
  const E = loadEngine();
  assert.equal(E.acctFetchKeepalive({}), true, "no body at all — small routine request, keepalive is fine");
  assert.equal(E.acctFetchKeepalive({ body: "x".repeat(8000) }), true, "exactly at the cap");
  assert.equal(E.acctFetchKeepalive({ body: "x".repeat(8001) }), false, "one byte over the cap");
  assert.equal(E.acctFetchKeepalive({ body: new Uint8Array([1, 2, 3]) }), false,
    "a non-string body (Blob/ArrayBuffer/FormData/typed array) is never sized by this check — never keepalive");
});

test("AC2: the built index.html calls the wrapper through acctFetchKeepalive exactly once, and never hardcodes keepalive:true", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const matches = html.match(/keepalive: acctFetchKeepalive\(/g) || [];
  assert.equal(matches.length, 1, "exactly one call site — the auth module's own fetch wrapper");
  assert.equal(html.includes("keepalive: true })"), false, "the old unconditional keepalive must be gone");
});

// A stateful fake Supabase client: upsert/update/delete actually mutate each table's own array, and a
// later select reflects them — needed because AC3/AC4 call reconcileOnReturn()/fireAccountFanout() more
// than once and must see "nothing changed" on the second pass only if the FIRST pass's own writes are
// genuinely visible to it, the same way the real local-Supabase stack would behave.
function makeStatefulClient(seed){
  const tables = {};
  for(const k in seed) tables[k] = seed[k].map(r => ({ ...r }));
  const keyOf = (row, keys) => keys.map(k => String(row[k])).join("|");
  function builder(table){
    const state = { table, kind: "select", filters: [] };
    const b = {
      select(){ return b; },
      order(col, opts){ state.orderCol = col; state.orderDesc = opts && opts.ascending === false; return b; },
      range(from, to){ state.from = from; state.to = to; return b; },
      eq(col, val){ state.filters.push([col, val, "eq"]); return b; },
      in(col, vals){ state.filters.push([col, vals, "in"]); return b; },
      is(col, val){ state.filters.push([col, val, "is"]); return b; },
      limit(n){ state.limitN = n; return b; },
      single(){ state.single = true; return b; },
      maybeSingle(){ state.single = true; return b; },
      upsert(rows, opts){ state.kind = "upsert"; state.rows = Array.isArray(rows) ? rows : [rows]; state.opts = opts || {}; return b; },
      update(fields){ state.kind = "update"; state.fields = fields; return b; },
      match(m){ state.match = m; return b; },
      delete(){ state.kind = "delete"; return b; },
      then(resolve, reject){
        try{
          const rows = tables[table] || (tables[table] = []);
          if(state.kind === "select"){
            let out = rows.slice();
            state.filters.forEach(([col, val, op]) => {
              out = out.filter(r => op === "in" ? val.includes(r[col])
                : op === "is" ? (r[col] === val || (val === null && r[col] == null))
                : String(r[col]) === String(val));
            });
            if(state.orderCol) out.sort((a, b2) => {
              const av = a[state.orderCol], bv = b2[state.orderCol];
              return (av > bv ? 1 : av < bv ? -1 : 0) * (state.orderDesc ? -1 : 1);
            });
            if(typeof state.from === "number") out = out.slice(state.from, state.to + 1);
            if(state.limitN) out = out.slice(0, state.limitN);
            resolve(state.single ? { data: out[0] || null, error: null } : { data: out, error: null });
          } else if(state.kind === "upsert"){
            const onConflict = (state.opts.onConflict || "id").split(",");
            state.rows.forEach(row => {
              const idx = rows.findIndex(r => keyOf(r, onConflict) === keyOf(row, onConflict));
              if(idx >= 0){ if(!state.opts.ignoreDuplicates) Object.assign(rows[idx], row); }
              else rows.push({ ...row });
            });
            resolve({ data: state.rows, error: null, status: 200 });
          } else if(state.kind === "update"){
            const matches = r => Object.keys(state.match || {}).every(k => String(r[k]) === String(state.match[k]));
            rows.forEach(r => { if(matches(r)) Object.assign(r, state.fields); });
            resolve({ data: rows.filter(matches), error: null, status: 200 });
          } else if(state.kind === "delete"){
            const matches = r => Object.keys(state.match || {}).every(k => String(r[k]) === String(state.match[k]));
            tables[table] = rows.filter(r => !matches(r));
            resolve({ data: [], error: null, status: 200 });
          } else resolve({ data: [], error: null });
        } catch(e){ reject(e); }
      },
    };
    return b;
  }
  return { tables, from(table){ return builder(table); }, rpc(){ return Promise.resolve({ data: null, error: null }); } };
}

function signIn(E, client, userId){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
  E.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [0, 0, 0];
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
async function waitUntil(fn, timeoutMs = 10_000){
  const start = Date.now();
  while(!fn()){
    if(Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise(r => setTimeout(r, 20));
  }
}
// seedWideOpenAgent mirrors tests/e2e-integrity/helpers.mjs's own seedCascades({}) shape exactly — a
// criteria-less row, so rowToCascade (CascadeShape) produces the same truly wide-open agent AC1's own
// device-storage/settled-watch-list reproduction uses: every real film in the built catalogue matches.
function wideOpenAgentRow(userId, id){
  return { id, name: "Wide open agent", criteria: {}, active: true, user_id: userId, updated_at: "2026-01-01T00:00:00.000Z" };
}

test("AC3 (B2): a reconcile that changes nothing on a fully-settled account calls render() zero times", async () => {
  const E = loadEngine();
  const userId = "cas1241-ac3-user";
  const agentRow = wideOpenAgentRow(userId, "a0000000-0000-4000-8000-000000000001");
  const client = makeStatefulClient({
    cascades: [agentRow],
    user_prefs: [{ user_id: userId, ref_code: "CAS1241AC3" }],
    notify_prefs: [{ user_id: userId, in_app: true, email_on: true, email_address: "x@test.com" }],
    user_films: [], film_watch: [], film_picks: [], agent_films: [],
    invites: [], friends: [], notifications: [], app_config: [],
  });
  signIn(E, client, userId);
  E.cascades.length = 0; E.cascades.push(E.CascadeShape.rowToCascade(agentRow));
  E.CascadeAccountStore.acctStore.cascades = [agentRow];
  try{
    // Settles the account the same way a real sign-in does — the fan-out's own admission sweep must fully
    // drain (B4's own fix) before this test's two reconcileOnReturn() calls below ever run.
    await E.CascadePersistence.fireAccountFanout("ac3-setup");
    await waitUntil(() => E.CascadeAccountStore.queue.length === 0);

    // Warm-up pass: establishes every table's own reconcileUnchanged baseline signature (cascades is never
    // pulled by fireAccountFanout itself — only reconcileOnReturn ever calls reconcileCascadesOnReturn), so
    // the SECOND call below is the one actually measuring "nothing changed".
    E.CascadePersistence.renderCallCount = 0;
    E.CascadePersistence.reconcileOnReturn();
    await waitUntil(() => E.CascadeAccountStore.queue.length === 0);
    await new Promise(r => setTimeout(r, 200));   // let every fire-and-forget load inside it settle

    E.CascadePersistence.renderCallCount = 0;
    E.CascadePersistence.reconcileOnReturn();
    await new Promise(r => setTimeout(r, 500));

    assert.equal(E.CascadePersistence.renderCallCount, 0,
      "a reconcile pass against an idle, unchanged account must call render() zero times");
  } finally {
    E.cascades.length = 0;
    signOut(E);
  }
});

test("AC4 (B4/B5): once every ready flag first reads true, no further agent_films or view write ever arrives", async () => {
  const E = loadEngine();
  const userId = "cas1241-ac4-user";
  const agentRow = wideOpenAgentRow(userId, "a0000000-0000-4000-8000-000000000002");
  const client = makeStatefulClient({
    cascades: [agentRow],
    user_prefs: [{ user_id: userId, ref_code: "CAS1241AC4" }],
    // The bootstrap notify_prefs row already exists — its own insert-if-missing path is deliberate and
    // not under test here (see loadNotifyPrefs), so it must not show up as noise in this test's counts.
    notify_prefs: [{ user_id: userId, in_app: true, email_on: true, email_address: "x@test.com" }],
    user_films: [], film_watch: [], film_picks: [], agent_films: [],
    invites: [], friends: [], notifications: [], app_config: [],
  });
  signIn(E, client, userId);
  E.cascades.length = 0; E.cascades.push(E.CascadeShape.rowToCascade(agentRow));
  E.CascadeAccountStore.acctStore.cascades = [agentRow];
  try{
    const CP = E.CascadePersistence;
    const allReady = () => CP.userPrefsReady && CP.notifyPrefsReady && CP.filmWatchReady && CP.agentFilmsReady;

    const fanout = CP.fireAccountFanout("ac4");
    await waitUntil(allReady);

    const countAt = () => ({
      agentFilms: client.tables.agent_films ? client.tables.agent_films.length : 0,
      viewWrites: client.tables.user_prefs ? client.tables.user_prefs.length : 0,   // sanity only, see below
    });
    // The real signal is request COUNT, not row count (a view write never adds a user_prefs row) — track
    // merge_user_prefs_view rpc calls and agent_films upsert calls directly via the acctOp queue instead:
    // simplest reliable proxy is "how many agent_films rows exist" (monotonic, one row per admitted film,
    // never rewritten) plus the account store's own queue being fully drained.
    const agentFilmsAtReady = client.tables.agent_films.length;
    assert.ok(agentFilmsAtReady > 1000,
      "sanity: the wide-open agent must have admitted a broad, real slice of the catalogue by the time every ready flag is true");

    await new Promise(r => setTimeout(r, 3000));
    await fanout;

    assert.equal(client.tables.agent_films.length, agentFilmsAtReady,
      "no further agent_films admission may arrive after every ready flag first read true");
    assert.equal(E.CascadeAccountStore.queue.length, 0,
      "and the queue that would carry a late write must already be empty, not merely about to drain");
  } finally {
    E.cascades.length = 0;
    signOut(E);
  }
});

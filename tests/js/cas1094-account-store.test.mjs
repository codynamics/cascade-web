// CAS-1094: the server-first account store core — acctLoad (paged, wholesale-replace read) and acctOp (the
// one path any account write goes through: optimistic apply, a persisted per-account queue, strict-order
// send, retry-with-backoff on network/5xx, permanent-drop-and-revert on 4xx, and the expectUpdatedAt
// conflict check). These tests drive the real seam (CascadeAccountStore.acctLoad/acctOp) with a stubbed
// Supabase client, the same convention sync-outcomes.test.mjs and outbox-durability.test.mjs use.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// A generic chainable fake query builder: every method records onto a shared `state` object and returns
// itself, and `then` (so `await` works at any point in the chain, exactly like real supabase-js) resolves
// by calling the test's own `script(state)` — the one place each test decides what the server would have
// said. Every call is also recorded into `calls`, in the order it resolved, so a test can assert ordering.
function makeQueryBuilder(table, calls, script){
  const state = { table, kind: "select" };
  const b = {
    select(cols){ state.selectCols = cols; return b; },
    order(col, opts){ state.orderCol = col; state.orderOpts = opts; return b; },
    range(from, to){ state.from = from; state.to = to; return b; },
    upsert(rows, opts){ state.kind = "upsert"; state.rows = rows; state.opts = opts; return b; },
    update(fields){ state.kind = "update"; state.fields = fields; return b; },
    delete(){ state.kind = "delete"; return b; },
    match(m){ state.match = m; return b; },
    eq(col, val){ state.eqCol = col; state.eqVal = val; return b; },
    single(){ state.single = true; return b; },
    then(resolve, reject){
      const snapshot = Object.assign({}, state);
      calls.push(snapshot);
      return Promise.resolve().then(() => script(snapshot)).then(resolve, reject);
    },
  };
  return b;
}
function fakeClient(script){
  const calls = [];
  return { calls, from(table){ return makeQueryBuilder(table, calls, script); } };
}
function signIn(E, client, userId = "cas1094-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
function zeroBackoff(E){ E.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [0, 0, 0]; }

test("CAS-1094 AC1: ops are sent in order", async () => {
  const E = loadEngine();
  const client = fakeClient(() => ({ data: [{}], error: null, status: 200 }));
  signIn(E, client);
  try{
    zeroBackoff(E);
    const ops = [
      { id:"op-1", table:"widgets", kind:"insert", fields:{ id:"w1", name:"one" } },
      { id:"op-2", table:"widgets", kind:"insert", fields:{ id:"w2", name:"two" } },
      { id:"op-3", table:"widgets", kind:"insert", fields:{ id:"w3", name:"three" } },
    ];
    // Await only the LAST op's own promise — acctOp resolves each op independently of who is actually
    // driving the queue loop, so this alone proves the whole queue (not just this one op) has drained.
    await ops.map(op => E.CascadeAccountStore.acctOp(op)).pop();
    assert.deepEqual(client.calls.map(c => c.rows && c.rows.id), ["w1", "w2", "w3"]);
  } finally { signOut(E); }
});

test("CAS-1094 AC2: an insert that fails and is then retried produces exactly one row", async () => {
  const E = loadEngine();
  let attempts = 0;
  const stored = [];   // real ignoreDuplicates semantics, not assumed — a retry that upserts the same
                        // client-generated id must not add a second row.
  const client = fakeClient(state => {
    if(state.kind !== "upsert") return { data: [], error: null, status: 200 };
    attempts++;
    if(attempts === 1) return { data: null, error: { message: "network blip" }, status: 0 };
    if(!stored.some(r => r.id === state.rows.id)) stored.push(Object.assign({}, state.rows));
    return { data: [state.rows], error: null, status: 201 };
  });
  signIn(E, client);
  try{
    zeroBackoff(E);
    await E.CascadeAccountStore.acctOp({ id:"op-1", table:"widgets", kind:"insert",
      fields:{ id:"w1", name:"one" } });
    assert.equal(attempts, 2, "sanity: the first attempt really failed before the retry succeeded");
    assert.equal(stored.length, 1, "a failed-then-retried insert must produce exactly one row");
  } finally { signOut(E); }
});

test("CAS-1094 AC3: a 4xx drops the op and reverts memory", async () => {
  const E = loadEngine();
  const client = fakeClient(state => {
    if(state.kind === "update") return { data: null, error: { message: "refused" }, status: 403 };
    return { data: [{ id:"w1", name:"seed" }], error: null, status: 200 };
  });
  signIn(E, client);
  try{
    zeroBackoff(E);
    await E.CascadeAccountStore.acctLoad([{ table:"widgets", pk:"id" }]);
    // JSON round-trip rather than assert.deepEqual: the store's rows live in the engine's own vm realm, so
    // a strict cross-realm structural comparison would fail on prototype identity alone, not on content.
    const before = JSON.stringify(E.CascadeAccountStore.acctStore.widgets);
    await E.CascadeAccountStore.acctOp({ id:"op-1", table:"widgets", kind:"update",
      match:{ id:"w1" }, fields:{ name:"changed" } });
    assert.equal(JSON.stringify(E.CascadeAccountStore.acctStore.widgets), before,
      "a permanently-rejected update must leave memory exactly as it was before the optimistic apply");
  } finally { signOut(E); }
});

test("CAS-1094 AC4: a conflicting update (0 rows affected) reloads that row from the server", async () => {
  const E = loadEngine();
  let updateCalls = 0;
  const client = fakeClient(state => {
    if(state.kind === "update"){ updateCalls++; return { data: [], error: null, status: 200 }; }
    if(state.single) return { data: { id:"w1", name:"server-wins" }, error: null, status: 200 };
    return { data: [{ id:"w1", name:"seed" }], error: null, status: 200 };
  });
  signIn(E, client);
  try{
    zeroBackoff(E);
    await E.CascadeAccountStore.acctLoad([{ table:"widgets", pk:"id" }]);
    await E.CascadeAccountStore.acctOp({ id:"op-1", table:"widgets", kind:"update", match:{ id:"w1" },
      fields:{ name:"mine" }, expectUpdatedAt:"2026-09-30T05:30:00.000000+00:00" });
    assert.equal(updateCalls, 1, "a resolved conflict must not be retried");
    const row = E.CascadeAccountStore.acctStore.widgets.find(r => r.id === "w1");
    assert.equal(row.name, "server-wins", "the store must replace the row with what the server actually has");
  } finally { signOut(E); }
});

test("CAS-1094 AC5: expectUpdatedAt reaches the stub byte-for-byte", async () => {
  const E = loadEngine();
  const EXACT = "2026-09-30T05:30:45.403685+00:00";
  let seenEq = null;
  const client = fakeClient(state => {
    if(state.kind === "update"){ seenEq = state.eqVal; return { data: [{ id:"w1" }], error: null, status: 200 }; }
    return { data: [], error: null, status: 200 };
  });
  signIn(E, client);
  try{
    zeroBackoff(E);
    await E.CascadeAccountStore.acctOp({ id:"op-1", table:"widgets", kind:"update", match:{ id:"w1" },
      fields:{ name:"x" }, expectUpdatedAt: EXACT });
    // Never round-tripped through new Date() — a string in, the exact same string out, microseconds intact.
    assert.equal(seenEq, EXACT);
  } finally { signOut(E); }
});

test("CAS-1094 AC6: acctLoad over 2,037 rows makes 3 requests and returns every row", async () => {
  const E = loadEngine();
  const ALL = Array.from({ length: 2037 }, (_, i) => ({ id: `w${i}`, name: `row ${i}` }));
  let requests = 0;
  const client = fakeClient(state => {
    requests++;
    return { data: ALL.slice(state.from, state.to + 1), error: null, status: 200 };
  });
  signIn(E, client);
  try{
    await E.CascadeAccountStore.acctLoad([{ table:"widgets", pk:"id" }]);
    assert.equal(requests, 3);
    // JSON round-trip, same cross-realm reasoning as AC3 above.
    assert.equal(JSON.stringify(E.CascadeAccountStore.acctStore.widgets), JSON.stringify(ALL));
  } finally { signOut(E); }
});

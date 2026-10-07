// CAS-1095: user_prefs/notify_prefs move onto acctOp as per-column updates — no more whole-row upsert, no
// more carry-up. This test drives the real chip chokepoint (onChipToggle, the same function a ⚙️ tap
// wires) with a stubbed Supabase client and asserts the ONE update it issues names only the services
// column(s) it actually changed — not services_only/touched, which this action never touched.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// A minimal chainable fake query builder covering both the acctOp "update" shape
// (from(table).update(fields).match(m)[.eq(...)].select()) and the "upsert" shape
// (from(table).upsert(fields, opts), no .select() chain) — same convention
// cas1094-account-store.test.mjs uses, trimmed to what this test needs. CAS-1218: pushUserPrefsCols issues
// "upsert" now (a load no longer bootstrap-inserts the row, so the first real column write has to be able
// to create it), carrying op.match merged straight into the single fields object, not a separate .match().
function makeQueryBuilder(table, calls){
  const state = { table };
  const b = {
    update(fields){ state.kind = "update"; state.fields = fields; return b; },
    upsert(fields, opts){ state.kind = "upsert"; state.fields = fields; state.opts = opts; return b; },
    match(m){ state.match = m; return b; },
    eq(col, val){ state.eqCol = col; state.eqVal = val; return b; },
    select(){ return b; },
    then(resolve, reject){
      const snapshot = Object.assign({}, state);
      calls.push(snapshot);
      return Promise.resolve({ data: [snapshot.fields || {}], error: null, status: 200 }).then(resolve, reject);
    },
  };
  return b;
}
function fakeClient(calls){
  return { from(table){ return makeQueryBuilder(table, calls); } };
}
function signIn(E, client, userId = "cas1095-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}

test("CAS-1095 AC2: toggling one service issues one update whose payload contains only the services column(s)", async () => {
  const E = loadEngine();
  const calls = [];
  const client = fakeClient(calls);
  signIn(E, client);
  try{
    E.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [0, 0, 0];
    // Already answered on this device — the smart-default auto-arm (which would also touch services_only)
    // must not fire, so this toggle is a clean single-setting change.
    E.prefs.touched = true;
    E.prefs.on = false;
    E.prefs.sub.clear();
    E.prefs.store.clear();

    // The exact sequence a ⚙️ chip tap runs: the chip's own onclick mutates the Set, then calls
    // onChipToggle(cls) — see addChips() in app_template.html.
    E.prefs.sub.add("Netflix");
    E.onChipToggle("svc");
    await new Promise(r => setTimeout(r, 0));   // let acctOp's queued send resolve against the fake client

    const updates = calls.filter(c => c.table === "user_prefs" && c.kind === "upsert");
    assert.equal(updates.length, 1, "exactly one user_prefs upsert must be issued for one toggle");
    assert.deepEqual(Object.keys(updates[0].fields).filter(k => k !== "user_id").sort(),
      ["store_services", "sub_services"],
      "the payload must carry only the services column(s) — no services_only/touched drift, no whole row");
    // updates[0].fields.sub_services is an array built inside engine.mjs's vm sandbox — spread it into a
    // plain host-realm array first, or deepEqual (deepStrictEqual under node:assert/strict) fails on Array
    // prototype identity alone, independent of contents (same cross-realm gotcha this suite hits elsewhere).
    assert.deepEqual([...updates[0].fields.sub_services], ["Netflix"]);
    assert.deepEqual([...updates[0].fields.store_services], []);
    assert.equal(updates[0].fields.user_id, "cas1095-test-user");
  } finally { signOut(E); }
});

test("CAS-1095: a notify_prefs change pushes all three channel columns together, never a whole user_prefs row", async () => {
  const E = loadEngine();
  const calls = [];
  const client = fakeClient(calls);
  signIn(E, client);
  try{
    E.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [0, 0, 0];
    E.notifyPrefs.inApp = true;
    E.notifyPrefs.emailOn = false;
    E.notifyPrefs.email = "";

    E.CascadePersistence.pushNotifyPrefs();
    await new Promise(r => setTimeout(r, 0));

    const updates = calls.filter(c => c.kind === "update");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].table, "notify_prefs");
    assert.deepEqual(Object.keys(updates[0].fields).sort(), ["email_address", "email_on", "in_app"]);
  } finally { signOut(E); }
});

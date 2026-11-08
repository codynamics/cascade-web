// CAS-1399: a light, prefs-only poll runs every 30s while the tab is visible and the account is signed in,
// so a mood edited on another device shows up here without waiting for the 3-minute heartbeat or a
// focus/visibilitychange return. Guarded the same way reconcileOnReturn's own user_prefs pull is (no unsent
// user_prefs/merge_user_prefs_view write), plus a skip while the mood sheet is open so a draft being edited
// is never repainted underneath the person. prefsPollTick is the poll's own tick, exported directly so a
// test can drive it rather than waiting on the real 30s interval — same fake-client convention
// cas1222-view-prefs.test.mjs uses.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function makeFakeClient(script){
  const calls = [];
  const rpcCalls = [];
  function builder(table){
    const state = { table, kind: "select" };
    const b = {
      select(cols){ state.selectCols = cols; return b; },
      order(){ return b; },
      range(){ return b; },
      upsert(fields, opts){ state.kind = "upsert"; state.fields = fields; state.opts = opts; return b; },
      update(fields){ state.kind = "update"; state.fields = fields; return b; },
      match(m){ state.match = m; return b; },
      then(resolve, reject){
        const snapshot = Object.assign({}, state);
        calls.push(snapshot);
        return Promise.resolve().then(() => script(snapshot)).then(resolve, reject);
      },
    };
    return b;
  }
  return {
    calls, rpcCalls,
    from(table){ return builder(table); },
    rpc(name, params){
      rpcCalls.push({ name, params });
      return Promise.resolve({ data: null, error: null });
    },
  };
}
function selectUserPrefsRow(row){
  return state => (state.table === "user_prefs" && state.kind === "select")
    ? { data: row ? [row] : [], error: null }
    : { data: [], error: null };
}
function signIn(E, client, userId = "cas1399-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
  E.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [0, 0, 0];
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
const settle = () => new Promise(r => setTimeout(r, 0));
const userPrefsSelects = client => client.calls.filter(c => c.table === "user_prefs" && c.kind === "select").length;

test("CAS-1399: the prefs poll calls loadUserPrefs while visible with no queued view write", async () => {
  const E = loadEngine();
  const client = makeFakeClient(selectUserPrefsRow(null));
  signIn(E, client);
  E.setDocumentVisibilityState("visible");
  try{
    const before = userPrefsSelects(client);
    E.CascadePersistence.prefsPollTick();
    await settle();
    assert.equal(userPrefsSelects(client), before + 1, "a user_prefs select ran");
  } finally {
    signOut(E);
  }
});

test("CAS-1399: the prefs poll skips while a merge_user_prefs_view op is still queued", async () => {
  const E = loadEngine();
  const client = makeFakeClient(selectUserPrefsRow(null));
  signIn(E, client);
  E.setDocumentVisibilityState("visible");
  try{
    // pushViewField queues an immediate merge_user_prefs_view rpc op synchronously, ahead of any await —
    // exactly the in-flight-write window this guard exists to protect.
    E.CascadePersistence.pushViewField("tutorialSeen", true);
    assert.equal(E.CascadeAccountStore.queue.some(op => op.table === "merge_user_prefs_view"), true,
      "op is queued before the poll tick runs");
    const before = userPrefsSelects(client);
    E.CascadePersistence.prefsPollTick();
    assert.equal(userPrefsSelects(client), before, "no user_prefs select while the view write is unsent");
    await settle();
  } finally {
    signOut(E);
  }
});

test("CAS-1399: the prefs poll skips while the tab is hidden", async () => {
  const E = loadEngine();
  const client = makeFakeClient(selectUserPrefsRow(null));
  signIn(E, client);
  E.setDocumentVisibilityState("hidden");
  try{
    const before = userPrefsSelects(client);
    E.CascadePersistence.prefsPollTick();
    await settle();
    assert.equal(userPrefsSelects(client), before, "no user_prefs select while hidden");
  } finally {
    E.setDocumentVisibilityState("visible");
    signOut(E);
  }
});

test("CAS-1399: the prefs poll skips while the mood sheet is open", async () => {
  const E = loadEngine();
  const client = makeFakeClient(selectUserPrefsRow(null));
  signIn(E, client);
  E.setDocumentVisibilityState("visible");
  E.openWatchSheet();
  try{
    const before = userPrefsSelects(client);
    E.CascadePersistence.prefsPollTick();
    await settle();
    assert.equal(userPrefsSelects(client), before, "no user_prefs select while #watchSheet is open");
  } finally {
    E.closeWatchSheet();
    signOut(E);
  }
});

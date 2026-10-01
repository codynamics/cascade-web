// CAS-1108: the minimum client build gate — an out-of-date client (BUILD_INFO.build below public.
// app_config's min_client_build) stops sending account writes and shows a full-screen blocking message.
// Drives the real seam (CascadePersistence.checkBuildGate) with a stubbed Supabase client, the same
// convention cas1094-account-store.test.mjs uses for acctLoad/acctOp.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function makeQueryBuilder(table, calls, script){
  const state = { table, kind: "select" };
  const b = {
    select(cols){ state.selectCols = cols; return b; },
    in(col, vals){ state.inCol = col; state.inVals = vals; return b; },
    upsert(rows, opts){ state.kind = "upsert"; state.rows = rows; state.opts = opts; return b; },
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
function signIn(E, client, userId = "cas1108-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
function appConfigClient(minClientBuild){
  return fakeClient(state => {
    if(state.table !== "app_config") return { data: [], error: null, status: 200 };
    return { data: [{ key:"min_client_build", value: minClientBuild }], error: null, status: 200 };
  });
}

test("CAS-1108 AC1: build 1900 under min_client_build 2000 blocks and an account write is not sent", async () => {
  const E = loadEngine();
  const client = appConfigClient(2000);
  E.BUILD_INFO.build = 1900;
  signIn(E, client);
  try{
    await E.CascadePersistence.checkBuildGate();
    assert.equal(E.buildGateBlocked, true);
    await E.CascadeAccountStore.acctOp({ id:"op-1", table:"widgets", kind:"insert", fields:{ id:"w1" } });
    assert.equal(client.calls.some(c => c.table === "widgets"), false,
      "a blocked client must never send the queued write to the server");
  } finally { signOut(E); }
});

test("CAS-1108 AC2: build 1000 at or above min_client_build 2000's floor is not blocked and the write is sent", async () => {
  const E = loadEngine();
  const client = appConfigClient(1000);
  E.BUILD_INFO.build = 1000;
  signIn(E, client);
  try{
    await E.CascadePersistence.checkBuildGate();
    assert.equal(E.buildGateBlocked, false);
    await E.CascadeAccountStore.acctOp({ id:"op-1", table:"widgets", kind:"insert", fields:{ id:"w1" } });
    assert.equal(client.calls.some(c => c.table === "widgets"), true,
      "an unblocked client must still send its queued write");
  } finally { signOut(E); }
});

test("CAS-1108 AC3: a failed app_config read does not block", async () => {
  const E = loadEngine();
  const client = fakeClient(() => ({ data: null, error: { message: "network blip" }, status: 0 }));
  E.BUILD_INFO.build = 1;   // the lowest possible build — would block under any real floor
  signIn(E, client);
  try{
    await E.CascadePersistence.checkBuildGate();
    assert.equal(E.buildGateBlocked, false);
  } finally { signOut(E); }
});

test("CAS-1108 AC4: a missing min_client_build row does not block", async () => {
  const E = loadEngine();
  const client = fakeClient(() => ({ data: [], error: null, status: 200 }));
  E.BUILD_INFO.build = 1;
  signIn(E, client);
  try{
    await E.CascadePersistence.checkBuildGate();
    assert.equal(E.buildGateBlocked, false);
  } finally { signOut(E); }
});

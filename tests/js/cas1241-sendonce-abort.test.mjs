// CAS-1241: the queue-drain stall traced back to acctOp's own sendOnceWithTimeout — when its client-side
// SEND_ONCE_TIMEOUT_MS race won, the losing real request was never actually cancelled. The abandoned
// request kept running against PostgREST/Postgres (holding a row lock for an upsert/rpc like CAS-1222's
// merge_user_prefs_view), and every retry then opened a NEW competing request against the same row instead
// of replacing the stuck one — compounding the contention each attempt rather than resolving it, which is
// exactly the "queue never drains within the test's own poll window" symptom CI's local Supabase stack hit.
// This test proves the fix directly: every attempt's underlying query builder is handed a real
// AbortSignal, and that signal is aborted once the client-side timeout actually fires.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// A client whose builder never resolves on its own (simulating a hung PostgREST round trip) — the ONLY way
// processOp ever moves on is sendOnceWithTimeout's own race firing. Records every AbortSignal it was given
// so the test can confirm each one was aborted by the time that attempt's timeout fired.
function makeHangingClient(){
  const signals = [];
  function hangingBuilder(){
    const b = {
      abortSignal(signal){ signals.push(signal); return b; },
      match(){ return b; },
      then(){ /* deliberately never settles — only the timeout race can end this attempt */ },
    };
    return b;
  }
  return {
    signals,
    from(){ return { upsert(){ return hangingBuilder(); }, update(){ return hangingBuilder(); },
      delete(){ return hangingBuilder(); } }; },
    rpc(){ return hangingBuilder(); },
  };
}
function signIn(E, client, userId = "cas1241-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}

test("CAS-1241: a timed-out attempt aborts its own request instead of leaving it running", async () => {
  const E = loadEngine();
  const client = makeHangingClient();
  signIn(E, client);
  const store = E.CascadeAccountStore;
  const originalTimeout = store.SEND_ONCE_TIMEOUT_MS;
  const originalDelays = store.ACCT_OP_RETRY_DELAYS;
  store.SEND_ONCE_TIMEOUT_MS = 15;
  store.ACCT_OP_RETRY_DELAYS = [0, 0, 0];
  try{
    // acctOp's own promise resolves once processOp gives up on this pass (retry-later still calls
    // op._resolve()) — every attempt in between is one hung request, one abort.
    await store.acctOp({ table:"merge_user_prefs_view", kind:"rpc", fields:{ p_patch:{ x:1 } } });

    assert.equal(client.signals.length, 4, "one attempt + three retries, each its own request");
    for(const signal of client.signals){
      assert.ok(signal instanceof AbortSignal, "the real client is always handed a genuine AbortSignal");
      assert.equal(signal.aborted, true, "the timed-out attempt's own request must be aborted, not abandoned");
    }
    // Distinct controllers, not one shared/reused signal already aborted before the attempt even started.
    assert.equal(new Set(client.signals).size, 4);
  } finally {
    store.SEND_ONCE_TIMEOUT_MS = originalTimeout;
    store.ACCT_OP_RETRY_DELAYS = originalDelays;
    store.queue.length = 0;   // this op never resolved server-side — drop it rather than leak into later tests
    signOut(E);
  }
});

test("CAS-1241: a client whose query builder has no abortSignal() still works (no crash, normal retry/drop)", async () => {
  const E = loadEngine();
  let attempts = 0;
  // Same convention as the other acctOp test suites' fakeClient: a minimal builder with no abortSignal
  // method at all — must be handled as a no-op, not thrown.
  const client = {
    from(){
      const state = {};
      const b = {
        upsert(fields){ state.fields = fields; return b; },
        match(m){ state.match = m; return b; },
        then(resolve){
          attempts++;
          return Promise.resolve().then(() => resolve({ data:[state.fields], error:null, status:200 }));
        },
      };
      return b;
    },
  };
  signIn(E, client);
  const store = E.CascadeAccountStore;
  const originalDelays = store.ACCT_OP_RETRY_DELAYS;
  store.ACCT_OP_RETRY_DELAYS = [0, 0, 0];
  try{
    await store.acctOp({ table:"widgets", kind:"upsert", match:{ id:"w1" }, fields:{ id:"w1", name:"one" } });
    assert.equal(attempts, 1, "a clean success needs exactly one attempt");
  } finally {
    store.ACCT_OP_RETRY_DELAYS = originalDelays;
    signOut(E);
  }
});

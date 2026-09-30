// CAS-1107 — stop-gap part 2 on top of CAS-1090 (3bf15e3): that ticket closed the "absence infers a delete"
// hole by requiring an explicit tombstone (cascadePendingDeletes) before cascades' own sync can ever delete
// anything, but two things were still wrong after it shipped. First, fireAccountFanout ran
// `await replayOutbox()` (which drives runSync/syncToAccount, the same write path) BEFORE the
// `Promise.allSettled([loadAccount(), ...])` load below it ever started — a sign-in's own sync pass could
// run against whatever baseline this device happened to boot with, not against what THIS session's account
// load actually confirmed, and a failed load hadn't even latched acctTableFail yet by the time replay ran.
// Second, cascadeKnown (that baseline) was itself persisted to localStorage and reloaded on every boot/
// account-switch, so a stale copy from a previous session could outlive the session it was measured in.
// The fix: every load fireAccountFanout kicks off is now awaited to completion before replayOutbox ever
// runs, and cascadeKnown lives in memory only, populated purely by a successful load THIS session.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// A generic chainable query stub: any method call (.order/.eq/.limit/.range/.single/...) just keeps
// chaining, and the object itself resolves (is "thenable") to the fixed result it was built with — the
// same reasoning engine.mjs's own `node()` DOM stub uses for "answer permissively, only the one path under
// test is real". Lets one fake client answer every table fireAccountFanout's ten loads touch without having
// to model each table's exact call shape.
function chainable(resultPromise){
  return new Proxy(function(){}, {
    get(t, k){
      if(k === "then") return (resolve, reject) => resultPromise.then(resolve, reject);
      if(k === "catch") return (reject) => resultPromise.catch(reject);
      if(k === "finally") return (fn) => resultPromise.finally(fn);
      return () => chainable(resultPromise);
    },
  });
}
function makeFakeClient({ cascadesRows = null, cascadesError = null } = {}){
  const upsertCalls = [];
  const deleteCalls = [];
  const client = {
    upsertCalls, deleteCalls,
    from(table){
      return {
        select(){
          if(table === "cascades"){
            return chainable(Promise.resolve(
              cascadesError ? { data: null, error: cascadesError } : { data: cascadesRows || [], error: null }));
          }
          return chainable(Promise.resolve({ data: [], error: null }));
        },
        upsert(rows){
          upsertCalls.push({ table, rows });
          return { select(){ return Promise.resolve({ data: rows.map(r=>({ id:r.id, updated_at:new Date().toISOString() })), error:null }); } };
        },
        delete(){
          const eqParts = {};
          const api = {
            eq(col, val){ eqParts[col]=val; return api; },
            in(col, vals){
              deleteCalls.push({ table, eq: { ...eqParts, [col]: vals } });
              return Promise.resolve({ data: [], error: null });
            },
          };
          return api;
        },
      };
    },
  };
  return client;
}
function signIn(E, client, userId = "cas1107-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}

test("CAS-1107 AC1: a stale confirmed baseline over an empty local `cascades` sends no delete via the real sign-in path, before or after the load, and the account's confirmed set is shown once it resolves", async () => {
  const E = loadEngine();
  const P = E.CascadePersistence;
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  // The incident's exact shape: this device already believes the account confirmed A and B (its own
  // last-known baseline from before this boot) while its live local list is empty — exactly what a stale
  // cascadeKnown surviving a sign-out/sign-in used to look like before this ticket made it memory-only.
  P.cascadeKnown.set(A, { sig: "stale-sig-a", version: "2019-01-01T00:00:00Z" });
  P.cascadeKnown.set(B, { sig: "stale-sig-b", version: "2019-01-01T00:00:00Z" });
  E.cascades.length = 0;
  const client = makeFakeClient({
    cascadesRows: [
      { id: A, name: "Agent A", criteria: {}, updated_at: "2020-01-01T00:00:00Z" },
      { id: B, name: "Agent B", criteria: {}, updated_at: "2020-01-01T00:00:00Z" },
    ],
  });
  signIn(E, client);
  try{
    // fireAccountFanout is the real chokepoint every sign-in/account-switch runs through — this drives
    // BOTH phases (the load, and replayOutbox's own sync pass) in the real order, not just one piece.
    await P.fireAccountFanout("test");
    assert.equal(client.deleteCalls.filter(c=>c.table==="cascades").length, 0,
      "no delete of any kind may reach cascades — not from replayOutbox's sync pass, not from anything the load triggers");
    assert.deepEqual(Array.from(E.cascades).map(c=>c.id).sort(), [A,B].sort(),
      "A and B, exactly as the account confirms them, must be shown once the load resolves");
  } finally{ signOut(E); }
});

test("CAS-1107 AC2: a sign-in whose cascades load fails sends zero writes to cascades", async () => {
  const E = loadEngine();
  const P = E.CascadePersistence;
  P.ACCT_READ_DELAYS = [0, 0];   // CAS-764: skip the real retry backoff, same convention as acct-read.test.mjs
  P.acctTableFail.cascades = false;
  const A = "33333333-3333-3333-3333-333333333333";
  // A row this device would otherwise have pushed — the account has never confirmed it (cascadeKnown has no
  // entry), so it is exactly the kind of "genuinely new, always dirty" row that would go out on replay if
  // the failed load hadn't already latched acctTableFail by the time replayOutbox's runSync ran.
  E.cascades.length = 0;
  E.cascades.push(E.normCascade({ id: A, name: "Never confirmed" }));
  const client = makeFakeClient({ cascadesError: { message: "CAS-1107 test: forced read failure" } });
  signIn(E, client);
  try{
    await P.fireAccountFanout("test");
    assert.equal(P.acctTableFail.cascades, true,
      "sanity: the exhausted-retry read must have actually latched the failure before replay ran");
    assert.equal(client.upsertCalls.filter(c=>c.table==="cascades").length, 0,
      "a load that fails must be confirmed failed (acctTableFail latched) before any push is attempted");
    assert.equal(client.deleteCalls.filter(c=>c.table==="cascades").length, 0,
      "zero writes of any kind to cascades once its own load has failed");
  } finally{ P.acctTableFail.cascades = false; signOut(E); }
});

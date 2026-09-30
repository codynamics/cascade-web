// CAS-1090 — a production account lost every one of its 43 agents in one write: cascadePendingDeleteIds()
// used to infer a server delete purely from an id being ABSENT from the live `cascades` array at sync time,
// for ANY reason (an onboarding re-run wiping the array on an already-signed-in device being the one traced
// here — see the comment above FLOWS' commit-step wire(), and the one above cascadePendingDeleteIds itself).
// The fix: a persisted tombstone set (cascadePendingDeletes) written ONLY by deleteAgentAsk, the one real
// delete path — absence from `cascades` no longer has any say in what gets deleted from the account.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// The engine runs in its own vm realm (see engine.mjs) — an array it hands back is constructed by THAT
// realm's Array, which fails assert/strict's deepEqual (prototype-identity, not just shape) against a plain
// array literal written here. Array.from(), called from this module, always builds a native array in THIS
// realm regardless of the input's origin, so every cross-realm array is normalized through it before compare.
const arr = x => Array.from(x);

function makeFakeClient({ shouldFailDelete = false } = {}){
  const upsertCalls = [];
  const deleteCalls = [];
  const client = {
    upsertCalls, deleteCalls, shouldFailDelete,
    from(table){
      return {
        upsert(rows){
          upsertCalls.push({ table, rows });
          return { select(){ return Promise.resolve({ data: rows.map(r=>({ id:r.id, updated_at:new Date().toISOString() })), error:null }); } };
        },
        select(){
          const thenable = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
          thenable.order = () => thenable; thenable.limit = () => thenable; thenable.eq = () => thenable;
          thenable.range = () => thenable;
          return thenable;
        },
        delete(){
          const chain = { _eq: {} };
          const settle = (extra) => {
            const eq = { ...chain._eq, ...(extra||{}) };
            deleteCalls.push({ table, eq });
            const err = client.shouldFailDelete ? { message: "CAS-1090 test: forced delete failure" } : null;
            return err ? { data: null, error: err } : { data: [], error: null };
          };
          chain.eq = (col, val) => { chain._eq[col] = val; return chain; };
          chain.in = (col, vals) => {
            const result = settle({ [col]: vals });
            return { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
          };
          return chain;
        },
      };
    },
  };
  return client;
}
function signIn(E, client, userId = "cas1090-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}

test("CAS-1090 AC2: absence from an empty `cascades` array, on its own, computes no deletes", () => {
  const E = loadEngine();
  const P = E.CascadePersistence;
  P.cascadeKnown.set("A", { sig:"sigA", version:null });
  P.cascadeKnown.set("B", { sig:"sigB", version:null });
  P.cascadeKnown.set("C", { sig:"sigC", version:null });
  E.cascades.length = 0;   // exactly the incident's shape: the account confirmed A,B,C, but the local array is empty
  assert.deepEqual(arr(P.cascadePendingDeleteIds()), [],
    "cascadeKnown holding ids the live array doesn't must never, on its own, produce a delete");
});

test("CAS-1090 AC2: only the explicit delete-agent action tombstones an id, and only that id", () => {
  const E = loadEngine();
  const P = E.CascadePersistence;
  P.cascadeKnown.set("A", { sig:"sigA", version:null });
  P.cascadeKnown.set("B", { sig:"sigB", version:null });
  P.cascadeKnown.set("C", { sig:"sigC", version:null });
  E.cascades.length = 0;
  E.cascades.push(E.normCascade({ id:"A", name:"A" }), E.normCascade({ id:"B", name:"B" }), E.normCascade({ id:"C", name:"C" }));
  assert.deepEqual(arr(P.cascadePendingDeleteIds()), [], "nothing tombstoned yet — nothing pending");

  const b = E.cascades.find(c=>c.id==="B");
  assert.equal(E.deleteAgentAsk(b), true, "the real delete path must report the delete as having happened");
  assert.deepEqual(arr(P.cascadePendingDeleteIds()), ["B"],
    "the one id actually deleted through deleteAgentAsk, and no other, must now be pending");
  assert.equal(E.cascades.some(c=>c.id==="B"), false, "B must be gone from the live array too");
});

test("CAS-1090: an id never confirmed by the account (not in cascadeKnown) is never tombstoned — nothing to delete server-side", () => {
  const E = loadEngine();
  const P = E.CascadePersistence;
  E.cascades.length = 0;
  E.cascades.push(E.normCascade({ id:"local-only-never-synced", name:"Draft" }));
  E.deleteAgentAsk(E.cascades[0]);
  assert.equal(P.cascadePendingDeletes.has("local-only-never-synced"), false);
  assert.deepEqual(arr(P.cascadePendingDeleteIds()), []);
});

test("CAS-1090: a successful sync clears the tombstone; a failed one leaves it pending for retry", async () => {
  const E = loadEngine();
  const P = E.CascadePersistence;
  const client = makeFakeClient({ shouldFailDelete: true });
  signIn(E, client);
  try{
    P.cascadeKnown.set("fail-me", { sig:"sig", version:null });
    E.cascades.length = 0;
    E.cascades.push(E.normCascade({ id:"fail-me", name:"Fail" }));
    E.deleteAgentAsk(E.cascades[0]);
    assert.deepEqual(arr(P.cascadePendingDeleteIds()), ["fail-me"]);

    await P.syncNow();
    assert.deepEqual(arr(P.cascadePendingDeleteIds()), ["fail-me"], "a failed delete must stay tombstoned so the next sync retries it");

    client.shouldFailDelete = false;
    await P.syncNow();
    assert.deepEqual(arr(P.cascadePendingDeleteIds()), [], "once the delete actually lands, the tombstone clears");
    assert.equal(P.cascadeKnown.has("fail-me"), false);
  } finally{ signOut(E); }
});

test("CAS-1090 Change 3: reconcileCascades pulls a known-but-locally-missing agent back down instead of treating it as deleted", async () => {
  const E = loadEngine();
  const P = E.CascadePersistence;
  const client = makeFakeClient();
  signIn(E, client);
  try{
    // The account confirms 3 agents; this device's own array has gone empty for some reason that ISN'T a
    // delete (the CAS-1090 incident shape) — nothing here was ever tombstoned.
    P.cascadeKnown.set("R1", { sig:"old", version:"2020-01-01" });
    P.cascadeKnown.set("R2", { sig:"old", version:"2020-01-01" });
    E.cascades.length = 0;
    client.from = (table) => ({
      select(){
        const rows = table==="cascades"
          ? [{ id:"R1", name:"Restored 1", criteria:{}, updated_at:"2020-01-01T00:00:00Z" },
             { id:"R2", name:"Restored 2", criteria:{}, updated_at:"2020-01-01T00:00:00Z" }]
          : [];
        const thenable = { then(resolve){ return Promise.resolve({ data: rows, error: null }).then(resolve); } };
        thenable.order = () => thenable; thenable.eq = () => thenable; thenable.range = () => thenable;
        return thenable;
      },
    });

    await P.reconcileCascades();

    assert.deepEqual(arr(E.cascades).map(c=>c.id).sort(), ["R1","R2"],
      "an account row this device previously confirmed but no longer holds locally must be pulled back down, not skipped as \"already deleted\"");
  } finally{ signOut(E); }
});

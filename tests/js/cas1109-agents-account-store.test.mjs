// CAS-1109: agents move onto the account store (CAS-1094+) — the client/legacy cascades diff sync
// (cascadeKnown/cascadeEditedAt/cascadeDirtyRows/scheduleSync/runSync/syncToAccount/reconcileCascades/
// resolveCascadeConflict, the CAS-1090 explicit-tombstone delete, the CAS-1035 cascades outbox) is gone —
// create is an acctOp insert with a client-generated uuid, an edit is an acctOp update of only the changed
// columns with the account's own updated_at as the conflict check, and delete is one immediate
// rpc("delete_agent") call. These tests drive the real seams (CascadePersistence.syncCascadesToAccount,
// deleteAgentAsk) against a stubbed Supabase client, the same fake-client conventions
// cas1096-account-store.test.mjs/cas1097-agent-films-acctop.test.mjs use for the other acctOp-backed tables.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// acctOp's real shapes against the cascades table: an "insert" calls .upsert(fullRow, {onConflict:"id",
// ignoreDuplicates:true}); an "update" calls .update(fields).match(match).eq("updated_at", v).select(); a
// delete is rpc("delete_agent", {p_id}), never a raw .delete() on the table at all (CAS-1102).
function makeFakeClient({ updateResult } = {}){
  const upsertCalls = [];
  const updateCalls = [];
  const deleteCalls = [];
  const rpcCalls = [];
  return {
    upsertCalls, updateCalls, deleteCalls, rpcCalls,
    rpc(name, params){
      rpcCalls.push({ name, params });
      return Promise.resolve({ data: null, error: null });
    },
    from(table){
      return {
        upsert(fields){
          upsertCalls.push({ table, fields });
          return { then(resolve){ return Promise.resolve({ data: [fields], error: null }).then(resolve); } };
        },
        update(fields){
          const call = { table, fields };
          updateCalls.push(call);
          const chain = {
            match(m){ call.match = m; return chain; },
            eq(col, v){ call.eq = { col, v }; return chain; },
            select(){
              const result = updateResult ? updateResult(call) : { data: [{ ...call.match, ...fields }], error: null };
              return Promise.resolve(result);
            },
          };
          return chain;
        },
        delete(){
          const chain = {
            eq(){ return chain; }, in(){ return chain; }, match(){ return chain; },
            then(resolve){ deleteCalls.push({ table }); return Promise.resolve({ data: [], error: null }).then(resolve); },
          };
          return chain;
        },
      };
    },
  };
}
function signIn(E, client, userId = "cas1109-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
// Seeds CascadeAccountStore's own cascades mirror directly, the same "the account already confirms this
// row" signal loadAccount's acctLoad would otherwise populate — so a test can exercise an EDIT (update)
// without first driving a full fake acctLoad round trip.
function seedKnown(E, row){
  const store = E.CascadeAccountStore.acctStore;
  store.cascades = [...(store.cascades||[]).filter(r => r.id !== row.id), row];
}
const settle = () => new Promise(r => setTimeout(r, 0));

test("CAS-1109 AC2: deleting agent B issues exactly one delete_agent(B) rpc call and no other delete", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  const idA = "a0000000-0000-4000-8000-000000000001";
  const idB = "b0000000-0000-4000-8000-000000000002";
  const a = E.normCascade({ id: idA, name: "Agent A" });
  const b = E.normCascade({ id: idB, name: "Agent B" });
  E.cascades.length = 0; E.cascades.push(a, b);
  signIn(E, client);
  seedKnown(E, { ...E.CascadeShape.cascadeToRow(a), user_id: "cas1109-test-user", updated_at: "2026-01-01T00:00:00.000Z" });
  seedKnown(E, { ...E.CascadeShape.cascadeToRow(b), user_id: "cas1109-test-user", updated_at: "2026-01-01T00:00:00.000Z" });
  try {
    assert.equal(E.deleteAgentAsk(b), true, "the real delete path must report the delete as having happened");
    assert.equal(E.cascades.some(c => c.id === idB), false, "B must be gone from the live array immediately");
    assert.equal(E.cascades.some(c => c.id === idA), true, "A must be untouched");
    await settle();

    const cascadeRpcs = client.rpcCalls.filter(c => c.name === "delete_agent");
    assert.equal(cascadeRpcs.length, 1, "exactly one delete_agent rpc call");
    assert.equal(cascadeRpcs[0].params.p_id, idB, "the one rpc call must name agent B, and only B");
    assert.equal(client.deleteCalls.length, 0, "no raw table delete of any kind — CAS-1102 revoked it client-side");
  } finally {
    E.cascades.length = 0;
    signOut(E);
  }
});

test("CAS-1109: creating a new agent issues exactly one insert carrying the full row, under this device's own client-generated id", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  const id = "c0000000-0000-4000-8000-000000000003";
  signIn(E, client);
  E.cascades.length = 0;
  E.cascades.push(E.normCascade({ id, name: "Brand New" }));
  try {
    E.CascadePersistence.syncCascadesToAccount();
    await settle();
    const calls = client.upsertCalls.filter(c => c.table === "cascades");
    assert.equal(calls.length, 1, "exactly one insert for the one new agent");
    assert.equal(calls[0].fields.id, id);
    assert.equal(calls[0].fields.name, "Brand New");
    assert.equal(client.updateCalls.length, 0, "a brand new row is never also updated");
  } finally {
    E.cascades.length = 0;
    signOut(E);
  }
});

test("CAS-1109: a rename on an already-confirmed agent issues exactly one update of only the name column, conflict-checked against the account's own updated_at", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  const id = "d0000000-0000-4000-8000-000000000004";
  const c = E.normCascade({ id, name: "Old Name" });
  E.cascades.length = 0; E.cascades.push(c);
  signIn(E, client);
  seedKnown(E, { id, user_id: "cas1109-test-user", name: "Old Name", criteria: E.CascadeShape.cascadeToRow(c).criteria,
    alert_moments: E.CascadeShape.cascadeToRow(c).alert_moments, active: true, updated_at: "2026-02-01T00:00:00.000Z" });
  try {
    c.name = "New Name";
    E.CascadePersistence.syncCascadesToAccount();
    await settle();
    const calls = client.updateCalls.filter(c2 => c2.table === "cascades");
    assert.equal(calls.length, 1, "exactly one update for the one changed agent");
    assert.deepEqual(Object.keys(calls[0].fields), ["name"], "only the column that actually changed travels");
    assert.equal(calls[0].fields.name, "New Name");
    assert.equal(calls[0].eq.col, "updated_at");
    assert.equal(calls[0].eq.v, "2026-02-01T00:00:00.000Z", "conflict-checked against the account's own last-known updated_at");
    assert.equal(client.upsertCalls.length, 0, "an already-known row is never also inserted");
  } finally {
    E.cascades.length = 0;
    signOut(E);
  }
});

test("CAS-1109: a round trip through rowToCascade/cascadeToRow alone (no real edit) pushes nothing", async () => {
  // CAS-743/CAS-1132 regression guard: the account's raw stored row can predate a criteria field normCascade
  // now fills with a default — comparing it RAW against the live (normalized) cascade would make every
  // untouched row look dirty on every sign-in. syncCascadesToAccount must compare like for like.
  const E = loadEngine();
  const client = makeFakeClient();
  const id = "e0000000-0000-4000-8000-000000000005";
  // Built through the real cascadeToRow (not hand-rolled) so alert_moments/criteria are exactly what this
  // agent's own normCascade defaults compute — see acct-namespacing.test.mjs's identical note.
  const rawRowBase = E.CascadeShape.cascadeToRow(E.normCascade({ id, name: "Untouched" }));
  const rawRow = { ...rawRowBase, user_id: "cas1109-test-user", updated_at: "2026-01-01T00:00:00.000Z" };
  signIn(E, client);
  E.cascades.length = 0;
  E.cascades.push(E.CascadeShape.rowToCascade(rawRow));   // the exact normalization loadAccount's own read path applies
  seedKnown(E, rawRow);
  try {
    E.CascadePersistence.syncCascadesToAccount();
    await settle();
    assert.equal(client.upsertCalls.length, 0, "no insert — the account already confirms this row");
    assert.equal(client.updateCalls.length, 0, "no update — normCascade filling in newer defaults on read is not a real edit");
  } finally {
    E.cascades.length = 0;
    signOut(E);
  }
});

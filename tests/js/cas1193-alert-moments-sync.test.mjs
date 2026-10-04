// CAS-1193: syncCascadesToAccount compared alert_moments against `known` — cascadeToRow(rowToCascade(knownRaw))
// — instead of the stored `knownRaw`. cascadeToRow always recomputes alert_moments from the account's CURRENT
// Where & when Watch switches (momentsOf), so known.alert_moments was identical to row.alert_moments by
// construction and the staleness check could never fire: an agent's alert_moments column was written once at
// create time and never corrected after a switch changed. Same fake-client conventions as
// cas1109-agents-account-store.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function makeFakeClient(){
  const upsertCalls = [];
  const updateCalls = [];
  return {
    upsertCalls, updateCalls,
    rpc(){ return Promise.resolve({ data: null, error: null }); },
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
            select(){ return Promise.resolve({ data: [{ ...call.match, ...fields }], error: null }); },
          };
          return chain;
        },
      };
    },
  };
}
function signIn(E, client, userId = "cas1193-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
function seedKnown(E, row){
  const store = E.CascadeAccountStore.acctStore;
  store.cascades = [...(store.cascades||[]).filter(r => r.id !== row.id), row];
}
const settle = () => new Promise(r => setTimeout(r, 0));

test("CAS-1193: a stale stored alert_moments is corrected to the account's current six-moment list", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  const id = "f0000000-0000-4000-8000-000000000006";
  // Default watchPrefs (upcoming list+both subs, in_cinema, rent, stream on; premium off) is exactly the
  // lee+c21 Service tracking state from the ticket, and yields six live moments for a fully-reachable agent.
  E.setWatchPrefs(E.watchPrefsDefaults());
  const c = E.normCascade({ id, name: "Massive Movies" });
  E.cascades.length = 0; E.cascades.push(c);
  signIn(E, client);
  const freshRow = E.CascadeShape.cascadeToRow(c);
  // JSON.stringify, not deepEqual: cascadeToRow runs inside the vm sandbox, whose arrays carry a different
  // realm's Array.prototype — node:assert/strict's deepEqual is deepStrictEqual, which compares prototypes
  // and fails even on structurally identical arrays across that boundary (see the same note in
  // cas1123-watch-notify-merge.test.mjs).
  assert.equal(JSON.stringify(freshRow.alert_moments),
    JSON.stringify(["hits_cinema", "past_opening_weekend", "announced", "opens_soon", "hits_rent", "hits_stream"]),
    "sanity check: current switches must derive all six moments");
  // The stored row is what the onboarding-time create actually wrote — three moments, from before Upcoming's
  // and Rent's switches were turned on — and must never be silently normalized away before the comparison.
  seedKnown(E, { ...freshRow, alert_moments: ["hits_cinema", "past_opening_weekend", "hits_stream"],
    updated_at: "2026-10-02T00:00:00.000Z" });
  try {
    E.CascadePersistence.syncCascadesToAccount();
    await settle();
    const calls = client.updateCalls.filter(c2 => c2.table === "cascades");
    assert.equal(calls.length, 1, "exactly one update for the one agent with a stale alert_moments");
    assert.deepEqual(Object.keys(calls[0].fields), ["alert_moments"], "only alert_moments travels");
    assert.equal(JSON.stringify(calls[0].fields.alert_moments),
      JSON.stringify(["hits_cinema", "past_opening_weekend", "announced", "opens_soon", "hits_rent", "hits_stream"]),
      "the corrected value must be the full, current six-moment list");
  } finally {
    E.cascades.length = 0;
    signOut(E);
  }
});

test("CAS-1193: a stored alert_moments that already matches the current switches queues no update", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  const id = "f0000000-0000-4000-8000-000000000007";
  E.setWatchPrefs(E.watchPrefsDefaults());
  const c = E.normCascade({ id, name: "Already Correct" });
  E.cascades.length = 0; E.cascades.push(c);
  signIn(E, client);
  const freshRow = E.CascadeShape.cascadeToRow(c);
  seedKnown(E, { ...freshRow, updated_at: "2026-10-05T00:00:00.000Z" });
  try {
    E.CascadePersistence.syncCascadesToAccount();
    await settle();
    const calls = client.updateCalls.filter(c2 => c2.table === "cascades");
    assert.equal(calls.length, 0, "no update — the stored value already matches what the switches derive");
  } finally {
    E.cascades.length = 0;
    signOut(E);
  }
});

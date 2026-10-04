// CAS-1198: a per-agent Alerts switch, reintroduced after CAS-843 removed the last one. Massive Movies
// starts alerting; every other agent — onboarding, preset or hand-built — starts quiet. Same fake-client
// conventions as cas1193-alert-moments-sync.test.mjs for the AC3 save-path test.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function makeFakeClient(){
  const updateCalls = [];
  return {
    updateCalls,
    rpc(){ return Promise.resolve({ data: null, error: null }); },
    from(table){
      return {
        upsert(fields){
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
function signIn(E, client, userId = "cas1198-test-user"){
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

test("AC1: normCascade defaults alertsOn true only for template onb_massive, and keeps a stored value", () => {
  const E = loadEngine();
  assert.equal(E.normCascade({ template: "onb_massive" }).alertsOn, true);
  assert.equal(E.normCascade({ template: "onb_favs" }).alertsOn, false);
  assert.equal(E.normCascade({}).alertsOn, false);
  assert.equal(E.normCascade({ template: "onb_massive", alertsOn: false }).alertsOn, false,
    "a stored false is never overwritten by the template default");
  assert.equal(E.normCascade({ template: "onb_other", alertsOn: true }).alertsOn, true,
    "a stored true is never overwritten");
});

test("AC2: alertsOn false empties liveAlerts and alert_moments; alertsOn true gives the full derived list", () => {
  const E = loadEngine();
  E.setWatchPrefs(E.watchPrefsDefaults());   // Service tracking switched fully on
  const off = E.normCascade({ id: "cas1198-off", name: "Off agent", alertsOn: false });
  const on  = E.normCascade({ id: "cas1198-on",  name: "On agent",  alertsOn: true });
  // JSON.stringify, not deepEqual: these arrays are built inside the vm sandbox, whose Array.prototype
  // is a different realm's — node:assert/strict's deepEqual is deepStrictEqual, which compares
  // prototypes and fails even on structurally identical arrays across that boundary (see the same note
  // in cas1193-alert-moments-sync.test.mjs).
  assert.equal(JSON.stringify(E.liveAlerts(off)), "[]");
  assert.equal(JSON.stringify(E.CascadeShape.momentsOf(off)), "[]");
  assert.ok(E.liveAlerts(on).length > 0, "sanity check: the same account switches derive a non-empty list");
  assert.ok(E.CascadeShape.momentsOf(on).length > 0);
  assert.equal(JSON.stringify(E.liveAlerts(on)), JSON.stringify(E.liveAlerts(E.normCascade({ id: "x", alertsOn: true }))),
    "an alerts-on agent's list is exactly the account-derived one, same as any other alerts-on agent");
});

test("AC3: toggling alertsOn and saving queues an alert_moments update, and moves nothing else", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  const id = "f0000000-0000-4000-8000-0000000c1198";
  E.setWatchPrefs(E.watchPrefsDefaults());
  const c = E.normCascade({ id, name: "Toggle Me", alertsOn: false });
  E.cascades.length = 0; E.cascades.push(c);
  signIn(E, client);
  try {
    const beforeSig = E.cascSigOf(c);
    const beforeListed = E.listedCount(c);
    const beforeNew = E.newlyAddedCount(c);
    const offRow = E.CascadeShape.cascadeToRow(c);
    assert.equal(JSON.stringify(offRow.alert_moments), "[]", "sanity check: alerts-off agent writes no moments");
    seedKnown(E, { ...offRow, updated_at: "2026-10-05T00:00:00.000Z" });

    c.alertsOn = true;   // the switch, toggled and saved — same mutation commitDraft's whitelist copy makes
    E.normCascade(c);
    E.CascadePersistence.syncCascadesToAccount();
    await settle();

    assert.equal(E.cascSigOf(c), beforeSig, "cascSigOf must not move just because alertsOn changed");
    assert.equal(E.listedCount(c), beforeListed, "the agent's listed count must not move");
    assert.equal(E.newlyAddedCount(c), beforeNew, "the agent's newly-added count must not move");

    const calls = client.updateCalls.filter(x => x.table === "cascades");
    assert.equal(calls.length, 1, "exactly one update queued for the toggle");
    const onRow = E.CascadeShape.cascadeToRow(c);
    assert.ok(onRow.alert_moments.length > 0, "sanity check: alerts-on now derives real moments");
    assert.equal(JSON.stringify(calls[0].fields.alert_moments), JSON.stringify(onRow.alert_moments));
  } finally {
    E.cascades.length = 0;
    signOut(E);
  }
});

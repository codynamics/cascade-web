// CAS-1097: agent_films stops being a whole-set diff sync — the client now pushes ONE acctOp upsert the
// first time a (cascade,movie) is ever admitted on this device, never again, and never a delete; the LOCAL
// ledger (agentFilms, read by recomputeFound's own sticky-admission/placement logic) still updates on
// every recomputeFound pass exactly as before (CAS-726/728) — only the SERVER push changed. Drives the
// real seam (CascadePersistence.setAgentFilm/clearAgentFilm -> pushAgentFilmAdmission ->
// CascadeAccountStore.acctOp) against a stubbed Supabase client, the same convention
// cas1096-account-store.test.mjs uses for the other acctOp-backed tables.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function makeFakeClient(){
  const upsertCalls = [];
  const deleteCalls = [];
  return {
    upsertCalls, deleteCalls,
    from(table){
      return {
        upsert(row){
          upsertCalls.push({ table, row });
          return { then(resolve){ return Promise.resolve({ data: [row], error: null, status: 201 }).then(resolve); } };
        },
        delete(){
          const chain = {
            match(obj){ deleteCalls.push({ table, match: obj }); return chain; },
            then(resolve){ return Promise.resolve({ data: [], error: null, status: 200 }).then(resolve); },
          };
          return chain;
        },
      };
    },
  };
}
function signIn(E, client, userId = "cas1097-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
const settle = () => new Promise(r => setTimeout(r, 0));

test("CAS-1097: a film's first admission on an agent issues exactly one agent_films upsert", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  const cascadeId = "cas1097-agent-a";
  signIn(E, client);
  E.CascadePersistence.cascadeKnown.set(cascadeId, { sig: "known" });
  try {
    E.CascadePersistence.setAgentFilm(cascadeId, 9700001,
      { admission_score: 72, admission_status: "stream", agent_sig: "sig-1" });
    await settle();
    const calls = client.upsertCalls.filter(c => c.table === "agent_films");
    assert.equal(calls.length, 1, "exactly one upsert for the film's first admission");
    assert.equal(calls[0].row.cascade_id, cascadeId);
    assert.equal(calls[0].row.movie_id, "9700001");
    assert.equal(calls[0].row.admission_score, 72);
  } finally {
    E.CascadePersistence.cascadeKnown.delete(cascadeId);
    signOut(E);
  }
});

test("CAS-1097: re-confirming an already-known admission (criteria drift re-test) pushes nothing further", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  const cascadeId = "cas1097-agent-b";
  signIn(E, client);
  E.CascadePersistence.cascadeKnown.set(cascadeId, { sig: "known" });
  try {
    E.CascadePersistence.setAgentFilm(cascadeId, 9700002,
      { admission_score: 55, admission_status: "stream", agent_sig: "sig-1" });
    await settle();
    client.upsertCalls.length = 0;
    // The same shape recomputeFound's own stillIn-refresh branch calls, re-stamping agent_sig on an
    // already-admitted row without changing admission_score/admitted_at.
    E.CascadePersistence.setAgentFilm(cascadeId, 9700002,
      { admission_score: 55, admission_status: "stream", agent_sig: "sig-2" });
    await settle();
    assert.equal(client.upsertCalls.filter(c => c.table === "agent_films").length, 0,
      "a row this device already pushed once must never be upserted again");
    assert.equal(E.CascadePersistence.getAgentFilm(cascadeId, 9700002).agent_sig, "sig-2",
      "the LOCAL ledger still refreshes agent_sig even though nothing was pushed to the account");
  } finally {
    E.CascadePersistence.cascadeKnown.delete(cascadeId);
    signOut(E);
  }
});

test("CAS-1097: clearAgentFilm (a film leaving an agent's current set) never issues a delete", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  const cascadeId = "cas1097-agent-c";
  signIn(E, client);
  E.CascadePersistence.cascadeKnown.set(cascadeId, { sig: "known" });
  try {
    E.CascadePersistence.setAgentFilm(cascadeId, 9700003,
      { admission_score: 60, admission_status: "stream", agent_sig: "sig-1" });
    await settle();
    E.CascadePersistence.clearAgentFilm(cascadeId, 9700003);
    await settle();
    assert.equal(client.deleteCalls.filter(c => c.table === "agent_films").length, 0,
      "ordinary recomputation leaving a film out of an agent's current set must never delete its account history");
    assert.ok(!E.CascadePersistence.getAgentFilm(cascadeId, 9700003),
      "the LOCAL ledger still clears, so recomputeFound's own membership/sticky logic is unaffected");
  } finally {
    E.CascadePersistence.cascadeKnown.delete(cascadeId);
    signOut(E);
  }
});

test("CAS-1097/CAS-1064: a push for a cascade this device holds but the account hasn't confirmed yet waits, then sends once confirmed", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  const cascadeId = "cas1097-agent-d";
  const savedDefer = E.CascadePersistence.AGENT_FILM_DEFER_MS;
  E.CascadePersistence.AGENT_FILM_DEFER_MS = 10;
  signIn(E, client);
  E.cascades.push({ id: cascadeId, order: 1 });
  try {
    E.CascadePersistence.setAgentFilm(cascadeId, 9700004,
      { admission_score: 80, admission_status: "stream", agent_sig: "sig-1" });
    await settle();
    assert.equal(client.upsertCalls.filter(c => c.table === "agent_films").length, 0,
      "must not race the cascade's own still-unconfirmed upsert");
    E.CascadePersistence.cascadeKnown.set(cascadeId, { sig: "known" });
    await new Promise(r => setTimeout(r, 50));   // past the (shrunk) re-check interval
    assert.equal(client.upsertCalls.filter(c => c.table === "agent_films").length, 1,
      "the deferred push must fire once the cascade is confirmed");
  } finally {
    E.cascades.length = 0;
    E.CascadePersistence.cascadeKnown.delete(cascadeId);
    E.CascadePersistence.AGENT_FILM_DEFER_MS = savedDefer;
    signOut(E);
  }
});

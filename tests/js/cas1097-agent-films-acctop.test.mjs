// CAS-1097: agent_films stops being a whole-set diff sync — the client now pushes ONE acctOp upsert the
// first time a (cascade,movie) is ever admitted on this device, never again, and never a delete; the LOCAL
// ledger (agentFilms, read by recomputeFound's own sticky-admission/placement logic) still updates on
// every recomputeFound pass exactly as before (CAS-726/728) — only the SERVER push changed. Drives the
// real seam (CascadePersistence.setAgentFilm/clearAgentFilm -> pushAgentFilmAdmission ->
// CascadeAccountStore.acctOp) against a stubbed Supabase client, the same convention
// cas1096-account-store.test.mjs uses for the other acctOp-backed tables.
//
// CAS-1136: pushAgentFilmAdmission no longer sends one upsert per admission straight away — every admission
// queued within one synchronous pass (recomputeFound's own first-sign-in sweep, chiefly) now batches into
// one "upsert_many" acctOp op, sent as a single multi-row request (see flushAgentFilmPushes/the acctOp
// "upsert_many" kind in app_template.html). The fake client's upsert() therefore always receives an ARRAY
// of rows, even a batch of one — every assertion below indexes into that array rather than reading a bare
// row off the call.
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
        upsert(rows){
          upsertCalls.push({ table, rows });
          return { then(resolve){ return Promise.resolve({ data: rows, error: null, status: 201 }).then(resolve); } };
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
    assert.equal(calls.length, 1, "exactly one upsert request for the film's first admission");
    assert.equal(calls[0].rows.length, 1, "that request carries exactly one row");
    assert.equal(calls[0].rows[0].cascade_id, cascadeId);
    assert.equal(calls[0].rows[0].movie_id, "9700001");
    assert.equal(calls[0].rows[0].admission_score, 72);
  } finally {
    E.CascadePersistence.cascadeKnown.delete(cascadeId);
    signOut(E);
  }
});

test("CAS-1136: several admissions queued within one synchronous pass batch into a single upsert request", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  const cascadeId = "cas1136-agent-batch";
  signIn(E, client);
  E.CascadePersistence.cascadeKnown.set(cascadeId, { sig: "known" });
  try {
    // recomputeFound's own first-sign-in sweep calls setAgentFilm once per newly-matched film, all within
    // one synchronous pass — this is the shape that used to cost one serialized request per film.
    for(let i=0; i<5; i++){
      E.CascadePersistence.setAgentFilm(cascadeId, 9701000+i,
        { admission_score: 70+i, admission_status: "stream", agent_sig: "sig-1" });
    }
    await settle();
    const calls = client.upsertCalls.filter(c => c.table === "agent_films");
    assert.equal(calls.length, 1, "five admissions queued in one pass must cost exactly one request");
    assert.equal(calls[0].rows.length, 5, "the one request carries every queued admission");
    // JSON.stringify, not assert.deepEqual: calls[0].rows was built inside the vm-loaded engine (a
    // different realm), so comparing it against a literal array here trips assert/strict's prototype
    // check even when every element already matches — the same dodge client-health-events.test.mjs uses.
    const movieIds = calls[0].rows.map(r => r.movie_id).sort();
    assert.equal(JSON.stringify(movieIds), JSON.stringify(["9701000","9701001","9701002","9701003","9701004"]));
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

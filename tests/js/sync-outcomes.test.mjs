// CAS-787: a failed account WRITE used to be invisible — `if(error) console.warn(...)` and nothing else,
// which is exactly how CAS-740's schema drift disabled user_prefs syncing for every user, on every device,
// for weeks (nobody reads a phone's console). recordSyncOutcome/syncOutcomeReport/anySyncTargetDegraded are
// the fix: one outcome per sync target, read by the on-device diagnostics panel and by the in-app degraded
// indicator. CAS-1095 moved user_prefs off the whole-row upsert (syncUserPrefsNow) onto acctOp's per-column
// update, with the outcome hook wired through acctOp's own onDone callback (see pushUserPrefsCols in
// app_template.html) — these tests now drive that real seam (CascadePersistence.pushUserPrefsCols) with a
// stubbed Supabase client, the same convention acct-read.test.mjs and CAS-740's own tests use.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// A minimal fake client that only ever serves acctOp "update" calls against ONE table
// (update(fields).match(m).select()), replaying a queued sequence of errors (or null for success) — the
// last entry repeats once the queue is exhausted, so a test can drive as many attempts as it needs from a
// short list. A non-null error is a permanent (4xx) failure — acctOp never retries one, matching how a real
// schema-cache error behaves.
function fakeUpsertClient(table, errQueue){
  let i = 0;
  return {
    from(t){
      assert.equal(t, table, `this fake only serves ${table}`);
      const b = {
        update(fields){ b._fields = fields; return b; },
        match(m){ b._match = m; return b; },
        select(){
          const err = errQueue[Math.min(i, errQueue.length - 1)];
          i++;
          const result = err ? { data: null, error: err, status: 400 } : { data: [b._fields], error: null, status: 200 };
          return { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
        },
      };
      return b;
    },
  };
}
function signIn(client, userId = "cas787-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
  E.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [0, 0, 0];
}
function signOut(){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
// A clean slate for one target's tracking state — recordSyncOutcome derives everything (including the
// degraded flag) from the previous record, so removing it is enough to reset both.
function resetTarget(target){
  delete E.CascadePersistence.syncOutcome[target];
}
function withCas787State(fn){
  return (async () => {
    try { await fn(); }
    finally { resetTarget("user_prefs"); signOut(); }
  })();
}

test("CAS-787 AC1/AC4: a failed user_prefs push is recorded with the verbatim error, and a schema-cache message is labelled a missing column", () => withCas787State(async () => {
  const client = fakeUpsertClient("user_prefs", [
    { message: "Could not find the 'framing' column of 'user_prefs' in the schema cache" },
  ]);
  signIn(client);
  await E.CascadePersistence.pushUserPrefsCols(["framing"]);

  const outcome = E.CascadePersistence.syncOutcome.user_prefs;
  assert.equal(outcome.ok, false, "a failed push must record ok:false");
  assert.match(outcome.error, /framing/, "the diagnostics panel must show the error message verbatim");
  assert.equal(outcome.schemaDrift, true, "PostgREST's missing-column shape must be classified as schema drift, not a generic failure");

  const text = E.diagReportText();
  assert.match(text, /user_prefs: FAILED — missing column/, "the copyable report must name user_prefs, mark it failed, and call out the missing column");
  assert.match(text, /framing/, "the copyable report must include the verbatim error");
}));

test("CAS-787 AC2: after a successful user_prefs push, the outcome reads succeeded with the time of the attempt", () => withCas787State(async () => {
  const before = Date.now();
  signIn(fakeUpsertClient("user_prefs", [null]));
  await E.CascadePersistence.pushUserPrefsCols(["taste"]);

  const outcome = E.CascadePersistence.syncOutcome.user_prefs;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.error, null);
  assert.ok(outcome.when >= before, "the recorded time must be from this attempt");
  assert.match(E.diagReportText(), /user_prefs: OK/);
}));

test("CAS-787 AC3: every account sync target on the persistence seam appears in the report, not just user_prefs", () => {
  const targets = E.CascadePersistence.syncOutcomeReport().map(r => r.target);
  // CAS-863: watchlists retired — it stopped reading/writing the watchlists table, so it is no longer a
  // sync target here either.
  ["cascades", "user_films",
   "notify_prefs", "film_picks", "film_watch", "agent_films", "user_prefs"].forEach(t => {
    assert.ok(targets.includes(t), `${t} is missing from the sync outcome report`);
  });
});

test("CAS-787: a target never attempted this session reads as such, not as a false success or failure", () => {
  resetTarget("agent_films");
  const row = E.CascadePersistence.syncOutcomeReport().find(r => r.target === "agent_films");
  assert.equal(row.when, null);
  assert.equal(row.ok, null);
  assert.match(E.diagReportText(), /agent_films: not yet attempted/);
});

test("CAS-787 AC5: a single failure stays quiet; a second consecutive failure on the same target raises the indicator", () => withCas787State(async () => {
  signIn(fakeUpsertClient("user_prefs", [{ message: "down" }, { message: "down" }]));
  await E.CascadePersistence.pushUserPrefsCols(["taste"]);   // 1st failure — a lone blip
  assert.equal(E.CascadePersistence.anySyncTargetDegraded(), false, "a single failure must not raise the indicator");
  assert.doesNotMatch(E.CascadePersistence.acctBannerText() || "", /Account sync isn't working/);

  await E.CascadePersistence.pushUserPrefsCols(["taste"]);   // 2nd failure IN A ROW
  assert.equal(E.CascadePersistence.anySyncTargetDegraded(), true, "two consecutive failures must raise the indicator");
  assert.match(E.CascadePersistence.acctBannerText(), /Account sync isn't working/);
}));

test("CAS-787 AC6: the degraded indicator rides the existing non-modal account banner, not a new dialog", () => withCas787State(async () => {
  signIn(fakeUpsertClient("user_prefs", [{ message: "down" }, { message: "down" }]));
  await E.CascadePersistence.pushUserPrefsCols(["taste"]);
  await E.CascadePersistence.pushUserPrefsCols(["taste"]);
  const text = E.CascadePersistence.acctBannerText();
  // acctBannerText is the pure decision half of #acctBanner (role="status", aria-live="polite") — reusing
  // it is what keeps this indicator non-blocking; it never renders as a dialog and is a single string, not
  // a per-render toast.
  assert.equal(typeof text, "string");
  assert.match(text, /Account sync isn't working right now/);
}));

test("CAS-787 AC7: once a degraded target's next attempt succeeds, the indicator clears immediately, with no reload", () => withCas787State(async () => {
  signIn(fakeUpsertClient("user_prefs", [{ message: "down" }, { message: "down" }, null]));
  await E.CascadePersistence.pushUserPrefsCols(["taste"]);
  await E.CascadePersistence.pushUserPrefsCols(["taste"]);
  assert.equal(E.CascadePersistence.anySyncTargetDegraded(), true, "sanity: degraded after two consecutive failures");

  await E.CascadePersistence.pushUserPrefsCols(["taste"]);   // recovers
  assert.equal(E.CascadePersistence.anySyncTargetDegraded(), false, "a successful attempt must clear the degraded flag immediately");
  assert.doesNotMatch(E.CascadePersistence.acctBannerText() || "", /Account sync isn't working/);
}));

test("CAS-787 AC9: the diagnostics report never includes the signed-in user id", () => withCas787State(async () => {
  signIn(fakeUpsertClient("user_prefs", [{ message: "down" }]), "super-secret-user-id-should-never-leak");
  await E.CascadePersistence.pushUserPrefsCols(["taste"]);
  assert.doesNotMatch(E.diagReportText(), /super-secret-user-id-should-never-leak/);
}));

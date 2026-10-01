// CAS-985: every uncaught error/rejection used to go to diagRecord and nowhere else — captured, then
// discarded unless a user happened to tap the About line five times. These tests drive the real client
// capture path (window.onerror, the unhandledrejection handler, the sync/auth failure choke points) and
// assert what actually reaches usage_events, the same convention sync-outcomes.test.mjs and CAS-787's own
// tests use for the account-sync seam.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function resetHealthEvents(){
  E.resetClientHealthEventCounts();
  E.clearUsageQueue();
}
function eventsOfType(type){
  return E.usageQueue.filter(q => q.type === type);
}
function fakeUpsertClient(table, errQueue){
  let i = 0;
  return {
    from(t){
      assert.equal(t, table, `this fake only serves ${table}`);
      return {
        upsert(rows){
          const err = errQueue[Math.min(i, errQueue.length - 1)];
          i++;
          // CAS-1097: acctOp's own isTransient(status) reads a top-level `status`, not anything nested in
          // `error` — a forced failure here must carry one, or acctOp treats it as a network blip (status
          // undefined is falsy, i.e. transient) and retries instead of ever calling onDone(false, ...).
          const result = err ? { data: null, error: err, status: err.status || 400 } : { data: rows, error: null, status: 200 };
          return { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
        },
      };
    },
  };
}
function signIn(client, userId = "cas985-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}

test.beforeEach(() => resetHealthEvents());

// ---- AC1: window.onerror -> exactly one client_error row, still tee'd to the diagnostics panel ---------
test("CAS-985 AC1: a deliberate throw produces exactly one client_error row carrying message/source/line/screen, and still appears in the diagnostics panel", () => {
  const before = E.diagLog.length;
  E.onerror("Cannot read property 'x' of undefined", "app_template.html", 4242, 7);

  const rows = eventsOfType("client_error");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.message, "Cannot read property 'x' of undefined");
  assert.equal(rows[0].data.source, "app_template.html");
  assert.equal(rows[0].data.line, 4242);
  assert.equal(typeof rows[0].data.screen, "string");
  assert.ok(rows[0].data.screen.length > 0);

  assert.equal(E.diagLog.length, before + 1, "diagRecord must still run — an added destination, not a replacement");
  assert.match(E.diagLog[E.diagLog.length - 1].msg, /Cannot read property/);
});

// ---- AC2: a rejected promise -> exactly one client_rejection row -----------------------------------------
test("CAS-985 AC2: a rejected promise produces one client_rejection row", () => {
  E.handleUnhandledRejection({ reason: new Error("boom") });
  const rows = eventsOfType("client_rejection");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.message, "boom");
});

// ---- AC3: rate limit -----------------------------------------------------------------------------------
test("CAS-985 AC3: forcing 50 consecutive errors in one session produces 10 rows, not 50", () => {
  for(let i = 0; i < 50; i++) E.onerror(`error #${i}`, "app.js", 1, 1);
  assert.equal(eventsOfType("client_error").length, 10);
});

test("CAS-985 AC3: the cap is per event type — client_rejection isn't starved by client_error's own cap", () => {
  for(let i = 0; i < 15; i++) E.onerror(`error #${i}`, "app.js", 1, 1);
  for(let i = 0; i < 15; i++) E.handleUnhandledRejection({ reason: new Error(`rej #${i}`) });
  assert.equal(eventsOfType("client_error").length, 10);
  assert.equal(eventsOfType("client_rejection").length, 10);
});

// ---- AC4: never a credential --------------------------------------------------------------------------
test("CAS-985 AC4: an email embedded in a thrown message is redacted before it reaches client_error", () => {
  E.onerror("failed to save for lee+c4@example.com", "app.js", 1, 1);
  const row = eventsOfType("client_error")[0];
  assert.doesNotMatch(row.data.message, /lee\+c4@example\.com/);
  assert.match(row.data.message, /\[redacted\]/);
});

test("CAS-985 AC4: authFailedPayload keeps only the Supabase error code, discarding message/email/password/token", () => {
  const payload = E.authFailedPayload({
    code: "invalid_credentials",
    message: "Invalid login credentials for lee+c4@example.com",
    email: "lee+c4@example.com",
    password: "hunter2",
    token: "abc.def.ghi",
  });
  // vm cross-realm: the sandbox's plain object isn't assert.deepEqual-reference-equal to a Node-realm one
  // even with identical structure — compare via JSON.stringify instead (same gotcha CAS-787's own tests hit).
  assert.equal(JSON.stringify(payload), JSON.stringify({ code: "invalid_credentials" }));
});

test("CAS-985 AC4: authFailedPayload never throws on a bare/undefined error and reports a null code", () => {
  assert.equal(JSON.stringify(E.authFailedPayload(undefined)), JSON.stringify({ code: null }));
  assert.equal(JSON.stringify(E.authFailedPayload({})), JSON.stringify({ code: null }));
});

// ---- sync_failed: table name + error code only, filtered to this ticket's five tables --------------------
test("CAS-985: logSyncFailed carries only the table name (this ticket's own \"agents\" label for cascades) and the error code", () => {
  E.logSyncFailed("cascades", { code: "PGRST301", message: "should never appear" });
  const row = eventsOfType("sync_failed")[0];
  assert.equal(JSON.stringify(row.data), JSON.stringify({ table: "agents", code: "PGRST301" }));
});

test("CAS-985: logSyncFailed is a no-op for a sync target outside this ticket's five named tables", () => {
  E.logSyncFailed("user_prefs", { code: "down" });
  E.logSyncFailed("notify_prefs", { code: "down" });
  E.logSyncFailed("film_picks", { code: "down" });
  assert.equal(eventsOfType("sync_failed").length, 0);
});

test("CAS-985: a cascades (agents) read that exhausts acctRead's 3 retries fires sync_failed", async () => {
  const CP = E.CascadePersistence;
  const savedDelays = CP.ACCT_READ_DELAYS;
  CP.ACCT_READ_DELAYS = [0, 0];
  try {
    await CP.acctRead("cascades", () => Promise.resolve({ data: null, error: { code: "PGRST301" } }));
    const row = eventsOfType("sync_failed")[0];
    assert.equal(JSON.stringify(row.data), JSON.stringify({ table: "agents", code: "PGRST301" }));
  } finally {
    CP.ACCT_READ_DELAYS = savedDelays;
  }
});

test("CAS-985: a failed agent_films push (the real recordSyncOutcome choke point) fires sync_failed", async () => {
  const cascadeId = "cas985-0000-4000-8000-000000000001";
  const m = E.MOVIES[0];
  try {
    signIn(fakeUpsertClient("agent_films", [{ code: "PGRST301", message: "down" }]));
    E.CascadePersistence.setAgentFilm(cascadeId, m.tmdb_id,
      { admission_score: 50, admission_status: "in_cinema", agent_sig: "sig" });
    await new Promise(r => setTimeout(r, 0));   // CAS-1097: let pushAgentFilmAdmission's own acctOp call resolve
    const row = eventsOfType("sync_failed")[0];
    assert.equal(JSON.stringify(row.data), JSON.stringify({ table: "agent_films", code: "PGRST301" }));
  } finally {
    E.CascadePersistence.clearAgentFilm(cascadeId, m.tmdb_id);
    signOut();
  }
});

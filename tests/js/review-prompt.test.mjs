// CAS-969: the App Store rating prompt's trigger conditions. reviewPromptEligible is the single named
// predicate every threshold lives in (AC3) — this drives it true and false across each boundary. The
// second block proves the "asked at most once per version" state really survives a reload (AC4) — CAS-1222
// moved both values off localStorage onto the account (user_prefs.view), so "survives a reload" is now
// proven by a fresh loadEngine() signed into the SAME account via a stubbed Supabase client (the fake-client
// convention cas1222-view-prefs.test.mjs/user-prefs-signin.test.mjs use), not a shared localStorage Map.
// The third proves the trigger path never gates anything else the app does (AC6).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// CAS-1222: a minimal stubbed client — just enough of acctLoad's select chain and acctOp's rpc call for
// loadUserPrefs()/pushViewField(Debounced) to round-trip a view patch, same shape as cas1222-view-prefs.
// test.mjs's own makeFakeClient.
function makeFakeClient(userPrefsRow){
  const rpcCalls = [];
  function builder(table){
    const b = {
      select(){ return b; }, order(){ return b; }, range(){ return b; },
      then(resolve){
        const data = table === "user_prefs" ? (userPrefsRow ? [userPrefsRow] : []) : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  }
  return {
    rpcCalls,
    from(table){ return builder(table); },
    rpc(name, params){ rpcCalls.push({ name, params }); return Promise.resolve({ data: null, error: null }); },
  };
}
function signIn(E, client, userId){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
const settle = () => new Promise(r => setTimeout(r, 0));

test("CAS-969 AC3: reviewPromptEligible — sessions boundary", () => {
  const base = { agentFoundMatch: true, askedVersion: null, currentVersion: "1.0.0" };
  assert.equal(E.reviewPromptEligible({ ...base, sessions: E.REVIEW_PROMPT_MIN_SESSIONS - 1 }), false,
    "one session short of the threshold must not be eligible");
  assert.equal(E.reviewPromptEligible({ ...base, sessions: E.REVIEW_PROMPT_MIN_SESSIONS }), true,
    "exactly the threshold must be eligible");
});

test("CAS-969 AC3: reviewPromptEligible — no agent match yet, regardless of sessions", () => {
  assert.equal(E.reviewPromptEligible({
    sessions: E.REVIEW_PROMPT_MIN_SESSIONS + 10, agentFoundMatch: false, askedVersion: null, currentVersion: "1.0.0",
  }), false, "no agent having found anything must block the prompt no matter how many sessions have passed");
});

test("CAS-969 AC3: reviewPromptEligible — already asked this version, not eligible again; a new version, eligible again", () => {
  const base = { sessions: E.REVIEW_PROMPT_MIN_SESSIONS, agentFoundMatch: true };
  assert.equal(E.reviewPromptEligible({ ...base, askedVersion: "1.0.0", currentVersion: "1.0.0" }), false,
    "already asked on this exact version must not ask again");
  assert.equal(E.reviewPromptEligible({ ...base, askedVersion: "1.0.0", currentVersion: "1.1.0" }), true,
    "a new version must be eligible again even if a prior version already asked");
  assert.equal(E.reviewPromptEligible({ ...base, askedVersion: null, currentVersion: "1.0.0" }), true,
    "never having asked must be eligible once the other thresholds are met");
});

test("CAS-969 AC4: the asked-this-version flag survives a reload — now via the account, not device storage", async () => {
  const userId = "cas969-ac4-user";
  const E1 = loadEngine();
  const client1 = makeFakeClient(null);
  signIn(E1, client1, userId);
  try{
    assert.equal(E1.reviewPromptAskedVersion(), null, "a fresh account must start with nothing recorded");
    E1.markReviewPromptAsked("1.0.0");
    assert.equal(E1.reviewPromptAskedVersion(), "1.0.0", "marking asked must read back immediately");
    await settle();
    const pushed = client1.rpcCalls.find(c => c.name === "merge_user_prefs_view" && "reviewAskedVer" in c.params.p_patch);
    assert.ok(pushed, "markReviewPromptAsked must actually reach the account");
    assert.equal(pushed.params.p_patch.reviewAskedVer, "1.0.0");
  } finally { signOut(E1); }

  // Simulate a reload: a brand new engine instance, signed into the SAME account, whose own user_prefs.view
  // now carries what E1 just pushed — the account round trip IS the reload now.
  const E2 = loadEngine();
  const client2 = makeFakeClient({ user_id: userId, view: { reviewAskedVer: "1.0.0" } });
  signIn(E2, client2, userId);
  try{
    await E2.CascadePersistence.loadUserPrefs();
    await settle();
    assert.equal(E2.reviewPromptAskedVersion(), "1.0.0", "AC4: the asked-this-version mark must survive a reload");
    assert.equal(
      E2.reviewPromptEligible({ sessions: 99, agentFoundMatch: true, askedVersion: E2.reviewPromptAskedVersion(), currentVersion: "1.0.0" }),
      false,
      "AC4: driving the trigger again after a reload, on the same version, must not re-arm the prompt"
    );
  } finally { signOut(E2); }
});

test("CAS-969 AC4: the session count itself survives a reload the same way — accumulated on the account", async () => {
  const userId = "cas969-ac4b-user";
  // The account already has 2 sessions recorded (e.g. from device A, a prior boot).
  const E2 = loadEngine();
  const client2 = makeFakeClient({ user_id: userId, view: { reviewSessions: 2 } });
  signIn(E2, client2, userId);
  try{
    // loadEngine()'s own boot already replayed the app's own app_open bump (exactly like a real page load),
    // so this device's pending +1 is waiting for the account's real count before it can push a true total.
    assert.equal(E2.reviewPromptSessionCount(), 1, "this device's own boot bump, visible immediately");

    await E2.CascadePersistence.loadUserPrefs();
    await settle();

    assert.equal(E2.reviewPromptSessionCount(), 3,
      "AC4: a reload must accumulate on top of the account's real count, not restart from this device's own 1");
    // CAS-1243 round 2: loadUserPrefs (a load) computes the accumulated count but must never push it itself
    // — the write rides piggyback on the next real user-action view write instead (no page-hidden trigger
    // any more; that also fires on an unloading/reloading document, not just a real user action).
    assert.equal(client2.rpcCalls.filter(c => c.name === "merge_user_prefs_view").length, 0,
      "loadUserPrefs itself must push nothing — only a real user-action view write may");

    E2.setActive("a0000000-0000-4000-8000-000000000098");
    await settle();

    const pushed = client2.rpcCalls.find(c => c.name === "merge_user_prefs_view" && "reviewSessions" in c.params.p_patch);
    assert.ok(pushed, "the accumulated count must ride piggyback on the next real user-action view write");
    assert.equal(pushed.params.p_patch.reviewSessions, 3);
  } finally { signOut(E2); }
});

test("CAS-969 AC6: marking a found film watched is unaffected by review-prompt eligibility, in either direction", () => {
  const id = 987660001;
  const savedWatched = new Set(E.watched);
  const savedFound = new Set(E.found);
  try{
    const e = E.entryFor(id);
    e.source = "manual";
    E.recomputeFound();
    assert.ok(E.found.has(id), "setup: the film must actually be in `found` for this to exercise the trigger's wasFound guard");

    // Not eligible (no sessions recorded yet in this engine instance) — must still mark watched normally.
    assert.doesNotThrow(() => E.setOpinion(id, "enjoyed"));
    assert.ok(E.watched.has(id), "AC6: the watched verdict must be recorded even when the review prompt is not eligible");

    // Now make it eligible (native plugin still absent in this sandbox, so the call itself is a no-op) —
    // must still behave identically, nothing withheld or delayed.
    for(let i = 0; i < E.REVIEW_PROMPT_MIN_SESSIONS; i++) E.bumpReviewPromptSessionCount();
    const id2 = 987660002;
    const e2 = E.entryFor(id2);
    e2.source = "manual";
    E.recomputeFound();
    assert.doesNotThrow(() => E.setOpinion(id2, "wow"));
    assert.ok(E.watched.has(id2), "AC6: the watched verdict must be recorded the same way when the review prompt IS eligible");
  } finally {
    E.watched.clear(); savedWatched.forEach(x => E.watched.add(x));
    E.found.clear(); savedFound.forEach(x => E.found.add(x));
  }
});

// CAS-1222: per-account view state (selected agent(s), per-tab my-services-only, the Found list as last
// looked at, tutorial seen, the two review-prompt values, the onboarding invite draft, the admission-drift
// diagnostic) moves off localStorage and onto the account (user_prefs.view), written through
// merge_user_prefs_view (migration 0009) rather than user_prefs' own whole-column upsert, since two devices
// can change different view fields at the same moment and a whole-column push would let whichever lands
// second clobber the first. These tests drive the real chokepoints (setActive, deleteAgentAsk,
// window.toggleWatchMineOnly, markTutorialSeen, bumpReviewPromptSessionCount/markReviewPromptAsked,
// agentState's saveAgentState, trackAdmitDrift via recomputeFound) against a stubbed Supabase client, the
// same fake-client convention cas1109-agents-account-store.test.mjs/user-prefs-signin.test.mjs use.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// Covers both acctLoad's read chain (select().order().range()) and acctOp's rpc/upsert shapes — same
// convention as user-prefs-signin.test.mjs's makeQueryBuilder, extended with the rpc tracking
// cas1109-agents-account-store.test.mjs uses for delete_agent.
function makeFakeClient(script){
  const calls = [];
  const rpcCalls = [];
  function builder(table){
    const state = { table, kind: "select" };
    const b = {
      select(cols){ state.selectCols = cols; return b; },
      order(){ return b; },
      range(){ return b; },
      upsert(fields, opts){ state.kind = "upsert"; state.fields = fields; state.opts = opts; return b; },
      update(fields){ state.kind = "update"; state.fields = fields; return b; },
      match(m){ state.match = m; return b; },
      then(resolve, reject){
        const snapshot = Object.assign({}, state);
        calls.push(snapshot);
        return Promise.resolve().then(() => script(snapshot)).then(resolve, reject);
      },
    };
    return b;
  }
  return {
    calls, rpcCalls,
    from(table){ return builder(table); },
    rpc(name, params){
      rpcCalls.push({ name, params });
      return Promise.resolve({ data: null, error: null });
    },
  };
}
function selectUserPrefsRow(row){
  return state => (state.table === "user_prefs" && state.kind === "select")
    ? { data: row ? [row] : [], error: null }
    : { data: [], error: null };
}
function signIn(E, client, userId = "cas1222-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
  E.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [0, 0, 0];
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
const settle = () => new Promise(r => setTimeout(r, 0));

test("CAS-1222: setActive pushes active+activeMulti as one merge_user_prefs_view rpc each, never a whole-row write", async () => {
  const E = loadEngine();
  const client = makeFakeClient(selectUserPrefsRow(null));
  signIn(E, client);
  try{
    const id = "a0000000-0000-4000-8000-000000000001";
    E.setActive(id);
    await settle();

    const mergeCalls = client.rpcCalls.filter(c => c.name === "merge_user_prefs_view");
    assert.equal(mergeCalls.length, 2, "one rpc for active, one for activeMulti");
    const patches = Object.assign({}, ...mergeCalls.map(c => c.params.p_patch));
    assert.equal(patches.active, id);
    assert.deepEqual([...patches.activeMulti], [id]);
    assert.equal(client.calls.filter(c => c.table === "user_prefs" && c.kind !== "select").length, 0,
      "never a whole-column user_prefs write for a view-only change");
  } finally {
    E.setActive(null);
    signOut(E);
  }
});

test("CAS-1222: deleting the selected agent pushes the corrected active/activeMulti", async () => {
  const E = loadEngine();
  const client = makeFakeClient(selectUserPrefsRow(null));
  const idA = "a0000000-0000-4000-8000-000000000001";
  const idB = "b0000000-0000-4000-8000-000000000002";
  const a = E.normCascade({ id: idA, name: "Agent A" });
  const b = E.normCascade({ id: idB, name: "Agent B" });
  E.cascades.length = 0; E.cascades.push(a, b);
  signIn(E, client);
  const store = E.CascadeAccountStore.acctStore;
  store.cascades = [
    { ...E.CascadeShape.cascadeToRow(a), user_id: "cas1222-test-user", updated_at: "2026-01-01T00:00:00.000Z" },
    { ...E.CascadeShape.cascadeToRow(b), user_id: "cas1222-test-user", updated_at: "2026-01-01T00:00:00.000Z" },
  ];
  try{
    E.setActive(idB);
    await settle();
    client.rpcCalls.length = 0;

    assert.equal(E.deleteAgentAsk(b), true);
    await settle();

    const mergeCalls = client.rpcCalls.filter(c => c.name === "merge_user_prefs_view");
    const patches = Object.assign({}, ...mergeCalls.map(c => c.params.p_patch));
    assert.equal(patches.active, idA, "falls back to the surviving agent");
    assert.deepEqual([...patches.activeMulti], [idA]);
  } finally {
    E.cascades.length = 0;
    E.setActive(null);
    signOut(E);
  }
});

test("CAS-1222: toggling my-services-only pushes the whole per-tab object under one key", async () => {
  const E = loadEngine();
  const client = makeFakeClient(selectUserPrefsRow(null));
  signIn(E, client);
  try{
    E.setWatchTab("stream");
    E.window.toggleWatchMineOnly();
    await settle();

    // toggleWatchMineOnly's own render() also settles the Found view, which marks it seen (CAS-70,
    // unrelated to this change) — filtering by key, not by total call count, since that push is real and
    // expected, just not what this test is about.
    const mergeCalls = client.rpcCalls.filter(c => c.name === "merge_user_prefs_view");
    const mineOnlyCalls = mergeCalls.filter(c => c.params.p_patch.mineOnly);
    assert.equal(mineOnlyCalls.length, 1);
    assert.equal(mineOnlyCalls[0].params.p_patch.mineOnly.stream, false, "stream's switch just flipped off");
    assert.equal(mineOnlyCalls[0].params.p_patch.mineOnly.rent, true, "every other tab is untouched");
  } finally {
    E.window.toggleWatchMineOnly();   // restore the default before the next test
    signOut(E);
  }
});

test("CAS-1222: markTutorialSeen/markReviewPromptAsked each push one named field", async () => {
  const E = loadEngine();
  const client = makeFakeClient(selectUserPrefsRow(null));
  signIn(E, client);
  try{
    assert.equal(E.tutorialSeen(), false, "sanity: fresh device default");
    E.markTutorialSeen();
    assert.equal(E.tutorialSeen(), true);

    const before = E.reviewPromptAskedVersion();
    assert.notEqual(before, "9.9.9");
    E.markReviewPromptAsked("9.9.9");
    await settle();

    const mergeCalls = client.rpcCalls.filter(c => c.name === "merge_user_prefs_view");
    assert.equal(mergeCalls.length, 2, "one for tutorialSeen, one for reviewAskedVer");
    const patches = Object.assign({}, ...mergeCalls.map(c => c.params.p_patch));
    assert.equal(patches.tutorialSeen, true);
    assert.equal(patches.reviewAskedVer, "9.9.9");
    assert.equal(E.reviewPromptAskedVersion(), "9.9.9");
  } finally {
    signOut(E);
  }
});

test("CAS-1222: a session bump queued before load resolves is replayed on top of the account's real count, never off the bare local default", async () => {
  const E = loadEngine();
  // The account already has 7 sessions recorded from other devices.
  const client = makeFakeClient(selectUserPrefsRow({ user_id: "cas1222-test-user", view: { reviewSessions: 7 } }));
  signIn(E, client);
  try{
    // loadEngine() just re-ran the WHOLE script from scratch, including its own app_open block — the same
    // boot-time bumpReviewPromptSessionCount() call a real page load makes, firing before this device's
    // own load has had any chance to resolve. The session count/pending-replay flag already reflect it.
    assert.equal(E.reviewPromptSessionCount(), 1, "boot's own bump, visible to this session immediately");

    await E.CascadePersistence.loadUserPrefs();
    await settle();

    assert.equal(E.reviewPromptSessionCount(), 8, "replayed as the account's 7 plus this session's own +1");
    // CAS-1243: loadUserPrefs (a load) computes the replayed count but must never push it itself — a
    // load/boot path must never write (CAS-1218). The write is deferred to the page-hidden path.
    assert.equal(client.rpcCalls.filter(c => c.name === "merge_user_prefs_view").length, 0,
      "loadUserPrefs itself must push nothing — only its own page-hidden seam may");

    E.CascadePersistence.flushReviewSessionsIfPending();
    await settle();

    const mergeCalls = client.rpcCalls.filter(c => c.name === "merge_user_prefs_view");
    const pushed = mergeCalls.find(c => typeof c.params.p_patch.reviewSessions === "number");
    assert.ok(pushed, "the replayed count must actually be pushed once the page-hidden seam fires");
    assert.equal(pushed.params.p_patch.reviewSessions, 8);
  } finally {
    signOut(E);
  }
});

test("CAS-1222: a SECOND loadUserPrefs this session, with nothing pending, simply adopts — no push", async () => {
  const E = loadEngine();
  const client = makeFakeClient(selectUserPrefsRow({ user_id: "cas1222-test-user", view: { reviewSessions: 4 } }));
  signIn(E, client);
  try{
    // loadEngine()'s own boot already set the pending-replay flag (see the previous test) — this first
    // load is what a real boot's own fireAccountFanout consumes it with, computing the replayed count.
    // CAS-1243: the write itself is deferred to the page-hidden path now, so this load alone pushes nothing.
    await E.CascadePersistence.loadUserPrefs();
    await settle();
    client.rpcCalls.length = 0;

    // A LATER reconcile re-loads with nothing pending this time — the scenario this test is actually
    // about — and must never push anything back.
    await E.CascadePersistence.loadUserPrefs();
    await settle();

    assert.equal(E.reviewPromptSessionCount(), 4, "the account's own count, adopted plainly");
    const mergeCalls = client.rpcCalls.filter(c => c.name === "merge_user_prefs_view");
    assert.equal(mergeCalls.length, 0, "a clean adoption with nothing pending must never write anything back");
  } finally {
    signOut(E);
  }
});

test("CAS-1222: the invite draft's saveAgentState debounces into one merge rpc naming the agent field", async () => {
  const E = loadEngine();
  const client = makeFakeClient(selectUserPrefsRow(null));
  signIn(E, client);
  const CP = E.CascadePersistence;
  const originalDebounce = CP.VIEW_DEBOUNCE_MS;
  CP.VIEW_DEBOUNCE_MS = 50_000;   // long enough that only an explicit flush below can fire it
  try{
    E.agentState.alerts = false;
    E.window.invToggle("learning");   // flips learning off, calls saveAgentState internally
    assert.equal(client.rpcCalls.length, 0, "debounced — nothing sent yet");

    await CP.flushViewPatch();
    await settle();

    const mergeCalls = client.rpcCalls.filter(c => c.name === "merge_user_prefs_view");
    assert.equal(mergeCalls.length, 1, "a burst of agentState writes coalesces into one rpc call");
    assert.equal(mergeCalls[0].params.p_patch.agent.learning, false);
  } finally {
    CP.VIEW_DEBOUNCE_MS = originalDebounce;
    signOut(E);
  }
});

test("CAS-1222: trackAdmitDrift never pushes before this session's own user_prefs load has resolved", async () => {
  const E = loadEngine();
  const client = makeFakeClient(selectUserPrefsRow(null));
  signIn(E, client);
  const CP = E.CascadePersistence;
  try{
    CP.userPrefsReady = false;   // mid-load, same state boot leaves it in before fireAccountFanout resolves
    E.recomputeFound();   // runs trackAdmitDrift as its last step
    await CP.flushViewPatch();
    await settle();
    assert.equal(client.rpcCalls.filter(c => c.name === "merge_user_prefs_view").length, 0,
      "must not push admitDrift while this device's own load is still in flight");
  } finally {
    CP.userPrefsReady = true;
    signOut(E);
  }
});

test("CAS-1222: loadUserPrefs adopts every view field, leaving an unanswered field at its device default", async () => {
  const E = loadEngine();
  const idA = "a0000000-0000-4000-8000-000000000001";
  const idB = "b0000000-0000-4000-8000-000000000002";
  const a = E.normCascade({ id: idA, name: "Agent A" });
  const b = E.normCascade({ id: idB, name: "Agent B" });
  E.cascades.length = 0; E.cascades.push(a, b);
  // trackAdmitDrift (run by the render() at the end of loadUserPrefs) prunes any id not currently in
  // `found` — seeding this film directly into that Set (rather than constructing a real agent match) is
  // what lets the adopted entry below survive long enough for this test to see it.
  const filmId = E.MOVIES[0].tmdb_id;
  E.found.add(filmId);
  const row = {
    user_id: "cas1222-test-user",
    view: {
      active: idB, activeMulti: [idB],
      mineOnly: { stream: false },
      tutorialSeen: true,
      agent: { invited: true },
      admitDrift: { [filmId]: true },
      // seenFound/reviewSessions/reviewAskedVer deliberately absent — "no device has saved this yet".
    },
  };
  const client = makeFakeClient(selectUserPrefsRow(row));
  signIn(E, client);
  E.setWatchTab("stream");
  try{
    // loadAccount() deliberately not called — it would acctLoad "cascades" against this same fake client,
    // which answers every table it isn't told about with an empty page, wiping the two agents just seeded
    // above before reconcileActiveIds (inside loadUserPrefs' own view.active adoption) ever got to filter
    // against them. loadUserPrefs() doesn't depend on loadAccount() having run first.
    await E.CascadePersistence.loadUserPrefs();
    await settle();

    assert.equal(E.activeId, idB);
    assert.deepEqual([...E.activeIds], [idB]);
    assert.equal(E.watchMineOnlyOn(), false, "stream's mineOnly was adopted off");
    assert.equal(E.tutorialSeen(), true);
    assert.equal(E.agentState.invited, true);
    assert.equal(E.admitDrift[filmId], true);
    // reviewAskedVer was absent — the device default (null, nothing ever asked) must survive untouched.
    assert.equal(E.reviewPromptAskedVersion(), null);
  } finally {
    E.cascades.length = 0;
    E.setActive(null);
    signOut(E);
  }
});

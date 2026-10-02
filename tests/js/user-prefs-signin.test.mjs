// CAS-1045 (original incident): signing in used to rewrite the account's real user_prefs row with whatever
// this device had in memory a moment before loadUserPrefs ever ran, because runUserPrefsSync was a
// whole-row "last write wins" upsert with no dirty check replayOutbox could unconditionally replay.
// CAS-1095 removed that push path entirely — user_prefs now loads through acctLoad (a pure read, wholesale
// replace) and writes only through acctOp, one column at a time, only when a settings chokepoint actually
// calls it. A sign-in/boot that only ever loads structurally cannot echo anything back any more, which is
// what these tests now assert, alongside the CAS-1053 loading-state/diagnostics behaviour that still applies
// unchanged under the new load path.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// A generic chainable fake query builder covering both acctLoad's read chain
// (select("*").order(pk,{ascending}).range(from,to)) and acctOp's update chain (update(fields).match(m)) —
// same convention cas1094-account-store.test.mjs uses.
function makeQueryBuilder(table, calls, script){
  const state = { table, kind: "select" };
  const b = {
    select(cols){ state.selectCols = cols; return b; },
    order(col, opts){ state.orderCol = col; state.orderOpts = opts; return b; },
    range(from, to){ state.from = from; state.to = to; return b; },
    upsert(rows, opts){ state.kind = "upsert"; state.rows = rows; state.opts = opts; return b; },
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
function fakeClient(script){
  const calls = [];
  return { calls, from(table){ return makeQueryBuilder(table, calls, script); } };
}
function signIn(E, userId, client){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
// A full, self-consistent user_prefs row — every field loadUserPrefs reads, including ref_code, so the
// ref_code bootstrap branch never fires either.
function serverRow(userId, overrides){
  return { user_id: userId, sub_services: ["Netflix", "Stan"], store_services: [], services_only: false,
    touched: true, taste: { mood: 1 }, watch_windows: { cinema: true }, never_show: [], onb_depth: "shallow",
    framing: false, moving_seen: { x: 1 }, occasions: [], ref_code: "CAS1045REF", ...overrides };
}
const selectServerRow = row => state =>
  (state.table === "user_prefs" && state.kind === "select") ? { data: [row], error: null } : { data: [], error: null };

test("CAS-1095: a sign-in adopts the account's real user_prefs row and never writes anything back", async () => {
  const E = loadEngine();
  const acctId = "cas1045-acct-x";
  const client = fakeClient(selectServerRow(serverRow(acctId)));
  signIn(E, acctId, client);
  await E.CascadePersistence.loadAccount();
  await E.CascadePersistence.loadUserPrefs();

  assert.deepEqual([...E.prefs.sub].sort(), ["Netflix", "Stan"], "the account's real services are adopted");
  assert.equal(E.prefs.touched, true, "the account's real touched flag is adopted");
  assert.equal(client.calls.filter(c => c.table === "user_prefs" && c.kind !== "select").length, 0,
    "a clean load of a fully-populated row must never write anything back — there is no push path a load can trigger");

  signOut(E);
});

test("CAS-1095: another device's newer services are adopted on the next sign-in, still with no write back", async () => {
  const E = loadEngine();
  const acctId = "cas1045-acct-x2";
  const client1 = fakeClient(selectServerRow(serverRow(acctId)));
  signIn(E, acctId, client1);
  await E.CascadePersistence.loadAccount();
  await E.CascadePersistence.loadUserPrefs();

  E.CascadePersistence.loadGuest();
  assert.equal(E.prefs.touched, false, "sanity: signed out, in-memory prefs are the guest's blank defaults");

  // Another device added a service while this one was signed out.
  const client2 = fakeClient(selectServerRow(serverRow(acctId, { sub_services: ["Netflix", "Stan", "Binge"] })));
  signIn(E, acctId, client2);
  await E.CascadePersistence.replayOutbox();
  assert.equal(client2.calls.filter(c => c.kind !== "select").length, 0,
    "replayOutbox must never write user_prefs when this device has nothing genuinely queued for it");

  await E.CascadePersistence.loadAccount();
  await E.CascadePersistence.loadUserPrefs();

  assert.deepEqual([...E.prefs.sub].sort(), ["Binge", "Netflix", "Stan"], "the other device's newer services are adopted");
  assert.equal(E.prefs.touched, true, "touched is adopted from the account, never reset by a sign-in");
  assert.equal(client2.calls.filter(c => c.table === "user_prefs" && c.kind !== "select").length, 0);

  signOut(E);
});

test("CAS-1095: a user_prefs acctOp still queued (but unsent) from before this boot is still sent on replay", async () => {
  const E = loadEngine();
  const acctId = "cas1045-acct-y";
  let updateCalls = 0;
  const client = fakeClient(state => {
    if(state.kind === "update"){ updateCalls++; return { data: [{ user_id: acctId }], error: null, status: 200 }; }
    return { data: [], error: null };   // every other replay target (cascades, film_watch, ...) — harmless no-ops
  });
  signIn(E, acctId, client);
  E.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [0, 0, 0];
  // Standing in for an edit whose acctOp never got to send before the tab died last session — the op queue
  // is persisted at cascade_ops@<uid> (see CascadeAccountStore), seeded here exactly as it would have been
  // left on disk.
  E.localStorage.setItem("cascade_ops@" + acctId, JSON.stringify([
    { id: "op-stranded", table: "user_prefs", kind: "update", match: { user_id: acctId },
      fields: { sub_services: ["Binge"] } },
  ]));

  await E.CascadePersistence.replayOutbox();

  assert.equal(updateCalls, 1, "a queued-but-unsent user_prefs op from a previous session must still be sent this boot");

  signOut(E);
});

// CAS-1053 AC1/AC4: production reported Rental/Streaming both showing "you haven't picked any services yet"
// for an account that has had services for weeks — watchMineOnlyDeadEndHTML's own gate has no idea whether
// "no services" means the account genuinely has none, or user_prefs simply hasn't loaded yet on this boot.
test("CAS-1053 AC1/AC4: the loading state wins the race while user_prefs is unresolved, and the real services are adopted once it loads", async () => {
  const E = loadEngine();
  const acctId = "cas1053-acct-fresh";
  const client = fakeClient(selectServerRow(serverRow(acctId)));
  signIn(E, acctId, client);
  await E.CascadePersistence.loadAccount();

  // Mid-flight: user_prefs hasn't resolved yet, so prefs.sub/store are still this fresh device's empty
  // defaults — exactly the moment the false dead end used to render.
  E.CascadePersistence.userPrefsReady = false;
  assert.equal(E.servicesPicked(), false, "sanity: a fresh device has no services loaded yet");
  assert.equal(E.watchMineOnlyEmptyKind(true, true), "loading",
    "AC4: must show the loading state, not the dead end, while user_prefs is still unresolved");

  await E.CascadePersistence.loadUserPrefs();

  assert.deepEqual([...E.prefs.sub].sort(), ["Netflix", "Stan"], "AC1: the account's real services are adopted");
  assert.equal(E.servicesPicked(), true);
  assert.equal(E.watchMineOnlyEmptyKind(true, true), null,
    "AC1: with services picked, neither empty variant applies — the real listing shows instead");

  signOut(E);
});

// CAS-1053 AC3: syncOutcome (CAS-787) used to be written only by a push, so a device that only ever reads a
// clean, fully-populated row (the common case) left the diagnostics panel reporting user_prefs "not yet
// attempted" forever. Still true now that the read goes through acctLoad instead of a direct select.
test("CAS-1053 AC3: a clean sign-in load records user_prefs OK in diagnostics", async () => {
  const E = loadEngine();
  const acctId = "cas1053-acct-diag";
  const client = fakeClient(selectServerRow(serverRow(acctId)));
  signIn(E, acctId, client);
  await E.CascadePersistence.loadAccount();
  await E.CascadePersistence.loadUserPrefs();

  const report = E.CascadePersistence.syncOutcomeReport().find(r => r.target === "user_prefs");
  assert.ok(report, "user_prefs must appear in the sync outcome report");
  assert.equal(report.ok, true, "a clean load with nothing to push must record success, not stay 'not yet attempted'");
  assert.notEqual(report.when, null);

  signOut(E);
});

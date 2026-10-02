// CAS-1156: a window a member switches OFF in Where & when you'll watch used to come back ON after a
// reload. wwToggleWin deleted the key when a window went off, and both loaders rebuild watchPrefs as
// {...watchPrefsDefaults(), ...migrateWatch(saved)} — an absent key is refilled from the default, and
// upcoming/in_cinema/rent/stream all default to true (CAS-1123). The fix stores an off window explicitly
// as {list:false} instead of deleting it, so it survives the merge the same way an on window already did.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const ALL_KEYS = ["upcoming", "in_cinema", "rent", "stream"];

test("CAS-1156 AC1: switching a default-on window off survives a reload, the other three stay on", () => {
  for(const key of ALL_KEYS){
    const store = new Map();
    const E1 = loadEngine({ localStorageStore: store });
    E1.window.openWhereWhen();
    E1.window.wwToggleWin(key);

    // Simulate a reload: a brand new engine instance (fresh module-level state) over the SAME storage.
    const E2 = loadEngine({ localStorageStore: store });
    assert.equal(E2.windowEnabled(key), false, `${key} must stay off after a reload`);
    for(const other of ALL_KEYS){
      if(other === key) continue;
      assert.equal(E2.windowEnabled(other), true, `${other} must still read on after only ${key} was switched off`);
    }
  }
});

test("CAS-1156 AC2: switching rent off and back on again survives a reload", () => {
  const store = new Map();
  const E1 = loadEngine({ localStorageStore: store });
  E1.window.openWhereWhen();
  E1.window.wwToggleWin("rent");   // off
  E1.window.wwToggleWin("rent");   // back on

  const E2 = loadEngine({ localStorageStore: store });
  assert.equal(E2.windowEnabled("rent"), true, "rent must read on again after being switched back on");
});

test("CAS-1156 AC3: premium (default off) switched on then off again survives each reload", () => {
  const store = new Map();
  const E1 = loadEngine({ localStorageStore: store });
  E1.window.openWhereWhen();
  E1.window.wwToggleWin("premium");   // on

  const E2 = loadEngine({ localStorageStore: store });
  assert.equal(E2.windowEnabled("premium"), true, "premium must read on after a reload");

  E2.window.openWhereWhen();
  E2.window.wwToggleWin("premium");   // off again

  const E3 = loadEngine({ localStorageStore: store });
  assert.equal(E3.windowEnabled("premium"), false, "premium must read off again after a second reload");
});

// CAS-1156 AC4/AC5: the account-load side (loadUserPrefs, via acctLoad) — same fake-Supabase convention as
// tests/js/user-prefs-signin.test.mjs.
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
function serverRow(userId, overrides){
  return { user_id: userId, sub_services: [], store_services: [], services_only: false,
    touched: true, taste: {}, watch_windows: {}, never_show: [], onb_depth: "shallow",
    framing: false, moving_seen: {}, occasions: [], ref_code: "CAS1156REF", ...overrides };
}
const selectServerRow = row => state =>
  (state.table === "user_prefs" && state.kind === "select") ? { data: [row], error: null } : { data: [], error: null };

test("CAS-1156 AC4: an account row with rent explicitly {list:false} loads with rent off, the other three on", async () => {
  const E = loadEngine();
  const acctId = "cas1156-acct-off";
  const row = serverRow(acctId, { watch_windows: {
    upcoming: { list: true }, in_cinema: { list: true }, rent: { list: false }, stream: { list: true },
  } });
  const client = fakeClient(selectServerRow(row));
  signIn(E, acctId, client);
  await E.CascadePersistence.loadAccount();
  await E.CascadePersistence.loadUserPrefs();

  assert.equal(E.windowEnabled("rent"), false, "an explicit {list:false} must load as off");
  assert.equal(E.windowEnabled("upcoming"), true);
  assert.equal(E.windowEnabled("in_cinema"), true);
  assert.equal(E.windowEnabled("stream"), true);

  signOut(E);
});

test("CAS-1156 AC5: an account row with an empty watch_windows leaves watchPrefs at the engine defaults", async () => {
  const E = loadEngine();
  const acctId = "cas1156-acct-empty";
  const client = fakeClient(selectServerRow(serverRow(acctId, { watch_windows: {} })));
  signIn(E, acctId, client);
  await E.CascadePersistence.loadAccount();
  await E.CascadePersistence.loadUserPrefs();

  // JSON.stringify, not deepEqual: watchPrefs is a plain object from inside the vm sandbox, whose
  // Object.prototype differs from this realm's — node:assert/strict's deepEqual fails on that alone
  // (same pattern as tests/js/cas1123-watch-notify-merge.test.mjs).
  assert.equal(JSON.stringify(E.watchPrefs), JSON.stringify(E.watchPrefsDefaults()),
    "an empty watch_windows row must never overwrite watchPrefs away from the engine defaults");

  signOut(E);
});

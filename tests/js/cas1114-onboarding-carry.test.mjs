// CAS-1114: onboarding runs signed out, so everything it sets (services, occasions, watch windows,
// notification choices) is saved under the guest namespace. Sign-up used to switch straight from guest to
// the new uid and simply reload prefs/tasteBase/watchPrefs/notifyPrefs/occasionReg from the new account's
// own (empty) keys — the onboarding answers were silently dropped, and a brand-new member landed on My
// services showing zero services. maybeSwitchAcctSuffix now carries the guest copies into the new account's
// own namespace first, whenever the switch is guest -> uid and onboarding has just committed its roster
// (onbV2CommittedSave/onbV2CommittedLoad) — the carried values render locally either way.
// CAS-1095: the server side of this changed underneath it. loadUserPrefs() used to push a brand-new,
// no-row-yet account's row from whatever this device currently held (which, thanks to the carry above,
// already included the onboarding picks) — CAS-1095 removed that: a missing row is now bootstrapped once
// with fixed defaults only, never this device's own values, so the carried picks stay local-only until a
// later settings change (or the CAS-1099 onboarding-commit rework, once that lands) actually pushes them.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// Same permissive per-table fake user-prefs-signin.test.mjs uses: whatever table isn't explicitly
// configured succeeds with empty data, so loadAccount/loadNotifyPrefs/etc (every load fireAccountFanout
// would otherwise also drive) are harmless no-ops alongside the user_prefs behaviour under test.
function fakeClient({ upserts = {}, selects = {} } = {}){
  const upsertCalls = [];
  return {
    upsertCalls,
    from(table){
      return {
        upsert(rows){
          upsertCalls.push({ table, rows });
          const spec = upserts[table];
          const err = typeof spec === "function" ? spec(rows) : spec;
          const result = err ? { data: null, error: err } : { data: rows, error: null };
          return { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); },
                   select(){ return Promise.resolve(result); } };
        },
        select(){
          const spec = selects[table];
          const result = spec ? spec() : { data: [], error: null };
          const thenable = { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
          thenable.order = () => thenable;
          thenable.limit = () => thenable;
          thenable.eq = () => thenable;
          thenable.range = () => thenable;   // CAS-1095: acctLoad's own paging call
          return thenable;
        },
        delete(){
          const chain = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
          chain.eq = () => chain; chain.in = () => chain;
          return chain;
        },
      };
    },
  };
}
function signIn(E, userId, client){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
// A full, self-consistent user_prefs row — every field loadUserPrefs reads, so no field falls into a
// carry-up branch and schedules an unrelated second push, same convention as user-prefs-signin.test.mjs.
function serverRow(userId, overrides){
  return { user_id: userId, sub_services: ["Stan"], store_services: [], services_only: false,
    touched: true, taste: { mood: 1 }, watch_windows: { cinema: true }, never_show: [], onb_depth: "shallow",
    framing: false, moving_seen: { x: 1 }, occasions: [], ref_code: "CAS1114REF", ...overrides };
}
// Seeds the guest namespace exactly the way a completed v2 onboarding flow leaves it on this device: the
// services/store picks and occasions live under the "@guest" keys, and the committed-roster marker (a plain,
// unnamespaced key) is set.
function seedGuestOnboarding(E){
  E.localStorage.setItem("cascade_prefs@guest",
    JSON.stringify({ on: true, touched: true, sub: ["Netflix"], store: ["Apple TV Store"] }));
  E.localStorage.setItem("cascade_occasions@guest",
    JSON.stringify([{ id: "me", name: "Me" }, { id: "partner", name: "Partner" }]));
  E.onbV2CommittedSave([{ id: "onb-agent-1", kind: "stream", status: [] }]);
}

test("CAS-1114 AC1: a brand-new member's onboarding services/occasions survive sign-up and are pushed to the new account", async () => {
  const E = loadEngine();
  seedGuestOnboarding(E);

  const acctId = "cas1114-acct-new";
  const client = fakeClient({ selects: { user_prefs: () => ({ data: [], error: null }) } });
  signIn(E, acctId, client);
  await E.CascadePersistence.loadAccount();

  assert.deepEqual([...E.prefs.sub], ["Netflix"], "the guest's service pick must survive the guest -> new-account switch");
  assert.deepEqual([...E.prefs.store], ["Apple TV Store"], "the guest's store pick must survive the switch");
  assert.equal(E.prefs.on, true, "the guest's services-only switch must survive");
  // Cross-realm note: E.occasionReg is an array created inside engine.mjs's vm sandbox, so calling .map/.sort
  // on it directly returns a sandboxed Array whose prototype differs from this (host) realm's — spreading it
  // first, like the sibling user-prefs-signin.test.mjs does for prefs.sub, produces a plain host array assert
  // can compare against a host array literal.
  assert.deepEqual([...E.occasionReg].map(o => o.id).sort(), ["me", "partner"], "the guest's occasions must survive the switch");

  await E.CascadePersistence.loadUserPrefs();

  // CAS-1095: a genuinely missing row is bootstrapped once with fixed defaults, never this device's own
  // values — none of the upserts loadUserPrefs issues for a no-row account (the ref_code mint, the blank
  // bootstrap) may carry sub_services/occasions.
  const bootstraps = client.upsertCalls.filter(c => c.table === "user_prefs");
  assert.ok(bootstraps.length > 0, "a brand-new account with no user_prefs row yet must be bootstrapped");
  bootstraps.forEach(c => {
    assert.ok(!("sub_services" in c.rows[0]), "the bootstrap must never carry this device's own services");
    assert.ok(!("occasions" in c.rows[0]), "the bootstrap must never carry this device's own occasions");
  });

  assert.equal(E.localStorage.getItem("cascade_prefs@guest"), null, "the guest copy must be cleared once carried");
});

test("CAS-1114 AC2: an existing member's own account row wins over the guest's onboarding pick, and nothing is pushed", async () => {
  const E = loadEngine();
  seedGuestOnboarding(E);

  const acctId = "cas1114-acct-existing";
  const client = fakeClient({ selects: { user_prefs: () => ({ data: [serverRow(acctId)], error: null }) } });
  signIn(E, acctId, client);
  await E.CascadePersistence.loadAccount();
  await E.CascadePersistence.loadUserPrefs();

  assert.deepEqual([...E.prefs.sub], ["Stan"], "the account's own already-saved service must win over the guest's onboarding pick");
  assert.equal(client.upsertCalls.filter(c => c.table === "user_prefs").length, 0,
    "an account that already has its own user_prefs row must never have the guest's onboarding services pushed over it");

  assert.equal(E.localStorage.getItem("cascade_prefs@guest"), null, "the guest copy must be cleared even when the account's own row wins");
});

// CAS-1099: onboarding's draft now reaches the server through exactly one complete_membership() RPC call
// (membCompleteNewMembership), replacing CAS-959's own localOnly-fold carve-out in loadAccount() — removed
// along with onbV2CommittedSave/Load/Clear, which no longer exist (the draft lives in memory only until
// membership completes; see onbDraftModeOn). These tests drive the real seam with a stubbed Supabase
// client, the same convention acct-namespacing.test.mjs uses.
// CAS-1109: CAS-734/733's own organic-local-work fold-in (a hand-built agent the account has never
// confirmed surviving a loadAccount() call) is retired along with the rest of the old diff sync —
// acctLoad replaces whatever this device held for cascades wholesale now, the same "no merge, no carry-up"
// rule every other acctOp-backed table already follows. In practice this never arises for a real user: the
// one path that creates a cascade (commitDraft -> saveCascades) always enqueues its own acctOp insert in
// the same synchronous turn, so acctOpPendingOverlay (not a loadAccount-side merge) is what survives a
// reload racing an unconfirmed create now.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// A generic chainable query stub, same reasoning as cas1107-load-before-sync.test.mjs's own: any method
// call just keeps chaining, and the object resolves to the fixed result it was built with.
function chainable(resultPromise){
  return new Proxy(function(){}, {
    get(t, k){
      if(k === "then") return (resolve, reject) => resultPromise.then(resolve, reject);
      if(k === "catch") return (reject) => resultPromise.catch(reject);
      if(k === "finally") return (fn) => resultPromise.finally(fn);
      return () => chainable(resultPromise);
    },
  });
}
// user_prefs/notify_prefs default to an already-populated row (what complete_membership() itself just
// inserted) so loadUserPrefs()/loadNotifyPrefs()'s own "no row yet" bootstrap upsert — unrelated to this
// ticket — never fires and pollutes the "no direct insert" assertion below.
function fakeMembershipClient({ rpcResult = { data: "created", error: null }, cascadesRows = [],
  userPrefsRows, notifyPrefsRows } = {}){
  const rpcCalls = [];
  const writes = { cascades: [], user_prefs: [], notify_prefs: [] };
  const rowsFor = {
    // CAS-1099: a function, not a fixed array — evaluated at select() time, so a row's alert_moments (a
    // function of whatever notifyPrefs/watchPrefs the account-switch inside loadAccount() has ALREADY reset
    // by the time it actually reads cascades) is computed against that same real, post-switch state rather
    // than a value guessed ahead of time and liable to go stale the instant the switch runs.
    cascades: typeof cascadesRows === "function" ? cascadesRows : () => cascadesRows,
    user_prefs: () => userPrefsRows || [{ user_id: "x", sub_services: [], store_services: [], services_only: false,
      touched: false, taste: {}, watch_windows: {}, never_show: [], onb_depth: null, framing: false,
      moving_seen: {}, occasions: [], ref_code: "CAS1099REF" }],
    notify_prefs: () => notifyPrefsRows || [{ user_id: "x", in_app: true, email_on: false, email_address: null }],
  };
  return {
    rpcCalls, writes,
    rpc(name, params){
      rpcCalls.push({ name, params });
      return Promise.resolve(rpcResult);
    },
    from(table){
      return {
        select(){ return chainable(Promise.resolve({ data: (rowsFor[table] ? rowsFor[table]() : []), error: null })); },
        upsert(rows){
          if(writes[table]) writes[table].push(...rows);
          return { select(){ return Promise.resolve({ data: rows.map(r => ({ id: r.id, updated_at: new Date().toISOString() })), error: null }); } };
        },
        insert(rows){
          if(writes[table]) writes[table].push(...(Array.isArray(rows) ? rows : [rows]));
          return Promise.resolve({ data: null, error: null });
        },
        delete(){ return { eq(){ return { in(){ return Promise.resolve({ data: null, error: null }); } }; } }; },
      };
    },
  };
}
function signIn(E, userId, client){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
  auth.status = "signed-in"; auth.user = { id: userId };
}

test("CAS-1099 AC1: completing membership issues exactly one complete_membership call and no direct insert/upsert to cascades, user_prefs or notify_prefs", async () => {
  const E = loadEngine();
  // Real UUID shape (client-generated, exactly as cascadeNewId() would mint) — the shape complete_membership's
  // real RPC payload always carries.
  const MASSIVE_ID = "a0000000-0000-4000-8000-00000000a001";
  const FAVS_ID = "a0000000-0000-4000-8000-00000000a002";
  const draftAgents = [
    E.normCascade({ id: MASSIVE_ID, name: "Massive Movies", kind: "stream", status: [] }),
    E.normCascade({ id: FAVS_ID, name: "Personal Favs", kind: "stream", status: [] }),
  ];
  draftAgents.forEach(a => E.cascades.push(a));

  // complete_membership() inserts these rows server-side, with the SAME client-generated ids AND the same
  // criteria/alert_moments (built through the real cascadeToRow, like membCompleteNewMembership's own
  // payload) this device already holds — the fan-out's own loadAccount() read-back must see them already
  // confirmed with no drift, so it never schedules a second, duplicate push to reconcile an artificial
  // mismatch. A function, not a fixed array: see fakeMembershipClient's own comment on why.
  const cascadesRows = () => draftAgents.map(a => {
    const row = E.CascadeShape.cascadeToRow(a);
    return { id: row.id, user_id: "cas1099-new-acct", name: row.name, criteria: row.criteria,
      alert_moments: row.alert_moments, active: row.active, created_at: "2026-01-01T00:00:00.000Z" };
  });
  const client = fakeMembershipClient({ rpcResult: { data: "created", error: null }, cascadesRows });
  signIn(E, "cas1099-new-acct", client);

  const outcome = await E.membCompleteNewMembership();

  assert.equal(outcome, "created");
  assert.deepEqual(client.rpcCalls.map(c => c.name), ["complete_membership"],
    "exactly one complete_membership call — no other rpc");
  assert.equal(client.writes.cascades.length, 0, "no direct insert/upsert to cascades");
  assert.equal(client.writes.user_prefs.length, 0, "no direct insert/upsert to user_prefs");
  assert.equal(client.writes.notify_prefs.length, 0, "no direct insert/upsert to notify_prefs");
  const sentAgentIds = [...client.rpcCalls[0].params.p.agents].map(a => a.id).sort();
  assert.equal(JSON.stringify(sentAgentIds), JSON.stringify([MASSIVE_ID, FAVS_ID].sort()),
    "both draft agents, with their own client-generated ids, travel in the one RPC call");
});

test("CAS-1099 change 3: 'account_exists' discards the draft rather than merging it", async () => {
  const E = loadEngine();
  E.cascades.push(E.normCascade({ id: "draft-only", name: "Massive Movies", kind: "stream", status: [] }));

  const A_ID = "a0000000-0000-4000-8000-000000000001";
  const client = fakeMembershipClient({
    rpcResult: { data: "account_exists", error: null },
    cascadesRows: [{ id: A_ID, user_id: "cas1099-existing-acct", name: "Already there", criteria: {}, alert_moments: [], active: true, created_at: "2026-01-01T00:00:00.000Z" }],
  });
  signIn(E, "cas1099-existing-acct", client);

  const outcome = await E.membCompleteNewMembership();

  assert.equal(outcome, "account_exists");
  // CAS-969's own cross-realm note applies here too: E.cascades is a vm-sandboxed array, so its own .map()
  // result can't directly assert.deepEqual against a host array literal — compare through JSON.stringify
  // instead, the same convention the surviving fold-in test below already uses.
  assert.equal(JSON.stringify(E.cascades.map(c => c.id)), JSON.stringify([A_ID]),
    "the discarded draft must not survive alongside the account's own real roster");
});

test("CAS-1099 change 3: an RPC error keeps the draft in memory for a retry", async () => {
  const E = loadEngine();
  E.cascades.push(E.normCascade({ id: "draft-retry", name: "Date Night", kind: "stream", status: [] }));

  const client = fakeMembershipClient({ rpcResult: { data: null, error: { message: "network down" } } });
  signIn(E, "cas1099-retry-acct", client);

  const outcome = await E.membCompleteNewMembership();

  assert.equal(outcome, "error");
  assert.equal(JSON.stringify(E.cascades.map(c => c.id)), JSON.stringify(["draft-retry"]),
    "an error must not discard the draft");
});

test("CAS-1109: a hand-built local agent the account has never confirmed does not survive a loadAccount() call", async () => {
  const E = loadEngine();
  E.cascades.push(E.normCascade({ id: "hand-built", name: "My own agent", kind: "stream", status: [] }));

  const A_ID = "a0000000-0000-4000-8000-000000000003";
  const existingRows = [
    { id: A_ID, user_id: "cas1099-acct-2", name: "Massive Movies", criteria: {}, alert_moments: [], active: true, created_at: "2026-01-01T00:00:00.000Z" },
  ];
  signIn(E, "cas1099-acct-2", fakeMembershipClient({ cascadesRows: existingRows }));
  await E.CascadePersistence.loadAccount();

  assert.equal(JSON.stringify(E.cascades.map(c => c.id)), JSON.stringify([A_ID]),
    "acctLoad replaces whatever this device held wholesale — a never-queued local-only row is not carried forward");
});

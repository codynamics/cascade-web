// CAS-1174: a brand-new signup can lose its onboarding draft — Occasions ends up empty, "only my
// services" ends up off — even though complete_membership() returns 'created' and the agents
// themselves survive untouched. Root cause (confirmed by this test, not just read off the code):
// reconcileOnReturn (the focus/visibilitychange/3-min-heartbeat handler, app_template.html's
// account-sync IIFE) calls loadUserPrefs() unconditionally once a session exists — it has no
// onbDraftModeOn guard, unlike every saveX() chokepoint the CAS-1099 draft already protects
// (saveOccasionReg/savePrefs/saveCascades/saveNotifyPrefs/saveTasteBase). Email OTP sign-up leaves
// a session active for the whole code-entry wait (the ticket's own observed timeline), so a
// reconcile landing in that window finds no user_prefs row yet, bootstrap-inserts an empty one
// (user_id only — every other column at its table default), and a SECOND reconcile — the same
// heartbeat firing again, or another tab focus — then finds that empty row and overwrites the
// in-memory draft (occasionReg, prefs.on) with it, well before membCompleteNewMembership() ever
// builds its RPC payload from that same now-corrupted memory. cascades is untouched throughout
// (loadUserPrefs never touches it), which is why the agents themselves always survived intact.
// Fix: loadUserPrefs() gets the same one-line "while a draft is still memory-only, a server
// reconcile must not touch it either" guard every saveX() chokepoint already carries.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// Same chainable-proxy convention as onb-account-fold.test.mjs's own fakeMembershipClient — any
// method call keeps chaining, and the object resolves to the fixed result it was built with.
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

// Unlike onb-account-fold's fakeMembershipClient (which pre-seeds an already-populated user_prefs/
// notify_prefs row so loadUserPrefs()/loadNotifyPrefs()'s own "no row yet" bootstrap upsert never
// fires), this test's whole point is to let that bootstrap path run for real — a stateful table so
// a reconcile call genuinely sees "no row" the first time and "an empty row" the second, exactly as
// the real account would across two reconcile passes during the code-entry wait. upsert() mutates
// state synchronously (not inside a deferred .then()) since the real loadUserPrefs()/loadNotifyPrefs()
// never await their own bootstrap upsert before returning.
function fakeAccountClient({ ownerId }){
  const rpcCalls = [];
  const tables = { user_prefs: null, notify_prefs: null, cascades: [] };
  function selectRows(table){
    if(table === "cascades") return tables.cascades;
    if(table === "user_prefs") return tables.user_prefs ? [tables.user_prefs] : [];
    if(table === "notify_prefs") return tables.notify_prefs ? [tables.notify_prefs] : [];
    return [];
  }
  function upsertMerge(table, rows){
    const incoming = rows[0] || {};
    if(table === "user_prefs"){
      const defaults = { sub_services:[], store_services:[], services_only:false, touched:null,
        taste:{}, watch_windows:{}, occasions:[], never_show:null, onb_depth:null, framing:null,
        moving_seen:{}, ref_code:null };
      tables.user_prefs = Object.assign({}, defaults, tables.user_prefs || {}, incoming);
    } else if(table === "notify_prefs"){
      const defaults = { in_app:true, email_on:false, email_address:null };
      tables.notify_prefs = Object.assign({}, defaults, tables.notify_prefs || {}, incoming);
    }
    return Promise.resolve({ data: rows, error: null });
  }
  return {
    rpcCalls, tables,
    rpc(name, params){
      rpcCalls.push({ name, params });
      if(name === "complete_membership"){
        // Mirrors complete_membership()'s own guard (supabase/schema.sql): any of the three tables
        // already holding a row for this user means 'account_exists', no agents/prefs written.
        if(tables.user_prefs || tables.notify_prefs || tables.cascades.length){
          return Promise.resolve({ data: "account_exists", error: null });
        }
        const p = params.p;
        tables.cascades = p.agents.map(a => ({ ...a, user_id: ownerId, created_at: "2026-10-03T08:53:43.283Z" }));
        tables.user_prefs = {
          user_id: ownerId,
          sub_services: p.prefs.sub_services || [], store_services: p.prefs.store_services || [],
          services_only: !!p.prefs.services_only, touched: p.prefs.touched,
          taste: p.prefs.taste || {}, watch_windows: p.prefs.watch_windows || {},
          occasions: p.prefs.occasions || [], never_show: p.prefs.never_show || [],
          onb_depth: p.prefs.onb_depth || null, framing: p.prefs.framing,
          moving_seen: {}, membership_completed_at: "2026-10-03T08:53:43.283Z", ref_code: "CAS1174REF",
        };
        tables.notify_prefs = { user_id: ownerId, in_app: p.notify.in_app !== false,
          email_on: !!p.notify.email_on, email_address: p.notify.email_address || null };
        return Promise.resolve({ data: "created", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table){
      return {
        select(){ return chainable(Promise.resolve({ data: selectRows(table), error: null })); },
        upsert(rows){ return upsertMerge(table, rows); },
        insert(rows){ return Promise.resolve({ data: null, error: null }); },
        delete(){ return { eq(){ return { in(){ return Promise.resolve({ data: null, error: null }); } }; } }; },
      };
    },
  };
}

test("CAS-1174: a reconcile mid-wait must not discard the draft before membership completes", async () => {
  const E = loadEngine();
  const OWNER = "cas1174-new-acct";
  const SIGNUP_EMAIL = "cas1174-signup@example.com";
  const AGENT_ID = "a0000000-0000-4000-8000-00000000c001";

  // The onboarding draft, exactly as v2_done + the services step leave it: one agent pointed at a
  // freshly created "Me" occasion, services-only armed, touched.
  const client = fakeAccountClient({ ownerId: OWNER });
  E.setOnbDraftModeOn(true);
  const agent = E.normCascade({ id: AGENT_ID, name: "Massive Movies", kind: "stream", status: [] });
  const occ = E.createOccasion("Me");
  agent.occasions = [occ.id];
  E.cascades.push(agent);
  E.prefs.on = true; E.prefs.touched = true;

  // The email step's own flag (membStart sets this before continueWithEmail ever runs) — true for
  // the whole code-entry wait, cleared only once membCompleteNewMembership() resolves. Pre-fix,
  // reconcileOnReturn's own loadUserPrefs() call ignores it entirely, which is exactly the bug.
  E.setOnbMembershipInFlight(true);

  // A session already exists for the whole wait (the ticket's own observed timeline: an auth.sessions
  // row from the moment the email was submitted, ~15 minutes before the code was entered) — enough
  // for accountActive() to read true, which is all reconcileOnReturn's own loadUserPrefs() call checks.
  E.CascadeAuth.enabled = true; E.CascadeAuth.client = client;
  E.CascadeAuth.session = { user: { id: OWNER } };
  E.CascadeAuth.status = "signed-in"; E.CascadeAuth.user = { id: OWNER, email: SIGNUP_EMAIL };

  const before = {
    occasionReg: JSON.stringify(E.occasionReg),
    prefsOn: E.prefs.on,
    cascadesLength: E.cascades.length,
    notifyPrefs: JSON.stringify(E.notifyPrefs),
  };

  // The wait: a visibilitychange away and back (reconcileOnReturn -> loadUserPrefs()), and then the
  // same thing again (the 3-min heartbeat, or another tab focus, well within a real ~15 minute wait).
  // First call finds no user_prefs row yet and bootstrap-inserts an empty one; second finds that row
  // and (pre-fix) overwrites the in-memory draft with it.
  await E.CascadePersistence.loadUserPrefs();
  await E.CascadePersistence.loadUserPrefs();

  // AC4: nothing about the draft may change before the code is verified.
  assert.equal(JSON.stringify(E.occasionReg), before.occasionReg,
    "a reconcile mid-wait must not touch the in-memory occasion register");
  assert.equal(E.prefs.on, before.prefsOn,
    "a reconcile mid-wait must not touch the in-memory services-only answer");
  assert.equal(E.cascades.length, before.cascadesLength,
    "a reconcile mid-wait must not touch the in-memory agent roster");
  assert.equal(JSON.stringify(E.notifyPrefs), before.notifyPrefs,
    "a reconcile mid-wait must not touch the in-memory notify prefs");

  // The code is verified — membCompleteNewMembership() builds its RPC payload from whatever the
  // draft holds at this exact moment.
  const outcome = await E.membCompleteNewMembership();
  assert.equal(outcome, "created");

  const call = client.rpcCalls.find(c => c.name === "complete_membership");
  assert.ok(call, "complete_membership must actually be called");
  const p = call.params.p;

  // AC2
  assert.ok(p.prefs.occasions.some(o => o.name === "Me"),
    "the payload's prefs.occasions must still hold the 'Me' entry");
  for(const a of p.agents){
    for(const occId of (a.criteria.occasions || [])){
      assert.ok(p.prefs.occasions.some(o => o.id === occId),
        `agent occasion id ${occId} must resolve to an entry in prefs.occasions`);
    }
  }
  assert.equal(p.prefs.services_only, true, "the payload must still carry services_only: true");
  assert.equal(p.notify.email_on, true, "the payload must carry email_on: true");
  assert.equal(p.notify.email_address, SIGNUP_EMAIL, "the payload's email must be the sign-up address");

  // AC3: after the stubbed RPC returns 'created' and the account fan-out has finished.
  assert.ok(E.occasionReg.length >= 1, "occasionReg must hold at least one entry after landing");
  const landedAgent = E.cascades[0];
  const landedOccId = (landedAgent.occasions || [])[0];
  assert.equal(E.occasionName(landedOccId), "Me",
    "the first agent's occasion id must resolve to 'Me' after landing");
});

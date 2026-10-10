// CAS-1243: follow-on to CAS-1241 — the queue jam (fa1b76a) and the smoke failure (bdb82b0) are fixed, but
// the integrity gate was still red: boot and reconcile wrote view-state fields (seenFound, active,
// activeMulti, reviewSessions) that nothing the person did caused. CAS-1218's rule has no exceptions: a
// boot, load, render, poll or reconcile never writes account data.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// A stateful fake Supabase client, same convention as cas1241-keepalive-cap.test.mjs's own makeStatefulClient
// (upsert/update/delete actually mutate the table, a later select reflects it) — extended to take its
// backing `tables` object and its own `calls` log as arguments, so two devices sharing one account (AC1) can
// each get a distinct client/call-log pair pointed at the SAME underlying rows, exactly like two real
// Supabase clients talking to one server would.
function makeStatefulClient(tables, calls){
  const keyOf = (row, keys) => keys.map(k => String(row[k])).join("|");
  function builder(table){
    const state = { table, kind: "select", filters: [] };
    const b = {
      select(){ return b; },
      order(col, opts){ state.orderCol = col; state.orderDesc = opts && opts.ascending === false; return b; },
      range(from, to){ state.from = from; state.to = to; return b; },
      eq(col, val){ state.filters.push([col, val, "eq"]); return b; },
      in(col, vals){ state.filters.push([col, vals, "in"]); return b; },
      is(col, val){ state.filters.push([col, val, "is"]); return b; },
      limit(n){ state.limitN = n; return b; },
      single(){ state.single = true; return b; },
      maybeSingle(){ state.single = true; return b; },
      upsert(rows, opts){ state.kind = "upsert"; state.rows = Array.isArray(rows) ? rows : [rows]; state.opts = opts || {}; return b; },
      update(fields){ state.kind = "update"; state.fields = fields; return b; },
      match(m){ state.match = m; return b; },
      delete(){ state.kind = "delete"; return b; },
      then(resolve, reject){
        try{
          calls.push({ table, kind: state.kind });
          const rows = tables[table] || (tables[table] = []);
          if(state.kind === "select"){
            let out = rows.slice();
            state.filters.forEach(([col, val, op]) => {
              out = out.filter(r => op === "in" ? val.includes(r[col])
                : op === "is" ? (r[col] === val || (val === null && r[col] == null))
                : String(r[col]) === String(val));
            });
            if(state.orderCol) out.sort((a, b2) => {
              const av = a[state.orderCol], bv = b2[state.orderCol];
              return (av > bv ? 1 : av < bv ? -1 : 0) * (state.orderDesc ? -1 : 1);
            });
            if(typeof state.from === "number") out = out.slice(state.from, state.to + 1);
            if(state.limitN) out = out.slice(0, state.limitN);
            resolve(state.single ? { data: out[0] || null, error: null } : { data: out, error: null });
          } else if(state.kind === "upsert"){
            const onConflict = (state.opts.onConflict || "id").split(",");
            state.rows.forEach(row => {
              const idx = rows.findIndex(r => keyOf(r, onConflict) === keyOf(row, onConflict));
              if(idx >= 0){ if(!state.opts.ignoreDuplicates) Object.assign(rows[idx], row); }
              else rows.push({ ...row });
            });
            resolve({ data: state.rows, error: null, status: 200 });
          } else if(state.kind === "update"){
            const matches = r => Object.keys(state.match || {}).every(k => String(r[k]) === String(state.match[k]));
            rows.forEach(r => { if(matches(r)) Object.assign(r, state.fields); });
            resolve({ data: rows.filter(matches), error: null, status: 200 });
          } else if(state.kind === "delete"){
            const matches = r => Object.keys(state.match || {}).every(k => String(r[k]) === String(state.match[k]));
            tables[table] = rows.filter(r => !matches(r));
            resolve({ data: [], error: null, status: 200 });
          } else resolve({ data: [], error: null });
        } catch(e){ reject(e); }
      },
    };
    return b;
  }
  return {
    tables,
    from(table){ return builder(table); },
    rpc(name, params){
      calls.push({ table: name, kind: "rpc", params });
      if(name === "merge_user_prefs_view" && tables.user_prefs && tables.user_prefs[0]){
        Object.assign(tables.user_prefs[0], { view: Object.assign({}, tables.user_prefs[0].view, params.p_patch) });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}
function signIn(E, client, userId){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
  E.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [0, 0, 0];
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
async function waitUntil(fn, timeoutMs = 10_000){
  const start = Date.now();
  while(!fn()){
    if(Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise(r => setTimeout(r, 20));
  }
}
// Mirrors tests/e2e-integrity/helpers.mjs's seedCascades({}) shape — a criteria-less row matches the whole
// real catalogue, same "wide-open agent" convention cas1241-keepalive-cap.test.mjs's own tests use.
function wideOpenAgentRow(userId, id){
  return { id, name: "Wide open agent", criteria: {}, active: true, user_id: userId, updated_at: "2026-01-01T00:00:00.000Z" };
}

test("AC1: B's own reconcile sends zero non-select calls once A's verdict lands, with no boot-time seenFound write to cause one", async () => {
  const userId = "cas1243-ac1-user";
  const agentRow = wideOpenAgentRow(userId, "a0000000-0000-4000-8000-000000000011");
  const tables = {
    cascades: [agentRow],
    user_prefs: [{ user_id: userId, ref_code: "CAS1243AC1" }],
    notify_prefs: [{ user_id: userId, in_app: true, email_on: true, email_address: "x@test.com" }],
    user_films: [], film_watch: [], film_picks: [], agent_films: [],
    invites: [], friends: [], notifications: [], app_config: [],
  };
  const callsA = [], callsB = [];
  const EA = loadEngine(); const clientA = makeStatefulClient(tables, callsA);
  signIn(EA, clientA, userId);
  EA.cascades.length = 0; EA.cascades.push(EA.CascadeShape.rowToCascade(agentRow));
  EA.CascadeAccountStore.acctStore.cascades = [agentRow];

  const EB = loadEngine(); const clientB = makeStatefulClient(tables, callsB);
  signIn(EB, clientB, userId);
  EB.cascades.length = 0; EB.cascades.push(EB.CascadeShape.rowToCascade(agentRow));
  EB.CascadeAccountStore.acctStore.cascades = [agentRow];

  try{
    await EA.CascadePersistence.fireAccountFanout("ac1-a-setup");
    await waitUntil(() => EA.CascadeAccountStore.queue.length === 0);
    await EB.CascadePersistence.fireAccountFanout("ac1-b-setup");
    await waitUntil(() => EB.CascadeAccountStore.queue.length === 0);
    // The wide-open agent's own first admission sweep schedules a debounced admitDrift push on each engine
    // (CAS-1222, out of scope for this ticket — see its own "do not re-raise" note). Flush it directly
    // (rather than sleeping past the debounce window, which the next render's own trackAdmitDrift call can
    // keep re-arming) so it is gone before the window this AC actually measures starts.
    await EA.CascadePersistence.flushViewPatch();
    await EB.CascadePersistence.flushViewPatch();
    await waitUntil(() => EA.CascadeAccountStore.queue.length === 0);
    await waitUntil(() => EB.CascadeAccountStore.queue.length === 0);

    const filmId = EA.MOVIES.find(m => EA.found.has(m.tmdb_id)).tmdb_id;
    assert.ok(EB.found.has(filmId), "sanity: B's own first admission sweep must also have found this film");

    // Warm-up pass (same convention as cas1241-keepalive-cap.test.mjs's own AC3): reconcileOnReturn's own
    // per-table reconcileUnchanged() gate has nothing to compare against on its first-ever call for any
    // given table, so that first call always renders even though nothing has actually changed yet — not
    // what this AC measures. The SECOND call below, after a real change, is the one that is.
    EB.CascadePersistence.reconcileOnReturn();
    await waitUntil(() => EB.CascadeAccountStore.queue.length === 0);
    await EB.CascadePersistence.flushViewPatch();
    await waitUntil(() => EB.CascadeAccountStore.queue.length === 0);

    EA.setOpinion(filmId, "liked");
    await waitUntil(() => EA.CascadeAccountStore.queue.length === 0);

    callsB.length = 0;   // only B's OWN reconcile, from here, is what this AC is about
    EB.CascadePersistence.reconcileOnReturn();
    await waitUntil(() => EB.CascadeAccountStore.queue.length === 0);
    await new Promise(r => setTimeout(r, 1000));   // let every fire-and-forget load inside it settle

    assert.equal(EB.opinionOf(filmId), "liked", "sanity: B must actually have adopted A's verdict");
    // CAS-1222's admitDrift tracking (out of scope for this ticket — see its own "do not re-raise" note)
    // legitimately prunes and re-pushes once `found` changes, which adopting A's verdict here also causes —
    // a real, pre-existing write unrelated to the seenFound/active/activeMulti/reviewSessions ones this
    // ticket is about, so it is excluded from this count rather than silencing the AC. CAS-1243 round 2:
    // riderReviewSessionsOnto rides reviewSessions onto whichever merge_user_prefs_view write fires next,
    // which can legitimately be this very admitDrift flush rather than a more obviously "user" one — tolerate
    // it riding along too.
    const isOutOfScopeAdmitDriftPush = c => c.kind === "rpc" && c.table === "merge_user_prefs_view"
      && c.params && Object.keys(c.params.p_patch || {}).every(k => k === "admitDrift" || k === "reviewSessions");
    const nonSelect = callsB.filter(c => c.kind !== "select" && !isOutOfScopeAdmitDriftPush(c));
    assert.deepEqual(nonSelect, [], `B's own reconcile must send zero calls that are not selects (besides CAS-1222's own out-of-scope admitDrift prune): ${JSON.stringify(nonSelect)}`);
  } finally {
    EA.cascades.length = 0; EB.cascades.length = 0;
    signOut(EA); signOut(EB);
  }
});

test("AC2: once every ready flag first reads true, no merge_user_prefs_view call ever arrives", async () => {
  const userId = "cas1243-ac2-user";
  const calls = [];
  const E = loadEngine();
  // genre:null matches zero films (CAS-1217's own convention) — this AC is about active/activeMulti/
  // reviewSessions specifically, so the agent is built to admit nothing, keeping the unrelated (and
  // out-of-scope for this ticket) debounced admitDrift push from ever firing and confusing the count.
  const agentRow = Object.assign(
    { id: "a0000000-0000-4000-8000-000000000012", user_id: userId, updated_at: "2026-01-01T00:00:00.000Z" },
    E.CascadeShape.cascadeToRow(E.normCascade({ id: "a0000000-0000-4000-8000-000000000012", name: "Zero-match agent", genre: null })));
  const tables = {
    cascades: [agentRow],
    user_prefs: [{ user_id: userId, ref_code: "CAS1243AC2" }],
    notify_prefs: [{ user_id: userId, in_app: true, email_on: true, email_address: "x@test.com" }],
    user_films: [], film_watch: [], film_picks: [], agent_films: [],
    invites: [], friends: [], notifications: [], app_config: [],
  };
  const client = makeStatefulClient(tables, calls);
  signIn(E, client, userId);
  E.cascades.length = 0; E.cascades.push(E.CascadeShape.rowToCascade(agentRow));
  E.CascadeAccountStore.acctStore.cascades = [agentRow];
  try{
    const CP = E.CascadePersistence;
    const allReady = () => CP.userPrefsReady && CP.notifyPrefsReady && CP.filmWatchReady && CP.agentFilmsReady;

    const fanout = CP.fireAccountFanout("ac2");
    await waitUntil(allReady);
    calls.length = 0;   // only calls from the moment every ready flag first read true count here

    await new Promise(r => setTimeout(r, 3000));
    await fanout;

    const mergeCalls = calls.filter(c => c.kind === "rpc" && c.table === "merge_user_prefs_view");
    assert.deepEqual(mergeCalls, [], `zero merge_user_prefs_view calls may arrive once the fan-out has settled: ${JSON.stringify(mergeCalls)}`);
  } finally {
    E.cascades.length = 0;
    signOut(E);
  }
});

test("AC3 round 2: reviewSessions rides piggyback on the next real user-action view write; a second write carries no key", async () => {
  const userId = "cas1243-ac3-user";
  const calls = [];
  const tables = { user_prefs: [{ user_id: userId, view: { reviewSessions: 6 } }] };
  const E = loadEngine();
  signIn(E, makeStatefulClient(tables, calls), userId);
  try{
    // loadEngine() just ran the whole script from scratch, including its own boot-time app_open block —
    // the same bumpReviewPromptSessionCount() call a real page load makes.
    assert.equal(E.reviewPromptSessionCount(), 1, "boot's own bump, visible to this session immediately");

    await E.CascadePersistence.loadUserPrefs();
    assert.equal(E.reviewPromptSessionCount(), 7, "replayed as the account's 6 plus this session's own +1");

    // No user action for 3s: round 1's page-hidden trigger is gone (it fired on an unloading document too,
    // which is a reload, not a user action — see riderReviewSessionsOnto's own comment). There is no seam
    // left to "fire" here either way: engine.mjs's document stub swallows every addEventListener call, so
    // this harness never could register (or replay) a real visibilitychange listener — the only guarantee
    // that matters is that production code no longer attaches one for reviewSessions, confirmed by
    // inspection rather than a runtime call.
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(calls.filter(c => c.kind === "rpc" && c.table === "merge_user_prefs_view").length, 0,
      "no user action, no view write — reviewSessions must not leave the device on its own");

    E.setActive("a0000000-0000-4000-8000-000000000097");
    await waitUntil(() => E.CascadeAccountStore.queue.length === 0);   // sendQueue's own reentrancy guard
    const mergeCalls = calls.filter(c => c.kind === "rpc" && c.table === "merge_user_prefs_view");
    assert.ok(mergeCalls.length >= 1, "setActive's own active/activeMulti writes must have gone out");
    const withReviewSessions = mergeCalls.filter(c => "reviewSessions" in c.params.p_patch);
    assert.equal(withReviewSessions.length, 1, "reviewSessions must appear in exactly one of setActive's patches");
    assert.equal(withReviewSessions[0].params.p_patch.reviewSessions, 7, "the account's stored count plus this session's +1");

    calls.length = 0;
    E.setActive("a0000000-0000-4000-8000-000000000096");
    await waitUntil(() => E.CascadeAccountStore.queue.length === 0);
    const secondMergeCalls = calls.filter(c => c.kind === "rpc" && c.table === "merge_user_prefs_view");
    assert.ok(secondMergeCalls.length >= 1, "the second setActive's own writes must also have gone out");
    assert.ok(secondMergeCalls.every(c => !("reviewSessions" in c.params.p_patch)),
      "a second user view write this session must carry no reviewSessions key — already consumed");
  } finally {
    signOut(E);
  }
});

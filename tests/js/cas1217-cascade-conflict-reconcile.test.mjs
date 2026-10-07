// CAS-1217: a second device holding an old copy of an agent no longer overwrites a newer edit made on
// another device, and a device with nothing of its own queued now picks up an edit made elsewhere without
// waiting for a cold start/sign-in. Two devices sharing one account are simulated the way this harness
// naturally allows: two independent loadEngine() realms (each its own closure, its own CascadeAccountStore)
// pointed at one shared fake "server" object — exactly "two simulated devices A and B on one account", the
// ticket's own phrase.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const USER_ID = "cas1217-shared-user";

// The one shared account two devices' fake clients read/write against. Each cascades row carries a
// strictly increasing updated_at so a conflict check behaves exactly like the real server's updated_at
// compare — never parsed, only ever compared for equality, the same guarantee acctOp itself relies on.
function makeServer(){
  let clock = 0;
  const rows = new Map();
  const stamp = () => { clock++; return `2026-10-07T00:00:${String(clock).padStart(3, "0")}.000Z`; };
  return {
    rows,
    insert(fields){
      const row = Object.assign({}, fields, { updated_at: stamp() });
      rows.set(row.id, row);
      return Object.assign({}, row);
    },
    update(match, fields, expectUpdatedAt){
      const row = rows.get(match.id);
      if(!row) return { data: [], error: null };
      if(expectUpdatedAt !== undefined && row.updated_at !== expectUpdatedAt) return { data: [], error: null };
      Object.assign(row, fields, { updated_at: stamp() });
      return { data: [Object.assign({}, row)], error: null };
    },
    getOne(match){ const row = rows.get(match.id); return row ? Object.assign({}, row) : null; },
    list(){ return [...rows.values()].map(r => Object.assign({}, r)); },
    deleteAgent(id){ rows.delete(id); },
    // Seeds a device's starting point directly (bypasses insert()'s own stamping) so a test controls the
    // exact starting updated_at both devices and the server agree on.
    seed(row){ rows.set(row.id, Object.assign({}, row)); },
  };
}

// One fake Supabase client per device, every call logged (table + the real request shape acctOp's own
// sendOnce would have sent) so a test can count PATCHes and conflict-reloads precisely. app_config (the
// CAS-1108 build-gate read every reconcileOnReturn/checkBuildGate call makes first) always answers "no
// gate row"; any table but cascades answers an empty read, same as a brand-new account with nothing there.
function makeDeviceClient(server, callLog){
  function resolveState(table, state){
    const kind = state.kind || (state.single ? "select-single" : "select");
    callLog.push({ table, kind, match: state.match, fields: state.fields });
    if(table === "app_config") return { data: [], error: null };
    if(table !== "cascades") return { data: [], error: null };
    if(kind === "insert") return { data: [server.insert(state.fields)], error: null };
    if(kind === "update") return server.update(state.match, state.fields, state.eqVal);
    if(kind === "select-single"){
      const row = server.getOne(state.match);
      return row ? { data: row, error: null } : { data: null, error: { message: "not found" } };
    }
    return { data: server.list(), error: null };   // acctLoad's own plain paged select
  }
  function builder(table){
    const state = { table };
    const b = {
      select(cols){ state.selectCols = cols; return b; },
      order(){ return b; },
      range(){ return b; },
      in(){ return b; },
      limit(){ return b; },
      match(m){ state.match = m; return b; },
      eq(col, v){ state.eqCol = col; state.eqVal = v; return b; },
      single(){ state.single = true; return b; },
      update(fields){ state.kind = "update"; state.fields = fields; return b; },
      upsert(fields){ state.kind = "insert"; state.fields = fields; return b; },
      delete(){ state.kind = "delete"; return b; },
      then(resolve, reject){
        const snapshot = Object.assign({}, state);
        return Promise.resolve().then(() => resolveState(table, snapshot)).then(resolve, reject);
      },
    };
    return b;
  }
  return {
    from: builder,
    rpc(name, params){
      callLog.push({ table: name, kind: "rpc" });
      if(name === "delete_agent") server.deleteAgent(params.p_id);
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function signIn(E, client){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: USER_ID } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
const settle = () => new Promise(r => setTimeout(r, 0));

function makeDevice(server){
  const E = loadEngine();
  const callLog = [];
  signIn(E, makeDeviceClient(server, callLog));
  return { E, callLog };
}

// Built through the real cascadeToRow/normCascade (not hand-rolled), the same CAS-1109 reasoning: a
// hand-built row could disagree with what the shipped mapper actually produces. updated_at is stamped
// explicitly — without one, expectUpdatedAt is undefined end to end and every conflict check (client AND
// this file's own fake server) is silently skipped, which is not what any of these tests mean to exercise.
// genre:null means "explicitly none (nothing qualifies)" per normCascade's own comment — this agent must
// match zero films, or render()'s real admission/moving-ledger bookkeeping against the full (real, ~9,000
// title) catalogue makes every reconcile in these tests cost whole seconds for no reason relevant to the
// sync logic under test here.
function baseRow(E, id, name){
  return JSON.parse(JSON.stringify(Object.assign({ id, user_id: USER_ID, updated_at: "2026-10-01T00:00:00.000Z" },
    E.CascadeShape.cascadeToRow(E.normCascade({ id, name, genre: null })))));
}
function seedDevice(E, row){
  E.CascadeAccountStore.acctStore.cascades = [Object.assign({}, row)];
  E.cascades.length = 0;
  E.cascades.push(E.CascadeShape.rowToCascade(Object.assign({}, row)));
}
function cascadesPatches(callLog){ return callLog.filter(c => c.table === "cascades" && c.kind === "update"); }
function cascadesConflictReloads(callLog){ return callLog.filter(c => c.table === "cascades" && c.kind === "select-single"); }

const AC1_ID = "11111111-1111-4111-8111-111111111111";
// AC1/AC2/AC7's shared scenario: B already holds a stale, independently-diverged copy of agent X (its own
// `cascades` entry disagrees with its own last-known account mirror, never mind the account itself) when A
// pushes a real edit. B then calls saveCascades() without touching X at all.
async function buildAdoptedScenario(){
  const server = makeServer();
  const A = makeDevice(server);
  const B = makeDevice(server);
  const base = baseRow(A.E, AC1_ID, "Original");
  server.seed(base);
  seedDevice(A.E, base);
  seedDevice(B.E, base);
  // "B holds an older copy of agent X": B's own UI array already disagrees with its own mirror, a
  // pre-existing discrepancy this scenario doesn't need to explain, only exercise.
  B.E.cascades[0] = B.E.CascadeShape.rowToCascade(Object.assign({}, base, { name: "B-Stale" }));

  A.E.cascades.find(c => c.id === AC1_ID).name = "A-Edit";
  A.E.CascadePersistence.syncCascadesToAccount();
  await settle();

  B.E.CascadePersistence.saveCascades();
  await settle();

  return { server, A, B, idX: AC1_ID };
}

test("CAS-1217 AC1: a conflicting push from a stale device never overwrites the winning device's edit", async () => {
  const { server, A, B, idX } = await buildAdoptedScenario();
  try{
    assert.equal(server.rows.get(idX).name, "A-Edit", "the account's row must stay exactly what A wrote");
    assert.equal(cascadesPatches(B.callLog).length, 1, "B's one stale push attempt is the only cascades PATCH it issued");
  } finally { signOut(A.E); signOut(B.E); }
});

test("CAS-1217 AC2: after the conflict, B's own cascades entry matches the account, and a further save pushes nothing", async () => {
  const { server, A, B, idX } = await buildAdoptedScenario();
  try{
    const row = B.E.cascades.find(c => c.id === idX);
    assert.equal(row.name, "A-Edit", "B's in-memory copy must now equal the account's winning row");
    const before = cascadesPatches(B.callLog).length;
    B.E.CascadePersistence.saveCascades();
    await settle();
    assert.equal(cascadesPatches(B.callLog).length, before, "a device that now matches the account must push nothing on its next save");
  } finally { signOut(A.E); signOut(B.E); }
});

test("CAS-1217 AC7: once B has adopted the account's version, a real edit from B pushes cleanly and wins", async () => {
  const { server, A, B, idX } = await buildAdoptedScenario();
  try{
    const beforePatches = cascadesPatches(B.callLog).length;
    const beforeConflicts = cascadesConflictReloads(B.callLog).length;
    B.E.cascades.find(c => c.id === idX).name = "B-Edit-After-Adopt";
    B.E.CascadePersistence.syncCascadesToAccount();
    await settle();
    assert.equal(cascadesPatches(B.callLog).length - beforePatches, 1, "exactly one PATCH for the real edit");
    assert.equal(cascadesConflictReloads(B.callLog).length, beforeConflicts, "it must be accepted first time, not conflict-reloaded");
    assert.equal(server.rows.get(idX).name, "B-Edit-After-Adopt", "the account must now hold B's own edit");
  } finally { signOut(A.E); signOut(B.E); }
});

const AC3_ID = "22222222-2222-4222-8222-222222222222";
function makeSyncedPair(id, name){
  const server = makeServer();
  const A = makeDevice(server);
  const B = makeDevice(server);
  const base = baseRow(A.E, id, name);
  server.seed(base);
  seedDevice(A.E, base);
  seedDevice(B.E, base);
  return { server, A, B, idX: id };
}

test("CAS-1217 AC3: reconcileOnReturn() pulls an edit made on another device when nothing of this device's own is queued", async () => {
  const { A, B, idX } = makeSyncedPair(AC3_ID, "Original");
  try{
    A.E.cascades.find(c => c.id === idX).name = "A-Edit3";
    A.E.CascadePersistence.syncCascadesToAccount();
    await settle();

    B.E.CascadePersistence.reconcileOnReturn();
    await settle();

    const row = B.E.cascades.find(c => c.id === idX);
    assert.equal(row.name, "A-Edit3", "B must have pulled A's edit");
    assert.equal(cascadesPatches(B.callLog).length, 0, "a pure pull must never itself PATCH");
  } finally { signOut(A.E); signOut(B.E); }
});

const AC4_ID = "33333333-3333-4333-8333-333333333333";
test("CAS-1217 AC4: reconcileOnReturn() never replaces an agent this device still has an unsent edit queued for", async () => {
  const { server, A, B, idX } = makeSyncedPair(AC4_ID, "Original");
  try{
    // Same synchronous tick, deliberately: acctOp pushes onto the queue before its own send ever reaches
    // its first await, so reconcileOnReturn's guard — called immediately after, no `await` in between —
    // is guaranteed to see the still-unsent op and skip the pull outright, never issuing the read at all.
    B.E.cascades.find(c => c.id === idX).name = "B-Unsent";
    B.E.CascadePersistence.syncCascadesToAccount();
    B.E.CascadePersistence.reconcileOnReturn();
    await settle();

    const row = B.E.cascades.find(c => c.id === idX);
    assert.equal(row.name, "B-Unsent", "the still-queued edit must never be replaced by a reconcile pull");
    assert.equal(server.rows.get(idX).name, "B-Unsent", "the queued update must still have been sent and accepted");
    const pulls = B.callLog.filter(c => c.table === "cascades" && c.kind === "select");
    assert.equal(pulls.length, 0, "the guard must skip the pull outright, never even issuing the read");
  } finally { signOut(A.E); signOut(B.E); }
});

test("CAS-1217 AC5: two consecutive real edits on one device each record exactly one accepted PATCH", async () => {
  const server = makeServer();
  const id = "44444444-4444-4444-8444-444444444444";
  const A = makeDevice(server);
  const base = baseRow(A.E, id, "Original");
  server.seed(base);
  seedDevice(A.E, base);
  try{
    A.E.cascades.find(c => c.id === id).name = "Edit1";
    A.E.CascadePersistence.syncCascadesToAccount();
    await settle();
    assert.equal(server.rows.get(id).name, "Edit1");

    A.E.cascades.find(c => c.id === id).name = "Edit2";
    A.E.CascadePersistence.syncCascadesToAccount();
    await settle();
    assert.equal(server.rows.get(id).name, "Edit2");

    assert.equal(cascadesPatches(A.callLog).length, 2, "exactly one PATCH per edit");
    assert.equal(cascadesConflictReloads(A.callLog).length, 0, "neither edit may ever hit the 0-rows conflict branch against itself");
  } finally { signOut(A.E); }
});

const AC6_ID = "55555555-5555-4555-8555-555555555555";
test("CAS-1217 AC6: ten reconcile+save cycles against an unchanged account push nothing", async () => {
  const { A, B, idX } = makeSyncedPair(AC6_ID, "Original");
  try{
    for(let i = 0; i < 10; i++){
      B.E.CascadePersistence.reconcileOnReturn();
      await settle();
      B.E.CascadePersistence.saveCascades();
      await settle();
    }
    assert.equal(cascadesPatches(B.callLog).length, 0, "an unchanged device must never push, even after repeated reconcile+save");
    assert.equal(B.E.cascades.find(c => c.id === idX).name, "Original", "sanity: nothing drifted either");
  } finally { signOut(A.E); signOut(B.E); }
});

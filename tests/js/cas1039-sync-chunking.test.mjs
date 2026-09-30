// CAS-1039 AC2/AC3 — a real account can carry thousands of agent_films rows (the back-catalogue growth
// that made a single-request bulk upsert fail network-side, "TypeError: Load failed"). The fix: push only
// rows this device has actually changed (diffed against agentFilmsKnown, the same known-value-diff shape
// cascadeKnown already gave cascades), in requests of at most SYNC_CHUNK_SIZE rows, with one chunk's
// failure never blocking another chunk's success. These tests drive the real seam
// (CascadePersistence.syncAgentFilmsNow) with a stubbed Supabase client, the same convention
// outbox-durability.test.mjs and sync-outcomes.test.mjs use.
//
// CAS-1096 moved user_films and film_watch off this whole chunked-diff mechanism onto acctOp (one
// operation per row, per user action) — their own chunking tests below are retired, not replaced in kind,
// since a single-row op has nothing left to chunk; see tests/js/cas1096-account-store.test.mjs for their
// own acctOp-shaped coverage instead. agent_films is untouched here; CAS-1097 is the ticket that moves it
// (and automatic Watch On placement) onto acctOp too.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// A fake client whose upsert/delete behaviour is driven per table by an optional failure predicate —
// upsert predicates see the rows in that one request; delete predicates see the accumulated .eq() filters
// (plus an `in` array when the call chains .in(), the way user_films/film_watch's own deletes do; agent_films'
// deletes are grouped per cascade_id and chunked through .in("movie_id",...) too, per CAS-1049).
function makeFakeClient({ shouldFailUpsert = {}, shouldFailDelete = {} } = {}){
  const upsertCalls = [];
  const deleteCalls = [];
  return {
    upsertCalls, deleteCalls,
    from(table){
      return {
        upsert(rows){
          upsertCalls.push({ table, rows });
          const fail = shouldFailUpsert[table];
          const err = (fail && fail(rows)) ? { message: `CAS-1039 test: forced ${table} upsert failure` } : null;
          const result = err ? { data: null, error: err } : { data: rows, error: null };
          return { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
        },
        select(){
          const thenable = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
          thenable.order = () => thenable; thenable.limit = () => thenable; thenable.eq = () => thenable;
          thenable.range = () => thenable;
          return thenable;
        },
        delete(){
          const chain = { _eq: {} };
          const settle = (extra) => {
            const eq = { ...chain._eq, ...(extra||{}) };
            deleteCalls.push({ table, eq });
            const fail = shouldFailDelete[table];
            const err = (fail && fail(eq)) ? { message: `CAS-1039 test: forced ${table} delete failure` } : null;
            return err ? { data: null, error: err } : { data: [], error: null };
          };
          chain.eq = (col, val) => { chain._eq[col] = val; return chain; };
          chain.in = (col, vals) => {
            const result = settle({ [col]: vals });
            return { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
          };
          chain.then = (resolve, reject) => Promise.resolve(settle()).then(resolve, reject);
          return chain;
        },
      };
    },
  };
}
function signIn(E, client, userId = "cas1039-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}

test("CAS-1039 AC2: 3000 agent_films rows push as a chunked full resync, none over 200 rows", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  signIn(E, client);
  try{
    const cascadeIds = ["cas1039-agent-a", "cas1039-agent-b", "cas1039-agent-c"];
    for(let i=0;i<3000;i++){
      E.CascadePersistence.setAgentFilm(cascadeIds[i % cascadeIds.length], 9500000+i,
        { admission_score: 50, admission_status: "stream", agent_sig: "sig-"+i });
    }
    await E.CascadePersistence.syncAgentFilmsNow();
    const calls = client.upsertCalls.filter(c => c.table==="agent_films");
    assert.ok(calls.length > 1, "sanity: 3000 rows must have taken more than one request");
    calls.forEach(c => assert.ok(c.rows.length <= 200, `a request carried ${c.rows.length} rows, over the 200 cap`));
    assert.equal(calls.reduce((n,c)=>n+c.rows.length, 0), 3000,
      "every dirty row must reach the account exactly once across all chunks");
    assert.equal(E.CascadePersistence.syncOutcome.agent_films.ok, true);
  } finally{ signOut(E); }
});

test("CAS-1039/CAS-1049 AC3: a forced failure deleting one agent_films chunk leaves the other chunk's deletes applied", async () => {
  const E = loadEngine();
  const cascadeId = "cas1039-delete-agent";
  // 150 rows in one cascade -> two delete chunks under AGENT_DELETE_CHUNK_SIZE (100 + 50). Force the
  // chunk containing this id to fail; the other chunk must still go through.
  const FAIL_MOVIE_ID = String(9600000+37);
  const client = makeFakeClient({
    shouldFailDelete: { agent_films: eq => Array.isArray(eq.movie_id) && eq.movie_id.includes(FAIL_MOVIE_ID) },
  });
  signIn(E, client);
  try{
    for(let i=0;i<150;i++){
      E.CascadePersistence.setAgentFilm(cascadeId, 9600000+i,
        { admission_score: 50, admission_status: "stream", agent_sig: "sig-"+i });
    }
    await E.CascadePersistence.syncAgentFilmsNow();   // full resync — seeds agentFilmsKnown for all 150

    for(let i=0;i<150;i++) E.CascadePersistence.clearAgentFilm(cascadeId, 9600000+i);   // every row now "gone"
    client.upsertCalls.length = 0; client.deleteCalls.length = 0;

    await E.CascadePersistence.syncAgentFilmsNow();

    // Deletes converge the same way cascades' own cascadeKnown/cascadePendingDeleteIds do: durability comes
    // from the row surviving in agentFilmsKnown (so the NEXT sync's agentFilmPendingDeleteKeys() re-derives
    // and retries it), not from an outbox entry — a delete was never marked into the outbox to begin with,
    // upstream of this ticket, the same as cascades' own delete path.
    const known = E.CascadePersistence.agentFilmsKnown;
    const failedChunkIds = client.deleteCalls.find(c => c.table==="agent_films" &&
      Array.isArray(c.eq.movie_id) && c.eq.movie_id.includes(FAIL_MOVIE_ID)).eq.movie_id;
    failedChunkIds.forEach(id => assert.ok(known.has(cascadeId+"::"+id),
      `${id} was in the chunk whose delete failed and must still be known, so the next sync retries it`));
    assert.equal(known.size, failedChunkIds.length,
      "the other chunk's deletes must have succeeded and left agentFilmsKnown");
    assert.equal(E.CascadePersistence.syncOutcome.agent_films.ok, false);
  } finally{ signOut(E); }
});

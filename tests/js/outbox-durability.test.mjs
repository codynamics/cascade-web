// CAS-1035: a Watch On tick (or any other account write) made inside its own debounce, then lost to a tab
// closing or being backgrounded-and-killed, used to revert on the next boot — nothing durable ever recorded
// that the push was still owed, and clearAccountNotify()/applyFilmRows()/applyAgentFilmRows() all rebuild
// their state from whatever the account happened to have, wiping an edit the account never saw. The
// original fix was a dedicated outbox (outboxMark/outboxPending/outboxOverlay) film_watch pushed through.
//
// CAS-1096 moved film_watch (and user_films/film_picks) off that outbox entirely, onto acctOp — CAS-1094's
// shared write path, which already persists its own queue (cascade_ops@<uid>) synchronously on every call,
// with no debounce and no microtask coalescing to race a pagehide against. That queue is now this table's
// own durability story, and acctOpPendingOverlay (app_template.html, alongside loadFilmWatches) is what a
// load overlays it through — the same "a still-unsent row must survive a load" guarantee outboxOverlay gave
// before it. These tests re-prove CAS-1035's original guarantees against the new mechanism.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// A minimal fake client whose upsert/select behaviour is driven per table by the caller — everything else
// (delete, other tables) succeeds with empty data, the same permissive default fakeUpsertClient's sibling
// helpers in sync-outcomes.test.mjs use.
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
          return { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
        },
        select(){
          const spec = selects[table];
          const result = spec ? spec() : { data: [], error: null };
          const thenable = { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
          thenable.order = () => thenable;
          thenable.limit = () => thenable;
          thenable.eq = () => thenable;
          thenable.range = () => thenable;
          return thenable;
        },
        delete(){
          const chain = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
          chain.eq = () => chain; chain.in = () => chain; chain.match = () => chain;
          return chain;
        },
      };
    },
  };
}
function signIn(E, client, userId = "cas1035-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
function zeroBackoff(E){ E.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [0, 0, 0]; }
// toggleFilmOpt no-ops on a level watchLevelsFor marks "spent" for that film's own rung — pick a film
// where "stream" (the last rung, so it's spent only for something already fully past it) is genuinely
// available, rather than assuming MOVIES[0] happens to qualify.
function pickStreamableFilm(E){
  const film = E.MOVIES.find(m => {
    const row = E.watchLevelsFor(m.tmdb_id).find(l => l.key === "stream");
    return row && !row.spent;
  });
  if(!film) throw new Error("no fixture film has an available Stream level — this test would prove nothing");
  return film;
}
const film_watch_op = (E, movieId) => E.CascadeAccountStore.queue.find(
  op => op.table === "film_watch" && op.match && String(op.match.movie_id) === String(movieId));

test("CAS-1035 AC1 (CAS-1096 shape): toggleFilmOpt attempts the film_watch push synchronously, with no debounce at all", () => {
  const E = loadEngine();
  const client = fakeClient();
  signIn(E, client);
  try{
    const film = pickStreamableFilm(E);
    E.toggleFilmOpt(film.tmdb_id, "stream");   // pushFilmWatch -> acctOp, kicked off before this call returns
    assert.ok(client.upsertCalls.some(c => c.table === "film_watch"),
      "the film_watch push must be attempted the instant toggleFilmOpt runs — acctOp has no debounce to wait out");
  } finally{ signOut(E); }
});

test("CAS-1035 AC3 regression (CAS-1096 shape): the pending write is durable in localStorage the instant toggleFilmOpt returns, no flush needed", () => {
  // CAS-1035 AC3's original bug was a microtask-coalesced persist racing a real pagehide. acctOp's own
  // persistQueue() is synchronous inside acctOp() itself — there is no coalescing left to race, so this is
  // now true unconditionally rather than only after calling flushAccountSync.
  const store = new Map();
  const E1 = loadEngine({ localStorageStore: store });
  const film = pickStreamableFilm(E1);
  const client = fakeClient({ upserts: { film_watch: { message: "network down" } } });
  signIn(E1, client);
  E1.toggleFilmOpt(film.tmdb_id, "stream");
  assert.ok(film_watch_op(E1, film.tmdb_id), "sanity: the op is visible in this device's own queue immediately");

  // Simulated reboot, same technique AC2 below uses: a fresh JS realm sharing the same localStorage-backed
  // queue, with nothing awaited between the mark and this "reload".
  const E2 = loadEngine({ localStorageStore: store });
  signIn(E2, fakeClient(), "cas1035-test-user");
  try{
    assert.ok(film_watch_op(E2, film.tmdb_id),
      "the queued op must already be durable in localStorage by the time toggleFilmOpt returned on E1");
  } finally{ signOut(E2); signOut(E1); }
});

test("CAS-1035 AC2 (CAS-1096 shape): a failed film_watch push survives a simulated reboot and outlives a load whose remote row is older", async () => {
  const store = new Map();   // shared localStorage backing — the CAS-969 "simulated reboot" technique
  const E1 = loadEngine({ localStorageStore: store });
  const film = pickStreamableFilm(E1);
  const movieId = String(film.tmdb_id);

  const failingClient = fakeClient({ upserts: { film_watch: { message: "network down" } } });
  signIn(E1, failingClient);
  zeroBackoff(E1);
  E1.toggleFilmOpt(film.tmdb_id, "stream");
  await new Promise(r => setTimeout(r, 0));   // let acctOp's own queued send exhaust its retries and give up

  assert.ok(film_watch_op(E1, movieId), "a failed push must leave the op durably queued for this movie");
  assert.equal(E1.notify[film.tmdb_id].wins.stream, true, "sanity: the local tick itself is still on");

  // Simulated reboot: a fresh JS realm (new loadEngine call) sharing the same localStorage-backed queue —
  // `notify` itself is also restored from localStorage at top-level init, exactly as a real page load does.
  const E2 = loadEngine({ localStorageStore: store });
  assert.equal(E2.notify[film.tmdb_id]?.wins?.stream, true,
    "sanity: the tick survived the localStorage round-trip on its own, before any account load runs");

  // This boot's connection still fails the upsert, and film_watch's own read returns an OLDER remote row
  // for the same movie — no windows ticked at all, i.e. the state from before this device's tick.
  const staleRemoteRow = { movie_id: movieId, windows: [], sources: {}, updated_at: "2020-01-01T00:00:00.000Z" };
  const bootClient = fakeClient({
    upserts: { film_watch: { message: "still down" } },
    selects: { film_watch: () => ({ data: [staleRemoteRow], error: null }) },
  });
  signIn(E2, bootClient, "cas1035-test-user");
  zeroBackoff(E2);
  try{
    await E2.CascadePersistence.replayOutbox();   // AC2: replayed BEFORE the load below
    assert.ok(bootClient.upsertCalls.some(c => c.table === "film_watch"),
      "replayOutbox must have attempted the film_watch push again on this boot");

    await E2.CascadePersistence.loadFilmWatches();   // the exact call fireAccountFanout makes next
    assert.equal(E2.notify[film.tmdb_id].wins.stream, true,
      "the local tick must survive a load whose remote row is older, even though the replay above also failed");
  } finally{ signOut(E2); }
});

// The real cause behind the original AC3's repeated WebKit-only failures: fireAccountFanout sets
// filmWatchReady=false, then loadFilmWatches() clears `notify` before its remote fetch resolves and
// applyWatchRows() repopulates it. Under CAS-1096, pushFilmWatch's own filmWatchReady guard (not a shared
// scan-based outbox mark) is what protects a tick made in that window — it defers rather than sending a
// push built off a still-incomplete local entry, and catches up once filmWatchReady flips true.
test("CAS-1096: pushFilmWatch made while filmWatchReady is false defers, then sends once the device's own load resolves", async () => {
  const E = loadEngine();
  const client = fakeClient();
  signIn(E, client);
  zeroBackoff(E);
  try{
    const film = pickStreamableFilm(E);
    E.CascadePersistence.filmWatchReady = false;
    E.toggleFilmOpt(film.tmdb_id, "stream");
    assert.equal(client.upsertCalls.filter(c => c.table === "film_watch").length, 0,
      "a tap made before this device's own film_watch load has resolved must not push yet");
    assert.equal(E.notify[film.tmdb_id].wins.stream, true, "sanity: the tap itself still landed locally");

    E.CascadePersistence.filmWatchReady = true;
    await new Promise(r => setTimeout(r, 60));   // pushFilmWatch's own 50ms defer retry
    assert.ok(client.upsertCalls.some(c => c.table === "film_watch"),
      "the deferred push must send once filmWatchReady flips true");
  } finally{ signOut(E); }
});

test("CAS-1035: a queued film_watch op clears once its push actually succeeds", async () => {
  const E = loadEngine();
  const client = fakeClient({ upserts: { film_watch: null } });   // succeeds
  const film = pickStreamableFilm(E);
  signIn(E, client);
  zeroBackoff(E);
  try{
    E.toggleFilmOpt(film.tmdb_id, "stream");
    assert.ok(film_watch_op(E, film.tmdb_id), "sanity: the tap queues the op immediately");

    await new Promise(r => setTimeout(r, 0));   // let the queued send resolve against the fake client
    assert.ok(!film_watch_op(E, film.tmdb_id), "a successful push must clear its own queue entry");
  } finally{ signOut(E); }
});

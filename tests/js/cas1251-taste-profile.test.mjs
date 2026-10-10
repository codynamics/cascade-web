// CAS-1251: taste profile part 1 — tasteProfile()/tasteMatch(), the calculation that works out which
// styles of film a person goes for (and avoids) from their verdicts alone, and a Match number for any
// film from that. Calculation and tests only — nothing here draws or stores anything.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// ---- fixture building -------------------------------------------------------------------------------
// wmScaled is monotonic non-decreasing and piecewise-linear (continuous) over its whole domain, so every
// integer target in [0,100] is reachable by SOME wm_user_rating — found here by binary search, since
// WM_SCALE's own knots don't happen to land on the ticket's fixture scores.
function ratingForScore(target){
  let lo = 0, hi = 100;
  for(let i = 0; i < 60; i++){
    const mid = (lo + hi) / 2;
    if(Math.round(E.wmScaled(mid)) < target) lo = mid; else hi = mid;
  }
  // The bisection above converges on the EDGE of the plateau where wmScaled first rounds to `target` —
  // and the /10 here (wm_user_rating) then *10 back (wmQScore's own p.push(wm_user_rating*10)) is its own
  // tiny floating-point round trip, enough right at that edge to round the wrong way. Nudge forward,
  // checking through the SAME round trip the real call will make, until it actually matches.
  let v = hi;
  for(let i = 0; i < 2000 && Math.round(E.wmScaled((v/10)*10)) !== target; i++) v += 0.01;
  return v / 10;
}
let _nextFixtureId = 900001;
// A released film (ps !== upcoming/in_cinema/opening_week) whose cascadeScore is EXACTLY `score` — verified
// immediately, so a wrong fixture fails loudly at setup rather than silently mis-scoring an assertion.
function scoredFilm(genres, score){
  const id = _nextFixtureId++;
  const m = { tmdb_id:id, title:`Taste fixture ${id}`, genres, status:["included_streaming"],
    wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true };
  const got = E.cascadeScore(m);
  if(got !== score) throw new Error(`test setup: fixture ${id} cascadeScore computed ${got}, expected ${score}`);
  return m;
}
const round4 = v => Math.round(v*10000)/10000;

// Pushes fixture films into MOVIES and gives each an exact verdict, with the real six verdict sets
// (watched/disliked/indifferent/wowed/enjoyed/blocked) emptied for the run and restored afterward — the
// isolation AC1 asks for. `assignments` is [[film, verdictKey], ...].
function withTasteFixture(assignments, fn){
  const saved = {
    watched: new Set(E.watched), disliked: new Set(E.disliked), indifferent: new Set(E.indifferent),
    wowed: new Set(E.wowed), enjoyed: new Set(E.enjoyed), blocked: new Set(E.blocked),
  };
  E.watched.clear(); E.disliked.clear(); E.indifferent.clear(); E.wowed.clear(); E.enjoyed.clear(); E.blocked.clear();
  const films = assignments.map(([m]) => m);
  films.forEach(m => E.MOVIES.push(m));
  assignments.forEach(([m, kind]) => {
    if(kind === "notfor"){ E.blocked.add(m.tmdb_id); return; }
    E.watched.add(m.tmdb_id);
    if(kind === "disliked") E.disliked.add(m.tmdb_id);
    if(kind === "soso") E.indifferent.add(m.tmdb_id);
    if(kind === "wow") E.wowed.add(m.tmdb_id);
    if(kind === "enjoyed") E.enjoyed.add(m.tmdb_id);
  });
  E.invalidateComputeCaches();
  try{ return fn(films); }
  finally{
    films.forEach(m => { const i = E.MOVIES.indexOf(m); if(i !== -1) E.MOVIES.splice(i, 1); });
    E.watched.clear(); saved.watched.forEach(id => E.watched.add(id));
    E.disliked.clear(); saved.disliked.forEach(id => E.disliked.add(id));
    E.indifferent.clear(); saved.indifferent.forEach(id => E.indifferent.add(id));
    E.wowed.clear(); saved.wowed.forEach(id => E.wowed.add(id));
    E.enjoyed.clear(); saved.enjoyed.forEach(id => E.enjoyed.add(id));
    E.blocked.clear(); saved.blocked.forEach(id => E.blocked.add(id));
    E.invalidateComputeCaches();
  }
}
// The ticket's own AC1 fixture: six verdicts, nothing else counted.
function ac1Assignments(){
  return [
    [scoredFilm(["Action","Thriller"], 80), "wow"],
    [scoredFilm(["Action","Thriller"], 70), "enjoyed"],
    [scoredFilm(["Action","Comedy"], 60), "soso"],
    [scoredFilm(["Horror"], 75), "notfor"],
    [scoredFilm(["Horror","Thriller"], 65), "disliked"],
    [scoredFilm(["Drama","Crime"], 85), "liked"],
  ];
}

test("CAS-1251 AC1: style/pairing leans and confidence from a fixture of six verdicts", () => {
  withTasteFixture(ac1Assignments(), () => {
    const T = E.tasteProfile();
    assert.equal(round4(T.overall.lean), 0.1250);
    assert.equal(round4(T.styles.Action.lean), 0.3571);
    assert.equal(round4(T.styles.Horror.lean), -0.2500);
    assert.equal(round4(T.styles.Drama.lean), 0.3500);
    assert.equal(round4(T.pairs["Action|Thriller"].lean), 0.6548);
    assert.equal(round4(T.pairs["Action|Comedy"].lean), 0.1857);
    assert.equal(round4(T.pairs["Horror|Thriller"].lean), -0.4000);
    assert.equal(round4(T.pairs["Drama|Crime"].lean), 0.5300);
    assert.equal(round4(T.styles.Action.conf), 0.4286);
    assert.equal(T.range, null);
    assert.equal(T.n, 6);
  });
});

test("CAS-1251 AC2: tasteMatch for three unverdicted films against the AC1 fixture", () => {
  withTasteFixture(ac1Assignments(), () => {
    const filmA = scoredFilm(["Action","Thriller","Crime"], 90);
    const filmB = scoredFilm(["Horror"], 50);
    const filmC = scoredFilm(["Western"], 72);
    const a = E.tasteMatch(filmA), b = E.tasteMatch(filmB), c = E.tasteMatch(filmC);
    assert.deepEqual([a.value, round4(a.conf), a.level], [71, 0.4286, 2]);
    assert.deepEqual([b.value, round4(b.conf), b.level], [40, 0.3333, 1]);
    assert.deepEqual([c.value, round4(c.conf), c.level], [55, 0.2700, 1]);
  });
});

test("CAS-1251 AC3: the learned range is the 15th-85th percentile of positively-judged scores", () => {
  const films = [60,64,70,72,80,85,90].map(s => scoredFilm(["Action"], s));
  withTasteFixture(films.map(m => [m, "enjoyed"]), () => {
    const T = E.tasteProfile();
    // T.range is built inside the engine's own vm realm — spread it into a host-realm array first, the
    // same cross-realm-identity reasoning cas1094-account-store.test.mjs's own comment already covers.
    assert.deepEqual([...T.range], [64, 85]);
  });
});

test("CAS-1251 AC3: forcing the learned range onto the AC1 fixture's leans reproduces the three Match values", () => {
  withTasteFixture(ac1Assignments(), () => {
    const T = E.tasteProfile();
    T.range = [64, 85];   // force — tasteMatch() reads back this same cached object, AC1's leans untouched
    const filmA = scoredFilm(["Action","Thriller","Crime"], 90);
    const filmB = scoredFilm(["Horror"], 50);
    const filmC = scoredFilm(["Western"], 72);
    assert.equal(E.tasteMatch(filmA).value, 66);
    assert.equal(E.tasteMatch(filmB).value, 28);
    assert.equal(E.tasteMatch(filmC).value, 61);
  });
});

test("CAS-1251 AC4: tasteMatch needs at least five counted verdicts overall", () => {
  const probe = { genres:["Action"], status:["included_streaming"] };
  const four = [0,1,2,3].map(() => scoredFilm(["Action"], 70));
  withTasteFixture(four.map(m => [m, "enjoyed"]), () => {
    assert.equal(E.tasteMatch(probe), null, "four counted verdicts must not be enough");
  });
  const five = [0,1,2,3,4].map(() => scoredFilm(["Action"], 70));
  withTasteFixture(five.map(m => [m, "enjoyed"]), () => {
    assert.notEqual(E.tasteMatch(probe), null, "five counted verdicts must be enough for a film with genres");
  });
});

test("CAS-1251 AC5: latest verdicts sort newest-first by their user_films row, with no row sorting first", () => {
  const films = [0,1,2,3].map(() => scoredFilm(["Action"], 70));
  withTasteFixture(films.map(m => [m, "enjoyed"]), () => {
    const savedRows = E.CascadeAccountStore.acctStore.user_films;
    E.CascadeAccountStore.acctStore.user_films = [
      { user_id:"u", movie_id:String(films[0].tmdb_id), status:"enjoyed", updated_at:"2026-10-01T00:00:00.000Z" },
      { user_id:"u", movie_id:String(films[1].tmdb_id), status:"enjoyed", updated_at:"2026-10-02T00:00:00.000Z" },
      { user_id:"u", movie_id:String(films[2].tmdb_id), status:"enjoyed", updated_at:"2026-10-03T00:00:00.000Z" },
      // films[3] deliberately has no row — "set a moment ago, not yet saved".
    ];
    try{
      const T = E.tasteProfile();
      // Spread T.latest into a host-realm array before mapping — same cross-realm-identity reasoning as
      // the range check above.
      const latestIds = [...T.latest].map(v => v.id);
      assert.deepEqual(latestIds, [films[3].tmdb_id, films[2].tmdb_id, films[1].tmdb_id, films[0].tmdb_id]);
      assert.equal(T.latest[0].at, null);
      assert.equal(T.latest[1].at, "2026-10-03T00:00:00.000Z");
    } finally {
      E.CascadeAccountStore.acctStore.user_films = savedRows;
    }
  });
});

test("CAS-1251 AC6: tasteProfile caches, and a new verdict invalidates it", () => {
  const five = [0,1,2,3,4].map(() => scoredFilm(["Action"], 70));
  const fresh = scoredFilm(["Drama"], 70);
  withTasteFixture(five.map(m => [m, "enjoyed"]), () => {
    E.MOVIES.push(fresh);
    try{
      const first = E.tasteProfile();
      const second = E.tasteProfile();
      assert.strictEqual(first, second, "nothing changed between the two calls — the same cached object must come back");
      const before = first.n;
      E.setOpinion(fresh.tmdb_id, "wow");
      const after = E.tasteProfile().n;
      assert.notEqual(after, before, "a new verdict on a film that had none must invalidate the cached profile");
    } finally {
      const i = E.MOVIES.indexOf(fresh); if(i !== -1) E.MOVIES.splice(i, 1);
    }
  });
});

test("CAS-1251 AC7: tasteProfile/tasteMatch never touch the account-store client", () => {
  const five = [0,1,2,3,4].map(() => scoredFilm(["Action"], 70));
  withTasteFixture(five.map(m => [m, "enjoyed"]), () => {
    const calls = [];
    const builder = {
      select(){ return builder; }, upsert(){ return builder; }, update(){ return builder; },
      delete(){ return builder; }, match(){ return builder; }, eq(){ return builder; },
      order(){ return builder; }, range(){ return builder; }, single(){ return builder; },
      then(resolve){ return Promise.resolve({ data: [], error: null, status: 200 }).then(resolve); },
    };
    const client = { from(table){ calls.push(table); return builder; } };
    const auth = E.CascadeAuth;
    const saved = { enabled: auth.enabled, client: auth.client, session: auth.session };
    auth.enabled = true; auth.client = client; auth.session = { user: { id: "cas1251-test-user" } };
    try{
      E.tasteProfile();
      five.forEach(m => E.tasteMatch(m));
      assert.equal(calls.length, 0, "tasteProfile()/tasteMatch() must never call client.from(...)");
    } finally {
      auth.enabled = saved.enabled; auth.client = saved.client; auth.session = saved.session;
    }
  });
});

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
    assert.equal(round4(T.styles.Action.lean), 0.2857);
    assert.equal(round4(T.styles.Horror.lean), -0.3333);
    assert.equal(round4(T.styles.Drama.lean), 0.2500);
    assert.equal(round4(T.pairs["Action|Thriller"].lean), 0.5833);
    assert.equal(round4(T.pairs["Action|Comedy"].lean), -0.0257);
    assert.equal(round4(T.pairs["Horror|Thriller"].lean), -0.2476);
    assert.equal(round4(T.pairs["Drama|Crime"].lean), 0.4500);
    assert.equal(round4(T.styles.Action.conf), 0.4286);
    assert.equal(T.range, null);
    assert.equal(T.n, 6);
    // CAS-1255: every judged style counts, so Thriller/Crime (never a film's first genre in this fixture)
    // get their own style rows too, and every ordered style pair appears exactly once.
    assert.equal(T.styles.Thriller.n, 3);
    assert.equal(round4(T.styles.Thriller.lean), 0.2143);
    assert.equal(T.styles.Crime.n, 1);
    assert.equal(round4(T.pairs["Thriller|Action"].lean), round4(T.pairs["Action|Thriller"].lean));
    assert.equal(Object.keys(T.pairs).length, 8);
  });
});

test("CAS-1260 AC1: You (tasteMatch) against the AC1 fixture — 80% combination films, 20% headline style", () => {
  withTasteFixture(ac1Assignments(), () => {
    const v = genres => { const t = E.tasteMatch(scoredFilm(genres, 70)); return t ? [t.value, round4(t.conf), t.films] : null; };
    // Two Action+Thriller films share two styles (overlap 2/3 each): (100 + 83) / 2 = 91.5. Headline Action
    // films (Wow, Enjoyed, So-so) average 72.3. 0.8 x 91.5 + 0.2 x 72.3 = 87.6667.
    // CAS-1265: wSum = 4/3; evidence = 50 + (87.6667-50)*(4/3)/(4/3+3) = 61.5897;
    // boost = 15*ln(3)/ln(31) = 4.7988 -> round(66.3885) = 66.
    assert.deepEqual(v(["Action","Thriller","Crime"]), [66, 0.3077, 2]);
    // One style only: every judged film carrying it is a combination film (Never 17, Disliked 17): avg = 17.
    // CAS-1265: wSum = 1.5; evidence = 50 + (17-50)*1.5/4.5 = 39; boost = 15*ln(3)/ln(31) = 4.7988 -> round(43.7988) = 44.
    assert.deepEqual(v(["Horror"]), [44, 0.3333, 2]);
    // Horror+Thriller (Disliked) is the only combination film: 17; headline Thriller films 100, 83, 17 average
    // 66.6667; avg = 0.8*17 + 0.2*66.6667 = 26.9333. CAS-1265: wSum = 1; evidence = 50 + (26.9333-50)/4 = 44.2333;
    // boost = 15*ln(2)/ln(31) = 3.0277 -> round(47.2611) = 47.
    assert.deepEqual(v(["Thriller","Horror"]), [47, 0.25, 1]);
    // One judged film is enough: avg = 34. CAS-1265: wSum = 0.5; evidence = 50 + (34-50)*0.5/3.5 = 47.7143;
    // boost = 15*ln(2)/ln(31) = 3.0277 -> round(50.742) = 51.
    assert.deepEqual(v(["Comedy"]), [51, 0.1429, 1]);
    // No judged film shares the combination: no You at all.
    assert.equal(E.tasteMatch(scoredFilm(["Western"], 70)), null);
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

test("CAS-1260 AC2: You ignores the Cascade score — the same film at 40 and at 95 gets the same You", () => {
  withTasteFixture(ac1Assignments(), () => {
    // CAS-1265: same 66 as the AC1 "Action,Thriller,Crime" case above — the Cascade score plays no part.
    assert.equal(E.tasteMatch(scoredFilm(["Action","Thriller","Crime"], 40)).value, 66);
    assert.equal(E.tasteMatch(scoredFilm(["Action","Thriller","Crime"], 95)).value, 66);
  });
});

test("CAS-1260 AC3: You needs one combination film, not a count of verdicts overall", () => {
  const probe = { tmdb_id: 90009999, genres:["Action"], status:["included_streaming"] };
  withTasteFixture([], () => { assert.equal(E.tasteMatch(probe), null, "no verdicts: no You"); });
  const one = [scoredFilm(["Action"], 70)];
  withTasteFixture(one.map(m => [m, "enjoyed"]), () => {
    const t = E.tasteMatch(probe);
    // CAS-1265: avg = 83, wSum = 1 -> evidence = 50 + (83-50)/4 = 58.25; boost = 15*ln(2)/ln(31) = 3.0277
    // -> round(61.2777) = 61.
    assert.deepEqual([t.value, round4(t.conf), t.films], [61, 0.25, 1]);
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

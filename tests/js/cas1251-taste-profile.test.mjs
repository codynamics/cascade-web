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
    // CAS-1293: the person's baseline lean across their own style combinations — the n-weighted mean of
    // pr.lean over each unordered pair once (Action|Thriller n=2, Action|Comedy n=1, Horror|Thriller n=1,
    // Crime|Drama n=1 — same lean value as Drama|Crime above, by the symmetry CAS-1255 AC3 already
    // asserts): (0.5833*2 + -0.0257*1 + -0.2476*1 + 0.4500*1) / 5 = 0.2687.
    assert.equal(round4(T.pairBaseline), 0.2687);
  });
});

test("CAS-1293: You (tasteMatch) against the AC1 fixture — Public adjusted by the candidate's judged style pairs", () => {
  withTasteFixture(ac1Assignments(), () => {
    const v = genres => { const t = E.tasteMatch(scoredFilm(genres, 70)); return t ? [t.value, round4(t.conf), t.films] : null; };
    // Only Action|Thriller (n=2, sum=2.5) among the three pairs {Action,Thriller},{Action,Crime},
    // {Thriller,Crime} was ever judged. lean=(2.5+4*0.2687)/6=0.5958; d=0.5958-0.2687=0.3271;
    // adj=20*0.3271=6.54 -> round(70+6.54)=77.
    assert.deepEqual(v(["Action","Thriller","Crime"]), [77, 0.3333, 2]);
    // A single judged style, with no judged partner, forms no pair: no adjustment at all, not "no You" —
    // You falls back to the film's own Public score.
    assert.deepEqual(v(["Horror"]), [70, 0, 0]);
    // Horror|Thriller is the only pair here (n=1, sum=-1). lean=(-1+4*0.2687)/5=0.0149;
    // d=0.0149-0.2687=-0.2537; adj=45*-0.2537=-11.42 -> round(70-11.42)=59.
    assert.deepEqual(v(["Thriller","Horror"]), [59, 0.2, 1]);
    // Comedy alone forms no pair either.
    assert.deepEqual(v(["Comedy"]), [70, 0, 0]);
    // No judged style at all: still no pair, same fallback to Public.
    assert.deepEqual(v(["Western"]), [70, 0, 0]);
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

test("CAS-1293: You tracks the Cascade score as its base, by design — same combination, different Public, clamped at the ceiling", () => {
  withTasteFixture(ac1Assignments(), () => {
    // CAS-1293 replaces CAS-1260/1265's "You ignores the Cascade score" — You v3 is the Public score
    // itself, adjusted: the Action|Thriller pair's adj here is a fixed +6.54 (see the AC1 test above), so
    // a lower Public simply shifts the result down, and a high enough Public clamps at 99.
    assert.equal(E.tasteMatch(scoredFilm(["Action","Thriller","Crime"], 40)).value, 47);
    assert.equal(E.tasteMatch(scoredFilm(["Action","Thriller","Crime"], 95)).value, 99);
  });
});

test("CAS-1293: You needs both a Public score and a judged style pair, not just a count of verdicts", () => {
  const probe = { tmdb_id: 90009999, genres:["Action"], status:["included_streaming"] };
  withTasteFixture([], () => { assert.equal(E.tasteMatch(probe), null, "no verdicts logged at all: no You"); });
  const one = [scoredFilm(["Action"], 70)];
  withTasteFixture(one.map(m => [m, "enjoyed"]), () => {
    // The probe itself carries no wm rating, so cascadeScore(probe) is -1 — no Public score, so still no
    // You, even though the person has since logged a verdict on the same (single) style.
    assert.equal(E.tasteMatch(probe), null, "no Public score on the probe itself: still no You");
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

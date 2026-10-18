// CAS-1264: the mood sheet's Order row gains a live "You" segment (sortMoviesBy key "you"), and the
// existing "Cascade score" segment is relabelled "Public" (the key itself, "cascade", is unchanged). This
// covers the comparator and PRE_RELEASE_SORTS membership (AC1) and the order:"you" -> filt.sort
// translation, signed-in vs signed-out (AC2). The mood sheet's own Order row and the "best 10" ranking
// (AC3/AC4) are e2e, in tests/e2e/smoke.spec.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// ---- fixture building, same approach as tests/js/match-honest.test.mjs -----------------------------
function ratingForScore(target){
  let lo = 0, hi = 100;
  for(let i = 0; i < 60; i++){
    const mid = (lo + hi) / 2;
    if(Math.round(E.wmScaled(mid)) < target) lo = mid; else hi = mid;
  }
  let v = hi;
  for(let i = 0; i < 2000 && Math.round(E.wmScaled((v/10)*10)) !== target; i++) v += 0.01;
  return v / 10;
}
// Comfortably clear of every real catalogue tmdb_id (max ~1.77M), same reasoning as match-honest's own fixture ids.
let _nextFixtureId = 90100001;
function scoredFilm(genres, score){
  const id = _nextFixtureId++;
  const m = { tmdb_id:id, title:`You-sort fixture ${id}`, genres, status:["included_streaming"],
    wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true };
  const got = E.cascadeScore(m);
  if(got !== score) throw new Error(`test setup: fixture ${id} cascadeScore computed ${got}, expected ${score}`);
  return m;
}
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

test("CAS-1264 AC1: sortMoviesBy(\"you\") ranks higher You first, no-You last, ties by cascade score", () => {
  // CAS-1293: You v3 is Public adjusted by the Action/Comedy and Drama/Crime pair records below —
  // c80 (Action/Comedy, Public 70) comes out above c40 (Drama/Crime, Public 65); a film with no judged
  // style pair at all (cNull, Documentary) still gets a You (its own unadjusted Public) now that You is
  // Public-based, so "no-You" below means no PUBLIC score, not no pair match.
  const j1 = scoredFilm(["Action","Comedy"], 80);
  const j2 = scoredFilm(["Action","Horror"], 80);
  const j3 = scoredFilm(["Action","Thriller"], 80);
  const j4 = scoredFilm(["Drama","Crime"], 80);
  const j5 = scoredFilm(["Drama","Western"], 80);

  withTasteFixture([
    [j1, "enjoyed"], [j2, "enjoyed"], [j3, "soso"],
    [j4, "soso"], [j5, "liked"],
  ], () => {
    const c80 = scoredFilm(["Action","Comedy"], 70);
    const c40 = scoredFilm(["Drama","Crime"], 65);
    const cNull = { tmdb_id: 90100999, genres: ["Documentary"], status: ["included_streaming"] };
    assert.equal(E.tasteMatch(c80).value, 73);
    assert.equal(E.tasteMatch(c40).value, 59);
    assert.equal(E.tasteMatch(cNull), null, "no Public score at all: still no You");

    const order = [cNull, c40, c80].sort((a, b) => E.sortMoviesBy(a, b, "you"));
    assert.deepEqual(order.map(m => m.tmdb_id), [c80.tmdb_id, c40.tmdb_id, cNull.tmdb_id]);

    // Two films sharing the same combination but clamped to the same ceiling tie on You; the tie then
    // falls back to cascadeScore descending.
    const tieHi = scoredFilm(["Action","Comedy"], 97);
    const tieLo = scoredFilm(["Action","Comedy"], 96);
    assert.equal(E.tasteMatch(tieHi).value, E.tasteMatch(tieLo).value);
    assert.equal(E.tasteMatch(tieHi).value, 99);
    const tieOrder = [tieLo, tieHi].sort((a, b) => E.sortMoviesBy(a, b, "you"));
    assert.deepEqual(tieOrder.map(m => m.tmdb_id), [tieHi.tmdb_id, tieLo.tmdb_id]);
  });
});

test("CAS-1264 AC1: PRE_RELEASE_SORTS includes you", () => {
  assert.ok(E.PRE_RELEASE_SORTS.has("you"));
});

// setSignedIn mirrors tests/js/invariants.test.mjs's own helper: flip the real CascadeAuth fields
// accountActive() reads (client() && uid()), rather than a stand-in predicate, so this exercises the same
// check applyMoodToState's own signed-in branch runs.
function setSignedIn(signedIn){
  const auth = E.CascadeAuth;
  auth.enabled = signedIn;
  auth.client = signedIn ? {} : null;
  auth.session = signedIn ? { user: { id: "cas1264-test-user" } } : null;
}

// CAS-1296: order is no longer a field the mood sheet edits — it's derived (moodOrder) from Show top
// (topYou/topPublic). A mood with either one set derives "you" (filt.sort="you" signed in, "cascade" out,
// same mapping as before); a mood with both Off derives "release" (filt.sort="cinema"), the behaviour the
// Releases mood needs. A stored `order` field (pre-CAS-1296) is ignored either way.
test("CAS-1296: moodOrder derives \"you\" from topYou/topPublic, ignoring any stored order field", () => {
  assert.equal(E.moodOrder({ ...E.moodDefaultFieldsNow(), topYou: 20, topPublic: null }), "you");
  assert.equal(E.moodOrder({ ...E.moodDefaultFieldsNow(), topYou: null, topPublic: 10 }), "you");
  assert.equal(E.moodOrder({ ...E.moodDefaultFieldsNow(), topYou: null, topPublic: null, order: "you" }), "release");
});

test("CAS-1296/CAS-1264: applyMoodToState maps the derived \"you\" order to filt.sort=\"you\" signed in, \"cascade\" signed out", () => {
  try{
    setSignedIn(true);
    E.applyMoodToState({ ...E.moodDefaultFieldsNow(), topYou: 20, topPublic: null });
    assert.equal(E.filt.sort, "you");

    setSignedIn(false);
    E.applyMoodToState({ ...E.moodDefaultFieldsNow(), topYou: 20, topPublic: null });
    assert.equal(E.filt.sort, "cascade");
  } finally {
    setSignedIn(false);
  }
});

test("CAS-1296 AC2: a mood with both Show top caps Off derives \"release\" (filt.sort=\"cinema\")", () => {
  E.applyMoodToState({ ...E.moodDefaultFieldsNow(), topYou: null, topPublic: null });
  assert.equal(E.filt.sort, "cinema");
});

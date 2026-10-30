// CAS-1337: the v2 "one agent" engine — a single score plus admission test that replaces the whole old
// agent model for any account whose agent criteria carries v:2. Every test here drives the real shipped
// engine (tests/js/engine.mjs's loadEngine(), reading the BUILT index.html) directly against a fixture
// criteria object, never a re-derivation of matchesCriteria's/oneScore's own rules. Fixture-building
// (ratingForScore/scoredFilm/withTasteFixture) mirrors tests/js/cas1293-you-score.test.mjs's own helpers.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

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
let _nextFixtureId = 90500001;
function scoredFilm(genres, score){
  const id = _nextFixtureId++;
  const m = { tmdb_id:id, title:`CAS-1337 fixture ${id}`, genres, status:["included_streaming"],
    wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true,
    availability_confidence:"confirmed",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}] };
  const got = E.cascadeScore(m);
  if(got !== score) throw new Error(`test setup: fixture ${id} cascadeScore computed ${got}, expected ${score}`);
  return m;
}
// Same shape as cas1293-you-score.test.mjs's own helper: seeds the six verdict sets directly (never
// through setOpinion's wire path), clearing and restoring them around the test so nothing leaks.
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
function withCascades(agents, fn){
  const saved = [...E.cascades];
  E.cascades.length = 0;
  agents.forEach(a => E.cascades.push(a));
  try{ return fn(); }
  finally{ E.cascades.length = 0; saved.forEach(a => E.cascades.push(a)); }
}
function oneAgent(overrides){
  return { id:"cas1337-fixture", name:"My agent", v:2, styles:{}, combo:{}, seenAdj:{}, dismissed:[], ...overrides };
}

// ---- AC1: oneScore's main-keyed learned adjustment gates admission at the bar ----------------------------

test("CAS-1337 AC1: a learned Science Fiction|Thriller adjustment of -7 moves the bar by exactly that much", () => {
  // Two "disliked" verdicts (weight -1 each) on a Sci-fi/Thriller film is the exact fixture that makes
  // today's You v3 arithmetic (TASTE_K=4, asymmetric 45x-down scaling), applied to this one main-keyed
  // pair against its own baseline, round to -7 — worked by hand against engine.mjs's own exported youScore.
  const evidence = [scoredFilm(["Science Fiction","Thriller"], 50), scoredFilm(["Science Fiction","Thriller"], 50)];
  withTasteFixture(evidence.map(m => [m, "disliked"]), () => {
    const c = oneAgent({ styles: { "Science Fiction": {bar:80, al:{cinema:false,rent:false,stream:false}} } });
    const admit = scoredFilm(["Science Fiction","Thriller"], 87);
    const reject = scoredFilm(["Science Fiction","Thriller"], 86);
    assert.equal(E.oneScore(admit, c), 80, "Public 87 - 7 should land exactly on the bar");
    assert.equal(E.matchesCriteria(admit, c), true);
    assert.equal(E.oneScore(reject, c), 79);
    assert.equal(E.matchesCriteria(reject, c), false);
  });
});

test("CAS-1337 AC1: without verdicts, a film exactly on the bar is admitted", () => {
  const c = oneAgent({ styles: { "Science Fiction": {bar:80, al:{cinema:false,rent:false,stream:false}} } });
  const film = scoredFilm(["Science Fiction","Drama"], 80);
  assert.equal(E.oneScore(film, c), 80);
  assert.equal(E.matchesCriteria(film, c), true);
});

// ---- AC2: a "never" combination excludes outright, ahead of the score -------------------------------------

test("CAS-1337 AC2: combo \"never\" rejects regardless of score", () => {
  const c = oneAgent({
    styles: { "Science Fiction": {bar:50, al:{cinema:false,rent:false,stream:false}} },
    combo: { "Science Fiction|Comedy": "never" },
  });
  const film = scoredFilm(["Science Fiction","Comedy"], 99);
  assert.equal(E.matchesCriteria(film, c), false);
});

// ---- AC3: a numeric override replaces the learned figure entirely, for a film with only that combo --------

test("CAS-1337 AC3: a numeric override on a film's only combo gives that override's adjustment exactly", () => {
  const evidence = [scoredFilm(["Action","Horror"], 50), scoredFilm(["Action","Horror"], 50)];
  withTasteFixture(evidence.map(m => [m, "disliked"]), () => {
    const learnedC = oneAgent({ styles: { "Action": {bar:1, al:{cinema:false,rent:false,stream:false}} } });
    const probe = scoredFilm(["Action","Horror"], 60);
    const learned = E.oneScoreParts(probe, learnedC).parts.find(p => p.other === "Horror");
    assert.ok(learned && !learned.overridden && learned.points < 0, "sanity check: there is a real negative learned figure to override");
    const overriddenC = oneAgent({
      styles: { "Action": {bar:1, al:{cinema:false,rent:false,stream:false}} },
      combo: { "Action|Horror": 10 },
    });
    const film = scoredFilm(["Action","Horror"], 60);
    const parts = E.oneScoreParts(film, overriddenC);
    assert.equal(parts.adj, 10);
    assert.equal(parts.value, 70);
    assert.equal(E.oneScore(film, overriddenC), 70);
  });
});

// ---- AC4: a verdict only updates the pairs keyed off the film's MAIN style ---------------------------------

test("CAS-1337 AC4: a verdict on [Action, Science Fiction, Adventure] updates Action|Science Fiction and Action|Adventure, not Science Fiction|Adventure", () => {
  const verdictFilm = scoredFilm(["Action","Science Fiction","Adventure"], 50);
  withTasteFixture([[verdictFilm, "wow"]], () => {
    const c = oneAgent();
    const actionSci = E.oneScoreParts(scoredFilm(["Action","Science Fiction"], 60), c);
    const actionAdv = E.oneScoreParts(scoredFilm(["Action","Adventure"], 60), c);
    const sciAdv = E.oneScoreParts(scoredFilm(["Science Fiction","Adventure"], 60), c);
    assert.equal(actionSci.parts.find(p => p.other === "Science Fiction").n, 1);
    assert.equal(actionAdv.parts.find(p => p.other === "Adventure").n, 1);
    assert.equal(sciAdv.parts.find(p => p.other === "Adventure").n, 0);
  });
});

// ---- AC6: barAdvice's raise/lower suggestion, and the dismissed override -----------------------------------

test("CAS-1337 AC6: barAdvice raises the bar once the evidence clears both thresholds, and dismissing silences it", () => {
  const style = "Horror";
  // Every fixture film shares the SAME (Horror, Drama) combo, so oneScore shifts every one of them by the
  // same learned adjustment (here, +1 once rounded) — the raw Public scores below are chosen so the real,
  // POST-adjustment oneScore (what barAdvice's evidence is actually scored by) lands at 65/66/67/78/79 and
  // 82 — verified directly against the real engine before being hard-coded here, the same way
  // tests/js/cas1293-you-score.test.mjs's ratingForScore search is used to hit an exact cascadeScore.
  const low = [
    [scoredFilm([style,"Drama"], 64), "disliked"],
    [scoredFilm([style,"Drama"], 65), "disliked"],
    [scoredFilm([style,"Drama"], 66), "liked"],
    [scoredFilm([style,"Drama"], 77), "liked"],
    [scoredFilm([style,"Drama"], 78), "disliked"],
  ];
  const high = Array.from({length:7}, () => [scoredFilm([style,"Drama"], 81), "liked"]);
  withTasteFixture([...low, ...high], () => {
    withCascades([oneAgent({ styles: { [style]: {bar:65, al:{cinema:false,rent:false,stream:false}} } })], () => {
      assert.deepEqual(
        { ...E.barAdvice(style), lo:undefined, hi:undefined },
        { dir:"up", from:65, to:80, lo:undefined, hi:undefined },
      );
    });
    withCascades([oneAgent({
      styles: { [style]: {bar:65, al:{cinema:false,rent:false,stream:false}} },
      dismissed: ["bar:"+style],
    })], () => {
      assert.equal(E.barAdvice(style), null);
    });
  });
});

// CAS-1293: You v3 — the film's Public score (cascadeScore) adjusted by the person's track record on the
// film's style COMBINATIONS, replacing CAS-1260/1265's formula C and CAS-1277's in-list Watch rank.
// youScore() is the pure arithmetic (AC1, the ticket's own four worked cases); tasteMatch() wraps it with
// the person's real pair stats and cross-pair baseline (tasteProfile()'s new T.pairBaseline).
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
let _nextFixtureId = 90400001;
function scoredFilm(genres, score){
  const id = _nextFixtureId++;
  const m = { tmdb_id:id, title:`You-v3 fixture ${id}`, genres, status:["included_streaming"],
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

test("CAS-1293 AC1: youScore against the ticket's own four worked cases", () => {
  assert.equal(E.youScore({pub:86, pairs:[{sum:-2.5,n:5},{sum:1,n:2}], b:0.6}).value, 66);
  assert.equal(E.youScore({pub:72, pairs:[{sum:8,n:8}], b:0.6}).value, 77);
  const noPairs = E.youScore({pub:80, pairs:[], b:0.6});
  assert.equal(noPairs.value, 80);
  assert.equal(noPairs.adj, 0);
  assert.equal(E.youScore({pub:97, pairs:[{sum:8,n:8}], b:0.6}).value, 99);
});

// AC2: against a strong positive baseline (20x Wow on Action/Comedy), a combination rated So-so every
// time (5x, Drama/Crime) scores well over 20 below its own Public — the person's baseline pulls the
// smoothed lean up, but not enough to erase 5 straight So-sos pulling it the other way. The baseline's
// own dominant combination, by contrast, scores above Public.
test("CAS-1293 AC2: a consistently So-so combination scores well below Public; a consistently Wow one scores above it", () => {
  const assignments = [];
  for(let i = 0; i < 20; i++) assignments.push([scoredFilm(["Action","Comedy"], 70), "wow"]);
  for(let i = 0; i < 5; i++) assignments.push([scoredFilm(["Drama","Crime"], 70), "soso"]);
  withTasteFixture(assignments, () => {
    const soso = E.tasteMatch(scoredFilm(["Drama","Crime"], 70));
    assert.equal(soso.value, 30);
    assert.ok(70 - soso.value >= 20, "So-so combination must score at least 20 below its Public");
    const wow = E.tasteMatch(scoredFilm(["Action","Comedy"], 70));
    assert.equal(wow.value, 77);
    assert.ok(wow.value > 70, "the Wow combination must score above its Public");
  });
});

// AC3: the Watch badge is the plain tasteMatch(m).value everywhere — no rank, and the CAS-1277 machinery
// is gone entirely (not just unused).
test("CAS-1293 AC3: matchBadgeHTML shows the absolute tasteMatch value, and the CAS-1277 rank is gone", () => {
  assert.equal(E.rankYouItems, undefined);
  assert.equal(E.watchYouRankMap, undefined);
  assert.equal(E.watchYouRanks, undefined);
  assert.equal(E.setWatchYouRanks, undefined);
  const assignments = [];
  for(let i = 0; i < 6; i++) assignments.push([scoredFilm(["Action","Thriller"], 80), "wow"]);
  withTasteFixture(assignments, () => {
    const m = scoredFilm(["Action","Thriller"], 80);
    const t = E.tasteMatch(m);
    const badge = E.matchBadgeHTML(m);
    assert.ok(badge.includes(`<b>${t.value}</b><small>You</small>`));
    assert.ok(badge.includes(`You ${t.value} — Public 80, adjusted`));
  });
});

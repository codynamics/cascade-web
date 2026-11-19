// CAS-1479: Taste engine — scoring uses APPLIED values; Pixel's learned values become per-genre recommendations.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function ratingForScore(target){
  let lo = 0, hi = 100;
  for(let i = 0; i < 60; i++){ const mid = (lo + hi) / 2; if(Math.round(E.wmScaled(mid)) < target) lo = mid; else hi = mid; }
  let v = hi;
  for(let i = 0; i < 2000 && Math.round(E.wmScaled((v/10)*10)) !== target; i++) v += 0.01;
  return v / 10;
}
let _id = 91479001;
function scoredFilm(genres, score){
  const id = _id++;
  const m = { tmdb_id:id, title:`CAS-1479 fixture ${id}`, genres, status:["included_streaming"],
    wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true, availability_confidence:"confirmed",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}] };
  if(E.cascadeScore(m) !== score) throw new Error("fixture setup: score mismatch");
  return m;
}
const SETS = ["watched","disliked","indifferent","wowed","enjoyed","blocked"];
function withVerdicts(assignments, fn){
  const saved = {}; SETS.forEach(k => { saved[k] = new Set(E[k]); E[k].clear(); });
  const films = assignments.map(([m]) => m);
  films.forEach(m => E.MOVIES.push(m));
  assignments.forEach(([m, kind]) => {
    E.watched.add(m.tmdb_id);
    if(kind === "disliked") E.disliked.add(m.tmdb_id);
    if(kind === "wow") E.wowed.add(m.tmdb_id);
  });
  E.invalidateComputeCaches();
  try{ return fn(films); }
  finally{
    films.forEach(m => { const i = E.MOVIES.indexOf(m); if(i !== -1) E.MOVIES.splice(i, 1); });
    SETS.forEach(k => { E[k].clear(); saved[k].forEach(id => E[k].add(id)); });
    E.invalidateComputeCaches();
  }
}
function withAgent(c, fn){
  const saved = [...E.cascades]; E.cascades.length = 0; E.cascades.push(c);
  try{ return fn(); } finally { E.cascades.length = 0; saved.forEach(a => E.cascades.push(a)); }
}
const agent = () => ({ id:"cas1479", name:"A", v:2, combo:{}, seenAdj:{}, dismissed:[],
  styles:{ "Science Fiction": {bar:60, al:{cinema:false,rent:false,stream:false}} } });
const dislikes = n => Array.from({length:n}, () => [scoredFilm(["Science Fiction","Thriller"], 50), "disliked"]);

test("CAS-1479 AC1: the day-one seed leaves every film's score unchanged", () => {
  withVerdicts(dislikes(2), () => {
    const probes = [60, 70, 80, 90].map(s => scoredFilm(["Science Fiction","Thriller","Drama"], s))
      .concat([scoredFilm(["Science Fiction","Thriller"], 87)]);
    probes.forEach(m => E.MOVIES.push(m));
    const c = agent();
    withAgent(c, () => {
      const before = probes.map(m => E.oneScore(m, c));
      assert.equal(E.tasteSeedApplied(c), true);
      assert.equal(c.appliedSeeded, true);
      assert.equal(c.applied["Science Fiction|Thriller"], E.oneComboAdj("Science Fiction|Thriller"));
      assert.deepEqual(probes.map(m => E.oneScore(m, c)), before);
      assert.equal(E.tasteSeedApplied(c), false, "seeding is once only");
      assert.equal(E.tasteRecs().length, 0, "nothing pending right after the seed");
    });
    probes.forEach(m => E.MOVIES.splice(E.MOVIES.indexOf(m), 1));
  });
});

test("CAS-1479 AC2/3/4: a new verdict only creates a recommendation; apply moves scores; skip clears without moving", () => {
  const first = dislikes(2);
  withVerdicts(first, () => {
    const c = agent();
    withAgent(c, () => {
      E.tasteSeedApplied(c);
      const probe = scoredFilm(["Science Fiction","Thriller"], 87);
      E.MOVIES.push(probe);
      const s0 = E.oneScore(probe, c);
      // two more dislikes: learned moves, applied does not
      const more = dislikes(4).map(([m,k]) => { E.MOVIES.push(m); E.watched.add(m.tmdb_id); E.disliked.add(m.tmdb_id); return m; });
      E.invalidateComputeCaches();
      assert.equal(E.oneScore(probe, c), s0, "a new verdict changes no score by itself");
      const recs = E.tasteRecs();
      assert.equal(recs.length, 1);
      assert.equal(recs[0].style, "Science Fiction");
      assert.equal(recs[0].keys[0].key, "Science Fiction|Thriller");
      assert.equal(recs[0].keys[0].from, c.applied["Science Fiction|Thriller"]);
      assert.ok(Math.abs(recs[0].keys[0].to - recs[0].keys[0].from) >= 2);
      // skip: clears, no score change, stays cleared
      E.tasteSkip("Science Fiction");
      assert.equal(E.tasteRecs().length, 0);
      assert.equal(E.oneScore(probe, c), s0);
      // a further move of >= 2 from the skipped value brings it back
      const extra = dislikes(6).map(([m]) => { E.MOVIES.push(m); E.watched.add(m.tmdb_id); E.wowed.add(m.tmdb_id); return m; });
      E.invalidateComputeCaches();
      assert.equal(E.tasteRecs().length, 1, "skipped value moved >= 2 -> pending again");
      E.tasteApply("Science Fiction");
      assert.equal(E.tasteRecs().length, 0);
      assert.equal(c.applied["Science Fiction|Thriller"], E.oneComboAdj("Science Fiction|Thriller"));
      assert.notEqual(E.oneScore(probe, c), s0, "apply moves that genre's film scores");
      [...more, ...extra, probe].forEach(m => E.MOVIES.splice(E.MOVIES.indexOf(m), 1));
    });
  });
});

test("CAS-1479 AC4: nav badge equals tasteRecs().length", () => {
  withVerdicts(dislikes(2), () => {
    const c = agent();
    withAgent(c, () => {
      E.tasteSeedApplied(c);
      assert.equal(E.tasteRecs().length, 0);
      dislikes(4).forEach(([m]) => { E.MOVIES.push(m); E.watched.add(m.tmdb_id); E.disliked.add(m.tmdb_id); });
      E.invalidateComputeCaches();
      assert.equal(E.tasteRecs().length, 1);
      assert.equal(E.oneAppliedPoints(c, "Science Fiction|Thriller"), c.applied["Science Fiction|Thriller"]);
    });
  });
});

test("CAS-1479: overrides and never are untouched; unseeded criteria keep learned behaviour", () => {
  withVerdicts(dislikes(2), () => {
    const c = agent(); c.combo = {"Science Fiction|Thriller": -3};
    const m = scoredFilm(["Science Fiction","Thriller"], 87);
    const unseeded = E.oneScore(m, agent());
    withAgent(c, () => { E.tasteSeedApplied(c); assert.equal(E.tasteRecs().length, 0, "overridden combo is never pending"); });
    assert.equal(E.oneScoreParts(m, c).parts[0].points, -3);
    assert.ok(unseeded <= 80);
  });
});

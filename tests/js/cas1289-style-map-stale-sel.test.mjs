// CAS-1289: renderStyleMapSection() used to assume a non-null tasteSelPrimary named a real style or pair in
// THIS profile. The monitor's admit_shim drives one page across several accounts, so a selection left over
// from a previous account's profile could name a style/pair this profile doesn't hold, crashing on
// tasteDetailHTML's data.n read. The fix falls back to this profile's own best cell (or no selection, for
// an empty profile) whenever the current selection doesn't resolve.
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
let _nextFixtureId = 90200001;
function scoredFilm(genres, score){
  const id = _nextFixtureId++;
  const m = { tmdb_id:id, title:`CAS-1289 fixture ${id}`, genres, status:["included_streaming"],
    wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true };
  E.cascadeScore(m);
  return m;
}
function withTasteFixture(assignments, fn){
  const saved = { watched: new Set(E.watched), enjoyed: new Set(E.enjoyed) };
  E.watched.clear(); E.enjoyed.clear();
  const films = assignments.map(([m]) => m);
  films.forEach(m => E.MOVIES.push(m));
  assignments.forEach(([m]) => { E.watched.add(m.tmdb_id); E.enjoyed.add(m.tmdb_id); });
  E.invalidateComputeCaches();
  try{ return fn(); }
  finally{
    films.forEach(m => { const i = E.MOVIES.indexOf(m); if(i !== -1) E.MOVIES.splice(i, 1); });
    E.watched.clear(); saved.watched.forEach(id => E.watched.add(id));
    E.enjoyed.clear(); saved.enjoyed.forEach(id => E.enjoyed.add(id));
    E.invalidateComputeCaches();
  }
}

test("CAS-1289 AC1: a selection naming a style/pair this profile doesn't hold falls back to the profile's own best", () => {
  withTasteFixture([[scoredFilm(["Action"], 80)]], () => {
    E.setTasteSel("Western", "Music");
    const T = E.tasteProfile();
    let html;
    assert.doesNotThrow(() => { html = E.renderStyleMapSection(T); });
    assert.equal(E.tasteSelPrimary, "Action");
    assert.equal(E.tasteSelOther, null);
    assert.ok(html.includes("Action (all)"));
  });
});

test("CAS-1289 AC2: an empty profile (no best cell) renders without throwing", () => {
  withTasteFixture([], () => {
    E.setTasteSel("Western", "Music");
    const T = E.tasteProfile();
    assert.equal(T.n, 0);
    let html;
    assert.doesNotThrow(() => { html = E.renderStyleMapSection(T); });
    assert.equal(E.tasteSelPrimary, null);
    assert.equal(E.tasteSelOther, null);
    assert.ok(html.includes("Style map"));
  });
});

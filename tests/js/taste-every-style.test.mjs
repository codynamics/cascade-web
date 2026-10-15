// CAS-1255: a verdict counts toward EVERY style its film has, not just the first. tasteStyleMapData() lists
// every judged style as a row (no cap), tasteMatch() draws on all of a film's styles, and matchWhyHTML()/
// creditsHTML() surface which styles a Match number actually came from.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const E = loadEngine();

// ---- fixture building, same approach as tests/js/cas1251-taste-profile.test.mjs -----------------------
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
let _nextFixtureId = 90100001;
function scoredFilm(genres, score){
  const id = _nextFixtureId++;
  const m = { tmdb_id:id, title:`Every-style fixture ${id}`, genres, status:["included_streaming"],
    wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true };
  const got = E.cascadeScore(m);
  if(got !== score) throw new Error(`test setup: fixture ${id} cascadeScore computed ${got}, expected ${score}`);
  return m;
}
const round4 = v => Math.round(v*10000)/10000;
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
// CAS-667/858: flip window.CascadeAuth's real fields, the same way invariants.test.mjs's own setSignedIn does,
// so creditsHTML()'s accountActive() gate runs through the exact same check the shipped code runs.
function setSignedIn(signedIn){
  const auth = E.CascadeAuth;
  auth.enabled = signedIn;
  auth.client = signedIn ? {} : null;
  auth.session = signedIn ? { user: { id: "cas1255-test-user" } } : null;
  E.localStorage.setItem("cascade_had_account", signedIn ? "1" : "0");
}
// The ticket's own AC3 fixture: every film cascadeScore 80, nothing else counted.
function ac3Assignments(){
  const a = [];
  for(let i = 0; i < 6; i++) a.push([scoredFilm(["Action","Thriller"], 80), "enjoyed"]);
  for(let i = 0; i < 4; i++) a.push([scoredFilm(["Drama","Crime","History"], 80), "enjoyed"]);
  for(let i = 0; i < 2; i++) a.push([scoredFilm(["Comedy","Family","Animation","Adventure"], 80), "disliked"]);
  a.push([scoredFilm(["Western"], 80), "enjoyed"]);
  return a;
}

test("CAS-1255 AC3: every judged style gets its own row and pairing, no cap", () => {
  withTasteFixture(ac3Assignments(), () => {
    const T = E.tasteProfile();
    assert.equal(T.n, 13);
    assert.deepEqual([...T.range], [80, 80]);

    const styleCases = {
      Action: [6, 0.6000], Thriller: [6, 0.6000], Drama: [4, 0.5000], Crime: [4, 0.5000],
      History: [4, 0.5000], Comedy: [2, -0.3333], Family: [2, -0.3333], Animation: [2, -0.3333],
      Adventure: [2, -0.3333], Western: [1, 0.2000],
    };
    Object.entries(styleCases).forEach(([style, [n, lean]]) => {
      assert.equal(T.styles[style].n, n, style);
      assert.equal(round4(T.styles[style].lean), lean, style);
    });

    assert.equal(Object.keys(T.pairs).length, 20);
    assert.equal(round4(T.pairs["Action|Thriller"].lean), 0.8400);
    assert.equal(T.pairs["Action|Thriller"].n, 6);
    assert.equal(round4(T.pairs["Thriller|Action"].lean), 0.8400);
    assert.equal(T.pairs["Thriller|Action"].n, 6);
    assert.equal(round4(T.pairs["Crime|Drama"].lean), 0.7500);
    assert.equal(T.pairs["Crime|Drama"].n, 4);
    assert.equal(round4(T.pairs["Drama|Crime"].lean), 0.7500);
    assert.equal(T.pairs["Drama|Crime"].n, 4);
    assert.equal(round4(T.pairs["Comedy|Family"].lean), -0.5556);
    assert.equal(T.pairs["Action|Crime"], undefined);

    // The style map lists every judged style down the side AND across the top, both A to Z, so every
    // pairing has a square. `top` keeps the most-judged-first order for the small grid on the Agents card.
    const { rows, cols, top, best } = E.tasteStyleMapData(T);
    assert.deepEqual([...rows], [
      "Action", "Adventure", "Animation", "Comedy", "Crime", "Drama", "Family", "History", "Thriller", "Western",
    ]);
    assert.deepEqual([...cols], [...rows]);
    assert.deepEqual([...top], [
      "Action", "Thriller", "Crime", "Drama", "History", "Adventure", "Animation", "Comedy", "Family", "Western",
    ]);
    assert.deepEqual({ primary: best.primary, other: best.other, n: best.n }, { primary: "Action", other: "Thriller", n: 6 });
  });
});

test("CAS-1260 AC6: You for unjudged films against the every-style fixture", () => {
  withTasteFixture(ac3Assignments(), () => {
    // CAS-1265: value = round(evidence + boost), evidence = 50 + (avg-50)*wSum/(wSum+3), boost =
    // 15*min(1, ln(1+films)/ln(31)). avg = 17 or 83 in every case here (combo === main, as before).
    const cases = [
      // avg=17, wSum=2 -> evidence=50+(17-50)*2/5=36.8; boost=15*ln(3)/ln(31)=4.7988 -> 42
      [["Animation","Family","Comedy","Adventure"], [42, 0.4, 2]],
      // avg=83, wSum=1 -> evidence=50+(83-50)/4=58.25; boost=15*ln(2)/ln(31)=3.0277 -> 61
      [["Western"], [61, 0.25, 1]],
      // avg=83, wSum=6 -> evidence=50+(83-50)*6/9=72; boost=15*ln(7)/ln(31)=8.4999 -> 80
      [["Action","Thriller"], [80, 0.6667, 6]],
      // avg=83, wSum=4 -> evidence=50+(83-50)*4/7=68.8571; boost=15*ln(5)/ln(31)=7.0302 -> 76
      [["Drama","Crime","History"], [76, 0.5714, 4]],
      // avg=83, wSum=4 (6 films @ overlap 2/3) -> same evidence=68.8571; boost=15*ln(7)/ln(31)=8.4999 (films=6) -> 77
      [["Thriller","Comedy","Action"], [77, 0.5714, 6]],
    ];
    cases.forEach(([genres, expected]) => {
      const t = E.tasteMatch(scoredFilm(genres, 80));
      assert.deepEqual([t.value, round4(t.conf), t.films], expected, genres.join(", "));
    });
    // Sharing only one style with every judged film is not a combination: no You.
    assert.equal(E.tasteMatch(scoredFilm(["Crime","Thriller","Horror"], 80)), null);
    assert.equal(E.tasteMatch(scoredFilm(["Action","Crime"], 80)), null);
    assert.equal(E.tasteMatch(scoredFilm(["Music","Documentary"], 80)), null);
  });
});

test("CAS-1260 AC7: the open card has no Match row, signed in or out", () => {
  withTasteFixture(ac3Assignments(), () => {
    const m = scoredFilm(["Drama","Crime","History"], 80);
    m.director = "A Director";
    try{
      setSignedIn(true);
      const html = E.creditsHTML(m, true);
      assert.ok(!html.includes('<span class="clbl">Match</span>'));
      assert.ok(html.includes('<span class="clbl">Director</span>'));
    } finally {
      setSignedIn(false);
    }
  });
});

test("CAS-1255 AC5: the built index.html carries the new style-map note, not the old one", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const needle = "Styles run A to Z, down the side and across the top.";
  assert.equal(html.split(needle).length - 1, 1, `${needle} must appear exactly once`);
  assert.ok(!html.includes("Down the side is a film's first style"));
  assert.ok(!html.includes("Each row is a style, counting every film"));
  // The grid scrolls sideways with the style names held in place.
  assert.equal(html.split(".tscroll{overflow-x:auto;").length - 1, 1);
  assert.equal(html.split('<div class="tscroll"><div class="tgrid" style="grid-template-columns:92px repeat(').length - 1, 1);
});

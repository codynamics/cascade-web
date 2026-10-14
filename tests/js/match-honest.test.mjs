// CAS-1254: Match must not claim certainty it doesn't have — a style with no verdicts reads neutral, not
// the person's overall average, and certainty comes only from the film's own first style, no floor from
// the total verdict count. Three wider colour/bar steps (qhero.c1/c2/c3) so they read apart on the phone.
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
// Comfortably clear of every real catalogue tmdb_id (max ~1.77M) — a collision with a real film would
// silently swap one of this fixture's assignments for the real film's genres, as 950028 did once.
let _nextFixtureId = 90000001;
function scoredFilm(genres, score){
  const id = _nextFixtureId++;
  const m = { tmdb_id:id, title:`Match-honest fixture ${id}`, genres, status:["included_streaming"],
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
// The ticket's own AC2 fixture: every film cascadeScore 80, nothing else counted.
function ac2Assignments(){
  const a = [];
  for(let i = 0; i < 40; i++) a.push([scoredFilm(["Action"], 80), "enjoyed"]);
  for(let i = 0; i < 2; i++) a.push([scoredFilm(["Animation"], 80), "disliked"]);
  for(let i = 0; i < 3; i++) a.push([scoredFilm(["War"], 80), "enjoyed"]);
  for(let i = 0; i < 7; i++) a.push([scoredFilm(["Horror"], 80), "enjoyed"]);
  for(let i = 0; i < 8; i++) a.push([scoredFilm(["Drama"], 80), "enjoyed"]);
  return a;
}

test("CAS-1254 AC2: tasteProfile and tasteMatch stay honest against the 60-verdict fixture", () => {
  withTasteFixture(ac2Assignments(), () => {
    const T = E.tasteProfile();
    assert.equal(T.n, 60);
    assert.deepEqual([...T.range], [80, 80]);
    assert.equal(round4(T.styles.Animation.lean), -0.3333);
    assert.equal(round4(T.styles.Action.lean), 0.9091);

    // CAS-1260: You counts only films sharing the combination; Cascade score plays no part.
    const cases = [
      [["Animation"], [17, 0.4, 2]],
      [["War"], [83, 0.5, 3]],
      [["Horror"], [83, 0.7, 7]],
      [["Drama"], [83, 0.7273, 8]],
      [["Action"], [83, 0.9302, 40]],
    ];
    cases.forEach(([genres, expected]) => {
      const m = E.tasteMatch(scoredFilm(genres, 80));
      assert.deepEqual([m.value, round4(m.conf), m.films], expected, genres.join(", "));
    });
    // No judged film shares two of these styles (every fixture film has one style): no You.
    assert.equal(E.tasteMatch(scoredFilm(["Crime","Thriller","Horror"], 80)), null);
    assert.equal(E.tasteMatch(scoredFilm(["Music","Documentary"], 80)), null);
  });
});

test("CAS-1263 AC1: the You lozenge — green at 50 and over, orange below, white number, three fill steps from confidence, no opacity", () => {
  withTasteFixture(ac2Assignments(), () => {
    // conf: Action 0.9302 -> c3; War 0.5 -> c2; Animation 0.4 -> c1.
    const sure = E.matchBadgeHTML(scoredFilm(["Action"], 80));
    assert.match(sure, /^<span class="qyou for c3" title=/);
    assert.ok(sure.includes("<b>83</b><small>You</small>"));
    assert.ok(!sure.includes("opacity"));
    assert.match(E.matchBadgeHTML(scoredFilm(["War"], 80)), /^<span class="qyou for c2" /);
    const against = E.matchBadgeHTML(scoredFilm(["Animation"], 80));
    assert.match(against, /^<span class="qyou against c1" /);
    assert.ok(!against.includes("mbars"));
    assert.equal(E.matchBadgeHTML(scoredFilm(["Music","Documentary"], 80)), "");
  });
});

test("CAS-1261 AC2: the Public lozenge carries the Cascade score in its tier colour", () => {
  assert.ok(E.publicLozengeHTML(scoredFilm(["Action"], 90), "intitle").startsWith('<span class="qpub hi intitle"'));
  assert.ok(E.publicLozengeHTML(scoredFilm(["Action"], 75), "inrow").startsWith('<span class="qpub mid inrow"'));
  assert.ok(E.publicLozengeHTML(scoredFilm(["Action"], 60)).includes("<b>60</b><small>Public</small>"));
});

test("CAS-1254 AC4: the built index.html carries the wider certainty steps, after the old rules", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const needles = [
    '.qhero.c3{background:#7c5cff}',
    '.qhero.c2{background:rgba(124,92,255,.40)}',
    '.qhero.c1{background:rgba(124,92,255,.13);color:#cfc4ff}',
    '.qhero.c1 small{color:rgba(207,196,255,.72)}',
  ];
  const oldRule = '.qhero.c2{background:rgba(124,92,255,.36)}';
  const oldIndex = html.indexOf(oldRule);
  assert.notEqual(oldIndex, -1, "the old .qhero.c2 rule must still be present");
  needles.forEach(needle => {
    assert.equal(html.split(needle).length - 1, 1, `${needle} must appear exactly once`);
    assert.ok(html.indexOf(needle) > oldIndex, `${needle} must come after the old .qhero.c2 rule`);
  });
});

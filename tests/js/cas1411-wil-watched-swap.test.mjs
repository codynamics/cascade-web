// CAS-1411: "Where it lists" tests a film against another mood by swapping watchTab/watchCinemaStage/
// watchMoodSel and calling oamVisibleRows(); it must also swap watchWatchedSel[tab] to the TESTED mood's
// Watched selection (moodWatchedSel), or the selected mood's Watched choice decides the answer.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

const C = { id:"cas1411-fixture", name:"Agent", v:2,
  styles:{ Action:{ bar:1, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), name:"M", show:"20", ...overrides };
}
const FILM = { tmdb_id:91411001, title:"CAS-1411 fixture", genres:["Action"], status:["included_streaming"],
  language:"en", wm_critic_score:null, wm_user_rating:9, _fixture:true, availability_confidence:"confirmed",
  cinema_release:true, cinema_date:E.TODAY,
  offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}] };

function snapshot(){
  const sel = {};
  Object.keys(E.watchWatchedSel).forEach(k => { sel[k] = E.watchWatchedSel[k]; });
  return { tab:E.watchTab, stage:E.watchCinemaStage, mood:E.watchMoodSel, sel,
    contents:Object.fromEntries(Object.keys(sel).map(k => [k, [...sel[k]].sort().join(",")])) };
}
function assertSame(before, after){
  assert.equal(after.tab, before.tab);
  assert.equal(after.stage, before.stage);
  assert.equal(after.mood, before.mood);
  Object.keys(before.sel).forEach(k => {
    assert.equal(after.sel[k], before.sel[k], `watchWatchedSel.${k} must be the same Set object`);
    assert.equal(after.contents[k], before.contents[k], `watchWatchedSel.${k} contents unchanged`);
  });
}

function run(fn){
  const savedMovies = [...E.MOVIES], savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  const savedCascades = [...E.cascades], savedWatched = new Set(E.watched);
  const savedSel = E.watchMoodSel;
  const A = moodWith({ id:"cas1411-A", watched:true, v2:true });
  const B = moodWith({ id:"cas1411-B", watched:false, v2:true });
  E.MOVIES.length = 0; E.MOVIES.push(FILM);
  E.watchMoods.length = 0; E.watchMoods.push(A, B);
  E.cascades.length = 0; E.cascades.push(C);
  E.watched.clear(); E.watched.add(FILM.tmdb_id);
  try{ return fn(A, B); }
  finally{
    E.MOVIES.length = 0; savedMovies.forEach(m => E.MOVIES.push(m));
    E.watchMoods.length = 0; savedMoods.forEach(m => E.watchMoods.push(m));
    E.cascades.length = 0; savedCascades.forEach(a => E.cascades.push(a));
    E.watched.clear(); savedWatched.forEach(x => E.watched.add(x));
    if(E.watchMoodSel !== savedSel) E.window.setWatchMood(savedSel);
  }
}
function select(mood){
  E.window.setWatchMood(mood.id);
  assert.equal(E.watchMoodSel, mood.id, "setup: mood selected");
}

test("CAS-1411 helper: v2 mood watched true -> every verdict key, otherwise empty", () => {
  assert.equal(E.moodWatchedSel({ v2:true, watched:true }).size, E.REVIEW_STEPS.length);
  assert.equal(E.moodWatchedSel({ v2:true, watched:false }).size, 0);
});

test("CAS-1411 AC1a/b/c: shown-in-mood follows the TESTED mood's Watched, state restored", () => {
  run((A, B) => {
    select(B);
    let before = snapshot();
    assert.equal(E.oamFilmShownInMood(FILM.tmdb_id, A, C), true, "(a) B selected, A includes watched");
    assertSame(before, snapshot());
    select(A);
    before = snapshot();
    assert.equal(E.oamFilmShownInMood(FILM.tmdb_id, B, C), false, "(b) A selected, B excludes watched");
    assertSame(before, snapshot());
  });
});

test("CAS-1411 AC1d: oamWilRankInMood restores the same state", () => {
  run((A, B) => {
    [A, B].forEach(sel => {
      select(sel);
      const before = snapshot();
      E.oamWilRankInMood(FILM, A, C, E.oamWilStageKeyFor ? E.oamWilStageKeyFor(FILM) : "stream");
      assertSame(before, snapshot());
      E.oamWilRankInMood(FILM, B, C, E.oamWilStageKeyFor ? E.oamWilStageKeyFor(FILM) : "stream");
      assertSame(before, snapshot());
    });
  });
});

// CAS-1390: a mood can be filtered by "Title, actor or director" text, reusing Find's own comma-AND
// matcher (filmMatchesSearch, CAS-1387) as is. oamFilmMeetsMoodRules and oamFilmMeetsReleasesRules both
// gain the same `mood.people` check, after their existing gates; hand add/take-out (filmInOneAgentMood)
// still wins over it, same as every other rule. A missing or empty `people` must behave exactly as today.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1390-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"cas1390-mood", name:"Test mood", ...overrides };
}
let _nextId = 91900001;
function film(style, overrides){
  return { tmdb_id:_nextId++, title:"CAS-1390 fixture", genres:[style], status:["included_streaming"],
    wm_critic_score:null, wm_user_rating:9, _fixture:true, availability_confidence:"confirmed",
    cast:[], director:"",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}], ...overrides };
}
function releaseFilm(style, overrides){
  return { ...film(style), cinema_release:true, cinema_date:E.TODAY, ...overrides };
}

test("CAS-1390 AC1a: a mood with people:\"Tom Cruise\" admits a qualifying film and rejects an otherwise identical film without him", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ people:"Tom Cruise" });
  const withHim = film("Action", { cast:["Tom Cruise"] });
  const withoutHim = film("Action", { cast:["Someone Else"] });
  assert.equal(E.oamFilmMeetsMoodRules(withHim, mood, c), true);
  assert.equal(E.oamFilmMeetsMoodRules(withoutHim, mood, c), false);
});

test("CAS-1390 AC1b: people:\"tom cruise, russo\" admits only a film matching both parts", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ people:"tom cruise, russo" });
  const both = film("Action", { cast:["Tom Cruise"], director:"Anthony Russo" });
  const onlyCruise = film("Action", { cast:["Tom Cruise"], director:"Someone Else" });
  const onlyRusso = film("Action", { cast:["Someone Else"], director:"Anthony Russo" });
  const neither = film("Action", { cast:["Someone Else"], director:"Someone Else" });
  assert.equal(E.oamFilmMeetsMoodRules(both, mood, c), true);
  assert.equal(E.oamFilmMeetsMoodRules(onlyCruise, mood, c), false);
  assert.equal(E.oamFilmMeetsMoodRules(onlyRusso, mood, c), false);
  assert.equal(E.oamFilmMeetsMoodRules(neither, mood, c), false);
});

test("CAS-1390 AC1c: a film in the mood's \"in\" list still shows even when it fails the people filter", () => {
  const c = criteriaWith("Action", 1);
  const m = film("Action", { cast:["Someone Else"] });
  const mood = moodWith({ people:"Nolan", in:[m.tmdb_id] });
  assert.equal(E.oamFilmMeetsMoodRules(m, mood, c), false, "sanity: the bare rules reject it");
  assert.equal(E.filmInOneAgentMood(m, mood, c), true, "a hand add still wins over the people filter");
});

test("CAS-1390 AC1d: a mood saved without `people` at all behaves exactly as one saved with people:\"\"", () => {
  const c = criteriaWith("Action", 1);
  const m = film("Action", { cast:["Someone Else"] });
  const withEmptyField = moodWith({ people:"" });
  const legacy = moodWith({}); delete legacy.people;
  assert.equal(E.oamFilmMeetsMoodRules(m, withEmptyField, c), E.oamFilmMeetsMoodRules(m, legacy, c));
  assert.equal(E.oamFilmMeetsMoodRules(m, legacy, c), true, "no filter at all must admit the film");
});

test("CAS-1390 AC1e: the Releases mood applies the people filter too", () => {
  const c = criteriaWith("Action", 1);
  const mood = { ...moodWith({ people:"Tom Cruise" }), id:"releases", name:"Releases" };
  const withHim = releaseFilm("Action", { cast:["Tom Cruise"] });
  const withoutHim = releaseFilm("Action", { cast:["Someone Else"] });
  assert.equal(E.oamFilmMeetsReleasesRules(withHim, mood, c), true);
  assert.equal(E.oamFilmMeetsReleasesRules(withoutHim, mood, c), false);
});

test("CAS-1390 AC2: saving a mood with people:\"Nolan\" round-trips through the sheet", () => {
  const savedCascades = [...E.cascades];
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  const savedSel = E.watchMoodSel;
  E.cascades.length = 0;
  E.cascades.push({ id:"cas1390-agent", name:"My agent", v:2, styles:{}, combo:{}, seenAdj:{}, dismissed:[] });
  try{
    E.window.openOamMoodSheetForNew();
    E.window.setOamDraftName("CAS-1390 round trip");
    E.window.setOamDraftPeople("Nolan");
    E.window.oamSaveMoodFromSheet();
    const saved = E.watchMoods.find(m => m.id === E.watchMoodSel);
    assert.ok(saved, "setup: save must land a mood in watchMoods");
    assert.equal(saved.people, "Nolan", "the saved mood object must carry the typed text");
    const reopened = E.oamMoodDraftFrom(saved);
    assert.equal(reopened.people, "Nolan", "reopening the draft must show the saved text");
  } finally {
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
    if(E.watchMoodSel !== savedSel) E.window.setWatchMood(savedSel);
  }
});

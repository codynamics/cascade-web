// CAS-1374: Best 10 is retired (OAM_SHOW_OPTS/OAM_SHOW_N: All/20/40/60/80, a saved "10" migrates to "20"),
// and Find's "Not shown" case in oamWilCase now checks the REAL reason a film that passes a mood's rules
// still isn't shown, in order: (1) the film holds no Watch stage at all (oamWilStageKeyFor returns null —
// the Odyssey bug, a `released` film whose cinema run is over 90 days behind it with no offer yet); (2) a
// mood whose own Best N cut the film genuinely ranks below; (3) anything else, a plain "not shown right now".
// The old code (CAS-1362 cause 1) just blamed "the first mood with a numeric cut" regardless of whether that
// cut was actually responsible, which is exactly what misled Find for the Odyssey.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1374-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"t-cas1374-mood", name:"Me", ...overrides };
}
let _nextId = 91740001;
function filmWith(overrides){
  return { tmdb_id:_nextId++, title:"CAS-1374 fixture", genres:["Action"], status:["included_streaming"],
    language:"en", wm_critic_score:null, wm_user_rating:9, _fixture:true, availability_confidence:"confirmed",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}],
    cinema_release:true, cinema_date:E.TODAY, ...overrides };
}
// oamFilmShownInMood/oamWilRankInMood read oneAgentCriteria() (the account's own v2 agent in E.cascades)
// rather than the `c` handed to oamWilCase itself, so a test asserting the "shown"/"ranked" side of Find
// needs its criteria live in E.cascades too, not just passed as an argument.
// The real catalogue sits in E.MOVIES too, and oamStagePool() scans all of it — replaced wholesale with
// just the fixtures for the run so a rank/cut assertion can never be diluted by however many real titles
// the current catalogue happens to also admit.
function withMoviesAndMoods(c, movies, moods, fn){
  const savedMovies = [...E.MOVIES];
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  const savedCascades = [...E.cascades];
  E.MOVIES.length = 0; movies.forEach(m => E.MOVIES.push(m));
  E.watchMoods.length = 0; moods.forEach(m => E.watchMoods.push(m));
  E.cascades.length = 0; E.cascades.push(c);
  try{ return fn(); }
  finally{
    E.MOVIES.length = 0; savedMovies.forEach(m => E.MOVIES.push(m));
    E.watchMoods.length = 0; savedMoods.forEach(m => E.watchMoods.push(m));
    E.cascades.length = 0; savedCascades.forEach(a => E.cascades.push(a));
  }
}

// ---- 1. Show options: Best 10 gone, Best 60/80 added, migration both ways -------------------------------

test("CAS-1374 AC1: OAM_SHOW_OPTS is All/Best 20/40/60/80, no Best 10", () => {
  assert.equal(JSON.stringify(E.OAM_SHOW_OPTS.map(([k]) => k)), JSON.stringify(["all", "20", "40", "60", "80"]));
});

test("CAS-1374 AC1: a mood saved as Best 10 opens as Best 20", () => {
  const draft = E.oamMoodDraftFrom({ ...E.oamMoodDefaultFields(), id:"m", name:"Old", show:"10" });
  assert.equal(draft.show, "20");
});

test("CAS-1374 AC1: Best 60 and 80 cut the list at 60 and 80", () => {
  const c = criteriaWith("Action", 1);
  const rows = Array.from({ length: 90 }, (_, i) => filmWith({ wm_user_rating: 9 - i*0.01 }));
  const held = new Set();
  const kept60 = E.oamApplyShowCap(rows, moodWith({ show:"60" }), c, held);
  const kept80 = E.oamApplyShowCap(rows, moodWith({ show:"80" }), c, held);
  assert.equal(kept60.length, 60);
  assert.equal(kept80.length, 80);
});

// ---- 2. Find's three real "not shown" reasons -------------------------------------------------------------

// CAS-1375 supersedes this AC for `released` films specifically: filmMatchesWatchTab now maps `released` to
// the Rental tab's own "Rental soon" stage (the Odyssey now has somewhere to list), so the no-stage sentence
// below no longer fires for it while the Rental window stays switched on. See
// cas1375-rental-soon.test.mjs for the new behaviour.
test("CAS-1374 AC2 (superseded by CAS-1375): a `released` film now gets the Rental tab's Rental soon stage, not the no-stage sentence", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ show:"all" });
  const film = filmWith({ status:["released"], offers:[] });
  withMoviesAndMoods(c, [film], [mood], () => {
    assert.equal(E.filmInOneAgentMood(film, mood, c), true, "sanity: it still passes the mood's own rules");
    const r = E.oamWilCase(film, c);
    assert.match(r.sentence, /Listed in<\/span> <b>Me<\/b> &middot; Rental soon/);
    assert.equal(r.buttons.length, 1);
    assert.equal(r.buttons[0].label, "Show in Watch ›");
  });
});

test("CAS-1374 AC3: a film below a Best 40 cut gives its real rank and the right mood's name; setting that mood to All lists it", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ show:"40" });
  // 40 decoys that outscore the target, plus the target itself — genuinely 41st, 1 below the cut.
  const decoys = Array.from({ length: 40 }, (_, i) => filmWith({ wm_user_rating: 9 - i*0.001 }));
  const target = filmWith({ wm_user_rating: 1 });
  withMoviesAndMoods(c, [...decoys, target], [mood], () => {
    assert.equal(E.filmInOneAgentMood(target, mood, c), true, "sanity: it passes the mood's own rules");
    const r = E.oamWilCase(target, c);
    assert.match(r.sentence, /It's in Me's rules but ranks 41st, below its best 40\./);
    assert.equal(r.buttons.length, 1);
    assert.equal(r.buttons[0].label, "Add it to Me");
    // Setting the mood to All removes the cut entirely — now listed.
    mood.show = "all";
    const r2 = E.oamWilCase(target, c);
    assert.match(r2.sentence, /Listed in/);
  });
});

test("CAS-1374 AC4: anything else (held off the page by Find's own search text, not a stage or a cut) gives the plain fallback", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ show:"all" });   // uncapped, so the cut-rank check can never fire
  const film = filmWith({});
  const savedSearch = E.watchSearch.stream;
  E.watchSearch.stream = "zzz-does-not-match-the-fixture-title";
  withMoviesAndMoods(c, [film], [mood], () => {
    try{
      assert.equal(E.filmInOneAgentMood(film, mood, c), true, "sanity: it passes the mood's own rules");
      const r = E.oamWilCase(film, c);
      assert.match(r.sentence, /It's in Me's rules but not shown right now\./);
    } finally {
      E.watchSearch.stream = savedSearch;
    }
  });
});

test("CAS-1374: never names a mood whose Show is All as \"below its best N\"", () => {
  const c = criteriaWith("Action", 1);
  const uncapped = moodWith({ id:"m-all", name:"Uncapped", show:"all" });
  const capped = moodWith({ id:"m-cap", name:"Capped", show:"20" });
  // 25 decoys outrank the target in Capped's own pool (genuinely 26th, below its best 20). Find's own
  // search text excludes the target from BOTH moods' "shown" set uniformly (oamVisibleRows' preSheetRows
  // — what the rank check reads — is computed before the search filter, so the rank itself is unaffected);
  // without that, Uncapped would simply show it and the top "Listed in" branch would return first.
  const decoys = Array.from({ length: 25 }, (_, i) => filmWith({ wm_user_rating: 9 - i*0.001 }));
  const target = filmWith({ wm_user_rating: 1 });
  const savedSearch = E.watchSearch.stream;
  E.watchSearch.stream = "zzz-does-not-match-the-fixture-title";
  withMoviesAndMoods(c, [...decoys, target], [uncapped, capped], () => {
    try{
      const r = E.oamWilCase(target, c);
      assert.match(r.sentence, /Capped/);
      assert.doesNotMatch(r.sentence, /Uncapped/);
    } finally {
      E.watchSearch.stream = savedSearch;
    }
  });
});

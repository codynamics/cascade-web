// CAS-1366: four Releases/mood bugs.
// 1. filmInOneAgentMood's "releases" branch only ever checked the latest-release window and that the main
//    genre was on in the agent — it never applied the mood's own styles/ages/awards/years, so unticking a
//    genre (or any other Releases control) did nothing. oamFilmMeetsReleasesRules is the fix: the same
//    genre/ages/awards/years gates as oamFilmMeetsMoodRules, but admission-by-latest-window (any score)
//    instead of admission-by-score.
// 2. ONE_AGENT_MOOD_BUILTINS' releases entry had no sort/show, so a never-saved Releases mood opened (and,
//    once saved, stayed) in score order via oamMoodDefaultFields()'s own fallback. Fixed at the source
//    (builtin now carries sort:"release"/show:"all") plus a fallback in oamMoodDraftFrom and a one-time
//    load repair (loadUserPrefs) for an account that already saved the old score-order default — stamped
//    with releasesSortV so a later deliberate choice of Score sticks.
// 3. applyMoodToState's `new Set(mood.watched||[])` assumed mood.watched is always a v1 verdict-key array;
//    a v2 mood's own `watched` is a boolean, and `new Set(true)` throws — the actual cause of "turning on
//    Include films I've watched and tapping Save doesn't save" (the save crashed before the write).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1366-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"releases", name:"Releases", ...overrides };
}
let _nextId = 91660001;
function releaseFilm(style, overrides){
  return { tmdb_id:_nextId++, title:"CAS-1366 fixture", genres:[style], status:["included_streaming"],
    wm_critic_score:null, wm_user_rating:9, _fixture:true, availability_confidence:"confirmed",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}],
    cinema_release:true, cinema_date:E.TODAY, ...overrides };
}
function withWatched(id, fn){
  const saved = new Set(E.watched);
  E.watched.clear(); E.watched.add(id);
  try{ return fn(); } finally{ E.watched.clear(); saved.forEach(x => E.watched.add(x)); }
}

test("CAS-1366 AC1: Releases excludes a film whose main genre is unticked from the mood's own styles (the bug)", () => {
  // CAS-1593: Latest and Best's ticks ARE the agent's genre on/off, so "unticked" means the agent has it off.
  const m = releaseFilm("Documentary");
  const unticked = criteriaWith("Documentary", null);   // switched off (in Latest and Best / the agent)
  const mood = moodWith({ styles:["Drama"] });          // its own stored styles no longer matter
  assert.equal(E.oamFilmMeetsReleasesRules(m, mood, unticked), false);
  assert.equal(E.filmInOneAgentMood(m, mood, unticked), false);
  const reticked = criteriaWith("Documentary", 1);      // ticked again
  assert.equal(E.filmInOneAgentMood(m, mood, reticked), true, "ticking it back must bring it back");
});

test("CAS-1366 AC1: Releases honours the mood's own age-rating filter", () => {
  const c = criteriaWith("Action", 1);
  const m = releaseFilm("Action", { age_rating:"PG" });
  assert.equal(E.oamFilmMeetsReleasesRules(m, moodWith({ ages:["M"] }), c), false);
  assert.equal(E.oamFilmMeetsReleasesRules(m, moodWith({ ages:["PG"] }), c), true);
  assert.equal(E.oamFilmMeetsReleasesRules(m, moodWith({ ages:[] }), c), true, "no ages ticked means every age");
});

test("CAS-1366 AC1 (CAS-1690): a list's own genre state is its score gate — Favourite admits regardless of score, Include (top 25%) does not", () => {
  // CAS-1690: the Override (topShare 100) and the five-stop levels are retired; Include / Favourite do the same job.
  const m = releaseFilm("Action", { cinema_release:false, cinema_date:null, wm_user_rating:5 });
  const c = criteriaWith("Action", 1);
  assert.ok(E.oneScore(m, c) < E.oneBarForTopPct("Action", 25), "sanity: the fixture scores below the Top 25% bar");
  const ordinary = { ...moodWith({}), id:"t-cas1366-ordinary" };
  assert.equal(E.oamFilmMeetsMoodRules(m, { ...ordinary, styles:["Action"] }, c), false,
    "sanity: Include (top 25%) excludes this film");
  assert.equal(E.oamFilmMeetsMoodRules(m, { ...ordinary, styles:["Action"], favs:["Action"] }, c), true,
    "a Favourite must admit it regardless of its score");
});

test("CAS-1366: Releases' own \"Include films I've watched\" switch now applies (previously had no effect)", () => {
  const c = criteriaWith("Action", 1);
  const m = releaseFilm("Action");
  withWatched(m.tmdb_id, () => {
    assert.equal(E.oamFilmMeetsReleasesRules(m, moodWith({ watched:false }), c), false,
      "off: a watched film must be excluded, same as every other mood");
    assert.equal(E.oamFilmMeetsReleasesRules(m, moodWith({ watched:true }), c), true,
      "on: a watched film must now be admitted — the part-1 fix is what makes this switch do anything here");
  });
});

test("CAS-1366: a hand take-out still beats Releases' own rules", () => {
  const c = criteriaWith("Action", 1);
  const m = releaseFilm("Action");
  assert.equal(E.filmInOneAgentMood(m, moodWith({ out:[m.tmdb_id] }), c), false);
});

test("CAS-1366 AC2: the built-in Releases mood defaults to release order, showing all", () => {
  const releases = E.ONE_AGENT_MOOD_BUILTINS.find(b => b.id === "releases");
  assert.equal(releases.sort, "score", "CAS-1491: Latest and Best opens by score");
  assert.equal(releases.show, "40");
});

test("CAS-1366 AC2: a never-saved v2 account's Releases (oamMoodsListReal's own fallback) opens in release order", () => {
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  E.watchMoods.length = 0;   // simulate an account with nothing provisioned yet
  try{
    const releases = E.oamMoodsListReal().find(m => m.id === "releases");
    assert.equal(releases.sort, "score", "CAS-1491: Latest and Best opens by score");
    assert.equal(releases.show, "40");
  } finally {
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
  }
});

test("CAS-1366 AC2: oamMoodDraftFrom falls back to release order for Releases, score for everything else", () => {
  const releasesNoSort = { ...E.oamMoodDefaultFields(), id:"releases", name:"Releases" };
  delete releasesNoSort.sort;
  assert.equal(E.oamMoodDraftFrom(releasesNoSort).sort, "release");
  const otherNoSort = { ...E.oamMoodDefaultFields(), id:"t-other", name:"Test" };
  delete otherNoSort.sort;
  assert.equal(E.oamMoodDraftFrom(otherNoSort).sort, "score");
});

test("CAS-1366 AC4: turning on \"Include films I've watched\" no longer crashes applyMoodToState (the actual Save bug)", () => {
  const mood = { ...E.oamMoodDefaultFields(), id:"t-cas1366-watched-on", name:"Test", watched:true };
  assert.doesNotThrow(() => E.applyMoodToState(mood));
});

test("CAS-1366 AC4: applyMoodToState turns a v2 mood's boolean watched into every verdict key (on) or none (off)", () => {
  const tab = E.watchTab;
  const saved = new Set(E.watchWatchedSel[tab]);
  try{
    E.applyMoodToState({ ...E.oamMoodDefaultFields(), id:"t-cas1366-on", watched:true });
    const allKeys = new Set([...E.WATCH_STEPS.map(s => s.key), "notfor"]);
    assert.deepEqual(new Set(E.watchWatchedSel[tab]), allKeys, "on: every verdict key, i.e. unfiltered");
    E.applyMoodToState({ ...E.oamMoodDefaultFields(), id:"t-cas1366-off", watched:false });
    assert.equal(E.watchWatchedSel[tab].size, 0, "off: no verdict keys, i.e. a tagged-out film is excluded");
  } finally {
    E.watchWatchedSel[tab].clear(); saved.forEach(k => E.watchWatchedSel[tab].add(k));
  }
});

test("CAS-1366: saving Releases from the sheet always stamps releasesSortV, whichever sort was picked", () => {
  // oamSaveMoodFromSheet (via renderOamMoodSheetBody's own oneAgentCriteria() guard) is a no-op without a
  // real v2 agent, the same seeding convention cas1339-agent-screen.test.mjs's own withCascades uses.
  const savedCascades = [...E.cascades];
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  const savedSel = E.watchMoodSel;
  E.cascades.length = 0;
  E.cascades.push({ id:"cas1366-fixture", name:"My agent", v:2, styles:{}, combo:{}, seenAdj:{}, dismissed:[] });
  try{
    E.window.openOamMoodSheetFor("releases");
    E.window.setOamDraftSort("score");
    E.window.oamSaveMoodFromSheet();
    const releases = E.watchMoods.find(m => m.id === "releases" && m.v2);
    assert.equal(releases.sort, "score", "sanity: the chosen sort must actually persist");
    assert.equal(releases.releasesSortV, 1, "stamped so a later load repair never reverts this deliberate choice");
  } finally {
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
    if(E.watchMoodSel !== savedSel) E.window.setWatchMood(savedSel);
  }
});

// Same fake-client/rpcCalls harness as cas1328-releases-becomes-latest.test.mjs's own AC3 — the one-time
// load repair must never write (CAS-1218/1243); the repair instead rides piggyback on the account's next
// real view write (moodsProvisionPending/riderReviewSessionsOnto, not exercised here).
function makeFakeClient(row){
  const rpcCalls = [];
  function builder(table){
    const state = { table, kind: "select" };
    const b = {
      select(){ return b; }, order(){ return b; }, range(){ return b; },
      upsert(fields){ state.kind = "upsert"; state.fields = fields; return b; },
      match(){ return b; },
      then(resolve){
        return Promise.resolve().then(() => (table === "user_prefs" && state.kind === "select")
          ? { data: row ? [row] : [], error: null } : { data: [], error: null }).then(resolve);
      },
    };
    return b;
  }
  return { rpcCalls, from(table){ return builder(table); },
    rpc(name, params){ rpcCalls.push({ name, params }); return Promise.resolve({ data: null, error: null }); } };
}
const settle = () => new Promise(r => setTimeout(r, 0));

test("CAS-1366 AC2: a stored Releases mood with sort \"score\" and no releasesSortV is repaired once (CAS-1491: now on to Latest and Best, score order), with no write on load", async () => {
  const legacyMood = { ...E.oamMoodDefaultFields(), id:"releases", name:"Releases", sort:"score" };
  const client = makeFakeClient({ user_id:"cas1366-test-user", view:{ moods:[legacyMood], mood:"releases" } });
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user:{ id:"cas1366-test-user" } };
  try{
    await E.CascadePersistence.loadUserPrefs();
    await settle();
    const releases = E.watchMoods.find(m => m.id === "releases");
    assert.equal(releases.sort, "score", "CAS-1491: the v4 repair settles it on score order, in memory");
    assert.equal(releases.releasesSortV, 1, "marked so a future deliberate Score choice sticks");
    assert.equal(client.rpcCalls.length, 0, "CAS-1218/1243: loading an account must never write anything back");
  } finally {
    auth.enabled = false; auth.client = null; auth.session = null;
  }
});

test("CAS-1366 AC2: a stored Releases mood already carrying releasesSortV (a deliberate Score choice) is left alone on load", async () => {
  const deliberate = { ...E.oamMoodDefaultFields(), id:"releases", name:"Releases", sort:"score", releasesSortV:1 };
  const client = makeFakeClient({ user_id:"cas1366-test-user-2", view:{ moods:[deliberate], mood:"releases" } });
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user:{ id:"cas1366-test-user-2" } };
  try{
    await E.CascadePersistence.loadUserPrefs();
    await settle();
    const releases = E.watchMoods.find(m => m.id === "releases");
    assert.equal(releases.sort, "score", "a deliberate choice must stick, never reverted back to release");
    assert.equal(client.rpcCalls.length, 0);
  } finally {
    auth.enabled = false; auth.client = null; auth.session = null;
  }
});

test("CAS-1366 AC3: \"Documentary\" is no longer shortened to \"Doco\"", () => {
  assert.equal(E.oneAgentShortName("Documentary"), "Documentary");
  // the other two short names this ticket explicitly keeps
  assert.equal(E.oneAgentShortName("Science Fiction"), "Sci-fi");
  assert.equal(E.oneAgentShortName("TV Movie"), "TV movie");
});

test("CAS-1410: starter Latest and Best is Override 20, not cinemaOnly (CAS-1491); cinemaOnly still excludes a film with no cinema release", () => {
  const s = E.oneAgentStarterMoods()[0];
  assert.equal(s.cinemaOnly, false);
  assert.equal(s.topShare, 20);
  const c = criteriaWith("Action", 1);
  const noCinema = releaseFilm("Action", { cinema_release:false, cinema_date:null });
  const on = moodWith({ cinemaOnly:true, topShare:100 });
  const off = moodWith({ cinemaOnly:false, topShare:100 });
  assert.equal(E.filmInOneAgentMood(noCinema, on, c), false);
  assert.equal(E.oamFilmMeetsMoodRules(noCinema, off, c), true, "not excluded for the cinema reason when off");
});

// CAS-1491: All Latest + Best of the best merged into Latest and Best (releasesV:4).
test("CAS-1491: a releasesV:3 All Latest + a best mood load as Latest and Best, best gone, selection moved, no write", async () => {
  const old = { ...E.oamMoodDefaultFields(), id:"releases", name:"All Latest", sort:"release", releasesSortV:1, releasesV:3,
    cinemaOnly:true, years:1, topShare:100, show:"all", ages:["PG","M"], in:[123] };
  const best = { ...E.oamMoodDefaultFields(), id:"best", name:"Best of the best", topShare:20, show:"40" };
  const client = makeFakeClient({ user_id:"cas1491-test-user", view:{ moods:[old, best], mood:"best" } });
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user:{ id:"cas1491-test-user" } };
  try{
    await E.CascadePersistence.loadUserPrefs();
    await settle();
    const r = E.watchMoods.find(m => m.id === "releases");
    assert.equal(r.name, "Latest and Best");
    assert.deepEqual([...r.styles], []);
    assert.equal(r.topShare, 20); assert.equal(r.show, "40"); assert.equal(r.sort, "score");
    assert.equal(r.watched, true); assert.equal(r.cinemaOnly, false); assert.equal(r.handOnly, false);
    assert.equal(r.awards, "any"); assert.equal(r.years, 0); assert.equal(r.svc, null);
    assert.equal(r.releasesV, 4); assert.equal(r.releasesSortV, 1); assert.equal(r.sortChosen, true);
    assert.deepEqual([...r.ages], ["PG","M"]);
    assert.deepEqual([...r.in], [123]);
    assert.equal(E.watchMoods.some(m => m.id === "best"), false);
    assert.equal(E.watchMoodSel, "releases");
    assert.equal(client.rpcCalls.length, 0, "a load must never write");
  } finally {
    auth.enabled = false; auth.client = null; auth.session = null;
  }
});

test("CAS-1491: the repair is a no-op on a releases record already at releasesV:4", async () => {
  const cur = { ...E.oamMoodDefaultFields(), id:"releases", name:"My own name", sort:"release", releasesSortV:1, releasesV:4,
    topShare:50, show:"20", years:2 };
  const client = makeFakeClient({ user_id:"cas1491-test-user-2", view:{ moods:[cur], mood:"releases" } });
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user:{ id:"cas1491-test-user-2" } };
  try{
    await E.CascadePersistence.loadUserPrefs();
    await settle();
    const r = E.watchMoods.find(m => m.id === "releases");
    assert.equal(r.name, "My own name"); assert.equal(r.topShare, 50); assert.equal(r.years, 2);
    assert.equal(r.sort, "release"); assert.equal(r.show, "20");
    assert.equal(client.rpcCalls.length, 0);
  } finally {
    auth.enabled = false; auth.client = null; auth.session = null;
  }
});

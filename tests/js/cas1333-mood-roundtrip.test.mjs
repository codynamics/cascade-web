// CAS-1333: CAS-1331 fixed Latest's (id "releases") source/name to stick once the person actually saves
// them from the sheet (sourceChosen/nameChosen), but left Sort on the old CAS-1328 fixed-by-the-app rule —
// moodSort(mood) returned "release" for id "releases" no matter what was saved, while the sheet still showed
// the Sort control. moodSort now takes the same sortChosen flag saveMoodFromSheet already stamps alongside
// sourceChosen/nameChosen for this one id, so all three behave the same way: default until actually chosen,
// then the person's choice sticks, including when it's literally "release" (the default value itself).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function currentMood(E){ return E.watchMoods.find(m => m.id === E.watchMoodSel); }
function setsEqual(a, b){ return a.size === b.size && [...a].every(v => b.has(v)); }

test("CAS-1333: moodSort keeps Latest on Release date by default and sticks to a saved choice once sortChosen", () => {
  const E = loadEngine();
  assert.equal(E.moodSort({ id: "releases", sort: "title" }), "release",
    "no sortChosen at all: still the CAS-1328 legacy fallback");
  assert.equal(E.moodSort({ id: "releases", sort: "title", sortChosen: true }), "title",
    "sortChosen:true: the person's own choice must win");
  assert.equal(E.moodSort({ id: "releases", sort: "score", sortChosen: true }), "score");
  assert.equal(E.moodSort({ id: "releases", sort: "release", sortChosen: true }), "release",
    "sortChosen:true with Release date itself chosen must still read release");
  // A non-Latest mood is untouched by sortChosen entirely — the field means nothing off this one id.
  assert.equal(E.moodSort({ id: "t-other", sort: "title", sortChosen: false }), "title");
});

test("CAS-1333 AC2: a stored Latest record with no chosen flag still sorts by Release date", () => {
  const E = loadEngine();
  const savedSel = E.watchMoodSel;
  const idx = E.watchMoods.findIndex(m => m.id === "releases");
  const original = { ...E.watchMoods[idx] };
  try{
    E.watchMoods[idx] = { ...original, sort: "title" };   // a legacy record predating CAS-1303's sort field would also lack sortChosen
    E.window.setWatchMood("releases");
    assert.equal(E.moodSort(currentMood(E)), "release", "AC2: no sortChosen must still fall back to Release date");
  } finally {
    E.watchMoods[idx] = original;
    if(E.watchMoodSel !== savedSel) E.window.setWatchMood(savedSel);
  }
});

test("CAS-1333 AC1: saving Latest with Sort A-Z sticks — moodSort(currentMood()) reads title and the sheet reopens on A-Z", () => {
  const E = loadEngine();
  const savedSel = E.watchMoodSel;
  try{
    E.window.openMoodSheetFor("releases");
    E.window.setMoodDraftSort("title");
    E.window.saveMoodFromSheet();

    const saved = E.watchMoods.find(m => m.id === "releases");
    assert.equal(E.moodSort(currentMood(E)), "title", "AC1: moodSort(currentMood()) must read title after save");

    const reopened = E.moodDraftFrom(saved);
    assert.equal(reopened.sort, "title", "AC1: reopening the draft must show the saved A-Z choice, not revert to Release date");
  } finally {
    E.window.setWatchMood(savedSel);
  }
});

test("CAS-1333 AC1: saving Latest with Sort Score sticks — moodSort(currentMood()) reads score and the sheet reopens on Score", () => {
  const E = loadEngine();
  const savedSel = E.watchMoodSel;
  try{
    E.window.openMoodSheetFor("releases");
    E.window.setMoodDraftSort("score");
    E.window.saveMoodFromSheet();

    const saved = E.watchMoods.find(m => m.id === "releases");
    assert.equal(E.moodSort(currentMood(E)), "score", "AC1: moodSort(currentMood()) must read score after save");

    const reopened = E.moodDraftFrom(saved);
    assert.equal(reopened.sort, "score", "AC1: reopening the draft must show the saved Score choice, not revert to Release date");
  } finally {
    E.window.setWatchMood(savedSel);
  }
});

// AC3 / Change 2: the full round-trip check — open sheet, change every settable field through the sheet's
// own setters, saveMoodFromSheet, simulate the reload loadUserPrefs' own view.moods adoption does (JSON
// round-trip, moodDefaultFieldsNow() spread underneath — app_template.html's account-sync IIFE, not just the
// in-memory array saveMoodFromSheet leaves behind), then reopen and assert every field comes back as set.
// Runs over every built-in mood (MOOD_DEFAULTS) and a newly created one.
test("CAS-1333 AC3: every settable mood-sheet field round-trips through save + reload, for every built-in mood and a newly created mood", () => {
  const E = loadEngine();
  const savedMoodsSnapshot = E.watchMoods.map(m => ({ ...m }));
  const savedSel = E.watchMoodSel;
  const savedCascades = [...E.cascades];
  // Two real agents so source:"agents" plus a partial agentsOff round-trips meaningfully — CAS-1322's
  // all-agents-off guard only blocks the save when every agent is excluded, never when just one is.
  const a = E.normCascade({ kind: "stream", status: [], imdb: 7 }); a.id = "cas1333-a"; a.order = 0; a.paused = false; a.name = "A";
  const b = E.normCascade({ kind: "stream", status: [], imdb: 7 }); b.id = "cas1333-b"; b.order = 1; b.paused = false; b.name = "B";
  E.cascades.length = 0; E.cascades.push(a, b);

  function simulateReload(mood){
    // Mirrors app_template.html's loadUserPrefs adoption of a persisted view.moods entry: a plain JSON
    // round trip (what actually crosses the wire) with moodDefaultFieldsNow() spread underneath exactly as
    // `watchMoods = v.moods.slice(0, MOOD_MAX).map(m=>({...moodDefaultFieldsNow(), ...m}))` does.
    return { ...E.moodDefaultFieldsNow(), ...JSON.parse(JSON.stringify(mood)) };
  }

  try{
    const builtinIds = E.MOOD_DEFAULTS.map(m => m.id);
    [...builtinIds, null].forEach(id => {
      const existing = id ? E.watchMoods.find(m => m.id === id) : null;
      const baseline = E.moodDraftFrom(existing);

      if(id) E.window.openMoodSheetFor(id); else E.window.openMoodSheetForNew();

      const wantName = id ? `CAS-1333 round trip ${id}` : "CAS-1333 round trip new";
      const wantAgentsOff = new Set(baseline.agentsOff);
      wantAgentsOff.has(a.id) ? wantAgentsOff.delete(a.id) : wantAgentsOff.add(a.id);
      const wantWatched = new Set(baseline.watched);
      ["wow", "notfor"].forEach(k => wantWatched.has(k) ? wantWatched.delete(k) : wantWatched.add(k));
      const wantStylesOff = new Set(baseline.stylesOff);
      ["Comedy", "Horror"].forEach(g => wantStylesOff.has(g) ? wantStylesOff.delete(g) : wantStylesOff.add(g));
      const wantMineOnly = !baseline.mineOnly;
      const wantStarredOnly = !baseline.starredOnly;

      E.window.setMoodDraftName(wantName);
      E.window.setMoodDraftSource("agents");
      E.window.toggleMoodDraftAgent(a.id);
      E.window.setMoodDraftTopYou(20);
      E.window.setMoodDraftTopPublic(10);
      E.window.setMoodDraftSort("title");
      E.window.toggleMoodDraftMineOnly();
      E.window.toggleMoodDraftStarredOnly();
      E.window.setMoodDraftPickedBy("manual");
      E.window.toggleMoodDraftWatched("wow");
      E.window.toggleMoodDraftWatched("notfor");
      E.window.toggleMoodDraftGenre("Comedy");
      E.window.toggleMoodDraftGenre("Horror");

      E.window.saveMoodFromSheet();
      const savedId = E.watchMoodSel;
      const saved = E.watchMoods.find(m => m.id === savedId);
      assert.ok(saved, `setup (${id || "new"}): save must land a mood in watchMoods`);

      const reloaded = simulateReload(saved);
      const reopened = E.moodDraftFrom(reloaded);

      const label = id || "new";
      assert.equal(reopened.name, wantName, `${label}: name must round-trip`);
      assert.equal(reopened.source, "agents", `${label}: source must round-trip`);
      assert.ok(setsEqual(reopened.agentsOff, wantAgentsOff), `${label}: agentsOff must round-trip`);
      assert.equal(reopened.topYou, 20, `${label}: topYou (Show top You) must round-trip`);
      assert.equal(reopened.topPublic, 10, `${label}: topPublic (Show top Public) must round-trip`);
      assert.equal(reopened.sort, "title", `${label}: sort must round-trip`);
      assert.equal(reopened.mineOnly, wantMineOnly, `${label}: Mine only must round-trip`);
      assert.equal(reopened.starredOnly, wantStarredOnly, `${label}: Starred only must round-trip`);
      assert.equal(reopened.pickedBy, "manual", `${label}: Picked by must round-trip`);
      assert.ok(setsEqual(reopened.watched, wantWatched), `${label}: Watched must round-trip`);
      assert.ok(setsEqual(reopened.stylesOff, wantStylesOff), `${label}: Styles must round-trip`);
    });
  } finally {
    E.watchMoods.length = 0;
    E.watchMoods.push(...savedMoodsSnapshot);
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    E.window.setWatchMood(savedSel);
  }
});

// CAS-1256: a mood's Styles work the way an agent's do (CAS-1147) — a film shows when ANY of its
// styles is switched on, not only when every one of its styles is. Before this ticket, picking just
// Action in the Mood sheet switched every OTHER style off, and the list dropped a film the moment any
// ONE of its styles was off — so a film listed as Action, Adventure vanished with only Action on.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function unseedCascade(id){
  const i = E.cascades.findIndex(c => c.id === id);
  if(i >= 0) E.cascades.splice(i, 1);
}
function broadCascade(id, order){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.paused = false; c.order = order;
  return c;
}
// A film already standing in Streaming, listed by `owner`, not watched/blocked — so the only thing
// this test varies is its genres (overridden below) and its Watch On (forced to Streaming, below).
function pickListedStreamingFilm(owner, excludeId){
  const m = E.MOVIES.find(x => E.primaryStatus(x) === "included_streaming" && !E.watched.has(x.tmdb_id)
    && !E.blocked.has(x.tmdb_id) && x.tmdb_id !== excludeId && E.listedBy(x, owner));
  if(!m) throw new Error("no listed streaming film in the harness catalogue — this test would prove nothing");
  return m;
}
// Forces a film's Watch On to Streaming, the way withStreamWatchOn in cas1235-also-show-default.test.mjs
// does, but returns a restore function instead of scoping the override to a single callback — this test
// needs two films forced to Streaming at once, for the duration of several assertions.
function forceStreamWatchOn(film){
  const e = E.entryFor(film.tmdb_id);
  e.wins = e.wins || {};
  e.winsSource = e.winsSource || {};
  const savedWins = { ...e.wins };
  const savedSrc = { ...e.winsSource };
  e.wins.stream = true;
  e.winsSource.stream = "manual";
  return () => { e.wins = savedWins; e.winsSource = savedSrc; };
}

// ---- AC1: filmPassesStylesOff itself -----------------------------------------------------------

test("CAS-1256 AC1: filmPassesStylesOff — off empty never rejects", () => {
  assert.equal(E.filmPassesStylesOff({ genres: ["Comedy"] }, new Set()), true);
  assert.equal(E.filmPassesStylesOff({ genres: [] }, new Set()), true);
  assert.equal(E.filmPassesStylesOff({}, new Set()), true);
});

test("CAS-1256 AC1: filmPassesStylesOff — every style off except Action", () => {
  const off = new Set(["Adventure", "Comedy", "Drama", "Horror", "Thriller"]);
  assert.equal(E.filmPassesStylesOff({ genres: ["Action", "Adventure"] }, off), true);
  assert.equal(E.filmPassesStylesOff({ genres: ["Horror", "Action", "Thriller"] }, off), true);
  assert.equal(E.filmPassesStylesOff({ genres: ["Comedy"] }, off), false);
  assert.equal(E.filmPassesStylesOff({ genres: ["Comedy", "Drama"] }, off), false);
  assert.equal(E.filmPassesStylesOff({ genres: [] }, off), false);
  assert.equal(E.filmPassesStylesOff({}, off), false);
});

test("CAS-1256 AC1: filmPassesStylesOff — only Horror off", () => {
  const off = new Set(["Horror"]);
  assert.equal(E.filmPassesStylesOff({ genres: ["Horror", "Thriller"] }, off), true);
  assert.equal(E.filmPassesStylesOff({ genres: ["Horror"] }, off), false);
});

// ---- AC2: the real list, through watchVisibleRows() ---------------------------------------------

test("CAS-1256 AC2: on the Streaming stage, only Action on shows a film carrying Action anywhere and hides one that doesn't", () => {
  const owner = broadCascade("cas1256-ac2", 0);
  E.cascades.push(owner);
  E.recomputeFound();
  const savedTab = E.watchTab;
  const savedOff = new Set(E.watchGenreOff.stream);
  const savedMoodSel = E.watchMoodSel;
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  E.setWatchTab("stream");
  // The default mood ("Top scores") keeps only the best 10 by cascadeScore (CAS-1247 7th requeue) — unrelated
  // to this ticket's Styles rule, but it would otherwise cap the 219-film candidate pool below this test's
  // two seeded films. CAS-1328 turned the other built-in mood ("Releases", the old top:false precedent
  // CAS-1247 used) into Latest — a catalogue-sourced mood restricted to recent cinema releases, no longer a
  // generic uncapped agents-mode mood — so this pushes its own uncapped agents-sourced mood instead.
  const uncappedMood = { ...E.moodDefaultFieldsNow(), id: "t-cas1256-uncapped", name: "Test", order: "score", topYou: null, topPublic: null };
  E.watchMoods.push(uncappedMood);
  E.window.setWatchMood(uncappedMood.id);
  // CAS-753's mine-only default hides any film the guest harness has no configured service for — both
  // seeded films carry a streaming offer, so this is CAS-1222/CAS-1234's own established way to reach
  // past it, not something this ticket's own behaviour touches.
  const savedMineOnly = E.watchMineOnlyOn();
  if(savedMineOnly) E.window.toggleWatchMineOnly();
  try{
    const filmX = pickListedStreamingFilm(owner);
    const filmY = pickListedStreamingFilm(owner, filmX.tmdb_id);
    const savedGenresX = filmX.genres, savedGenresY = filmY.genres;
    filmX.genres = ["Horror", "Action"];
    filmY.genres = ["Comedy", "Drama"];
    const restoreX = forceStreamWatchOn(filmX);
    const restoreY = forceStreamWatchOn(filmY);

    const allStyles = [...new Set(E.MOVIES.flatMap(m => m.genres || []))];
    E.watchGenreOff.stream = new Set(allStyles.filter(g => g !== "Action"));

    const onlyAction = E.watchVisibleRows().rows.map(m => m.tmdb_id);
    assert.ok(onlyAction.includes(filmX.tmdb_id),
      "AC2: a film carrying Action anywhere among its styles must show with only Action on");
    assert.ok(!onlyAction.includes(filmY.tmdb_id),
      "AC2: a film carrying none of the on styles must not show");

    E.watchGenreOff.stream.clear();
    const cleared = E.watchVisibleRows().rows.map(m => m.tmdb_id);
    assert.ok(cleared.includes(filmX.tmdb_id) && cleared.includes(filmY.tmdb_id),
      "AC2: clearing Styles off must bring both films back");

    filmX.genres = savedGenresX;
    filmY.genres = savedGenresY;
    restoreX(); restoreY();
  } finally{
    if(savedMoodSel !== E.watchMoodSel) E.window.setWatchMood(savedMoodSel);
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
    E.watchGenreOff.stream = savedOff;
    if(savedMineOnly !== E.watchMineOnlyOn()) E.window.toggleWatchMineOnly();
    E.setWatchTab(savedTab);
    unseedCascade(owner.id);
  }
});

// ---- AC3: the built index.html reflects the fix, not the old any-off rule ------------------------

test("CAS-1256 AC3: the built index.html calls filmPassesStylesOff 3 times, drops the old off-rule, and reads every catalogue style once", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const count = needle => html.split(needle).length - 1;

  assert.equal(count("filmPassesStylesOff(m, genreOff)"), 3,
    "AC3: filmPassesStylesOff(m, genreOff) must be called exactly 3 times");
  assert.equal(count("!(m.genres||[]).some(g=>genreOff.has(g))"), 0,
    "AC3: the old any-style-off rule must be gone");
  assert.equal(count("? [...ONB_GENRES].sort((a,b)=>a.localeCompare(b))"), 1,
    "AC3 (CAS-1288): the Mood sheet's style chips for Everything must be built from every catalogue style exactly once");
});

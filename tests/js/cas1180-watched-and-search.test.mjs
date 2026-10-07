// CAS-1180: setOpinion() clears every Watch On rung the moment a verdict is given (CAS-788), so a watched
// film's filmNotifyState(id).key is always empty — filmMatchesWatchTab used that same (now-empty) key to
// decide which non-Cinema tab a film belongs to, so a verdict film could never again pass the tab-scope
// test and was invisible on Rental/Streaming/Premium no matter what its Watched chip said. Fix: a taggedOut
// film's tab is read off primaryStatus (the window it stands in NOW) instead of the key. AC1/AC2 below are
// the tests the ticket itself asks for, fixture-driven the same way cas1146's owner test is; AC3-6 (the
// rendered stub/search checks) live in tests/e2e/smoke.spec.mjs per the ticket's own instruction.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function seedCascade(id, order){
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = id; c.order = order; c.paused = false; c.name = id;
  return c;
}
function withTestCascades(list, fn){
  const saved = E.cascades.slice();
  E.cascades.length = 0;
  list.forEach(c => E.cascades.push(c));
  try { fn(); } finally { E.cascades.length = 0; saved.forEach(c => E.cascades.push(c)); }
}
// Clones a real catalogue film so every incidental field other predicates read stays valid — only tmdb_id
// and status are overridden, same technique cas1146's cloneStreamingFilm uses.
let cloneSeq = 0;
function plantFilm(status){
  const donor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id));
  assert.ok(donor, "no unwatched film in the harness catalogue to clone — this test would prove nothing");
  cloneSeq++;
  const id = -1180000000 - cloneSeq;
  const film = { ...donor, tmdb_id: id, status: [status], cinema_date: null };
  E.MOVIES.push(film);
  return id;
}
function unplantFilm(id){
  const i = E.MOVIES.findIndex(m => m.tmdb_id === id);
  if (i !== -1) E.MOVIES.splice(i, 1);
  delete E.notify[id];
}
// Same wiring cas1146's wireFilm uses: pinnedTo (so the real listedBy() admits it against a status:[] agent
// trivially, the pinnedInto path's inScope/listWindowOK both passing) and cascadeIds (filmOwnerCascade's own
// read).
function wireFilm(id, cascadeId){
  E.notify[id] = {
    source: "auto", cascadeIds: [cascadeId], pinnedTo: [cascadeId], notIn: [],
    wins: { in_cinema: false, premium: false, rent: false, stream: false },
    winsSource: {},
  };
}
// The real render() pipeline's own "is this row actually on screen" test, minus the Picked by/Styles/
// mineOnly steps (left at their defaults throughout this file) — same shape as render()'s own
// `rows.filter(m=>filmMatchesWatchedFilter(m) || heldThisTab.has(m.tmdb_id))` line.
function visibleOn(tab){
  return E.watchScopeRows()
    .filter(m => E.filmMatchesWatchedFilter(m) || E.watchHeldOpen[tab].has(m.tmdb_id))
    .map(m => m.tmdb_id);
}

test("CAS-1180 AC1: a verdict film standing in Streaming shows there once its own chip is on, and not before", () => {
  const a = seedCascade("cas1180-a", 0);
  const savedTab = E.watchTab;
  withTestCascades([a], () => {
    const id = plantFilm("included_streaming");
    wireFilm(id, a.id);
    const film = E.MOVIES.find(m => m.tmdb_id === id);
    E.setOpinion(id, "enjoyed");
    E.watchHeldOpen.stream.clear();   // AC1: the held-this-visit hold is cleared — not what's on screen here
    E.setWatchTab("stream");
    E.watchAgentOff.clear();
    try {
      assert.ok(E.taggedOut(film), "setup: the film must carry a verdict");
      assert.equal(E.opinionOf(id), "enjoyed", "setup: the verdict must be enjoyed");
      assert.ok(E.filmMatchesWatchTab(film, "stream"),
        "AC1: a verdict film must still belong to the tab of the window it stands in now");

      assert.ok(!visibleOn("stream").includes(id), "AC1: hidden while no Watched chip is on");
      E.watchWatchedSel.stream.add("enjoyed");
      assert.ok(visibleOn("stream").includes(id), "AC1: shown once the Enjoyed chip is switched on");
      E.watchWatchedSel.stream.delete("enjoyed");
      assert.ok(!visibleOn("stream").includes(id), "AC1: hidden again once the chip is switched back off");
    } finally {
      E.watchWatchedSel.stream.clear();
      E.watchAgentOff.clear();
      E.watchHeldOpen.stream.clear();
      E.setWatchTab(savedTab);
      E.setOpinion(id, "enjoyed");   // setOpinion's own on/off toggle — undoes the verdict before unplanting
      unplantFilm(id);
    }
  });
});

test("CAS-1180 AC2: a verdict film standing in Rental belongs to Rental's rows, not Streaming's", () => {
  const a = seedCascade("cas1180-b", 0);
  const savedTab = E.watchTab;
  withTestCascades([a], () => {
    const id = plantFilm("rental");
    wireFilm(id, a.id);
    const film = E.MOVIES.find(m => m.tmdb_id === id);
    E.setOpinion(id, "enjoyed");
    E.watchHeldOpen.rent.clear();
    E.watchAgentOff.clear();
    try {
      assert.ok(E.filmMatchesWatchTab(film, "rent"), "AC2: belongs to Rental, the window it stands in now");
      assert.ok(!E.filmMatchesWatchTab(film, "stream"), "AC2: does not also belong to Streaming");

      E.setWatchTab("rent");
      assert.ok(!visibleOn("rent").includes(id), "AC2: hidden on Rental while no chip is on");
      E.watchWatchedSel.rent.add("enjoyed");
      assert.ok(visibleOn("rent").includes(id), "AC2: shown on Rental once its own chip is on");

      E.setWatchTab("stream");
      assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === id), "AC2: never in Streaming's rows at all");
    } finally {
      E.watchWatchedSel.rent.clear();
      E.watchAgentOff.clear();
      E.watchHeldOpen.rent.clear();
      E.setWatchTab(savedTab);
      E.setOpinion(id, "enjoyed");
      unplantFilm(id);
    }
  });
});

// Part D (search spans every tab/window and ignores Picked by/Watched/Styles/Also show/Agents to include) —
// not one of the two AC1/AC2 fixture tests the ticket names, but watchSearchRows is new, pure logic this
// file already has the fixtures for, so it is covered alongside them rather than only through the rendered
// e2e checks (AC4/AC5) in tests/e2e/smoke.spec.mjs.
test("CAS-1180 Part D: watchSearchRows spans every tab/window and ignores Styles/Watched/Agents to include", () => {
  const a = seedCascade("cas1180-c", 0);
  const savedTab = E.watchTab;
  withTestCascades([a], () => {
    const idRental = plantFilm("rental");
    wireFilm(idRental, a.id);
    const filmRental = E.MOVIES.find(m => m.tmdb_id === idRental);
    filmRental.title = "Cas1180 Search Rental Title";
    const idVerdict = plantFilm("included_streaming");
    wireFilm(idVerdict, a.id);
    const filmVerdict = E.MOVIES.find(m => m.tmdb_id === idVerdict);
    filmVerdict.title = "Cas1180 Search Verdict Title";
    E.setOpinion(idVerdict, "enjoyed");
    E.watchHeldOpen.stream.clear();
    E.setWatchTab("stream");
    E.watchGenreOff.stream.add((filmRental.genres || [])[0] || "Action");
    E.watchAgentOff.add(a.id);   // "Agents to include" narrowed to no agents at all on this tab
    try {
      assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === idRental),
        "setup: the ordinary tab scope must exclude the Rental film from Streaming");
      assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === idVerdict),
        "setup: Agents to include narrowed to none must exclude the verdict film from the ordinary scope too");

      const found = E.watchSearchRows("cas1180 search").map(m => m.tmdb_id);
      assert.ok(found.includes(idRental), "AC5: search finds a film belonging to a different tab");
      assert.ok(found.includes(idVerdict), "AC4: search finds a film carrying a verdict, ignoring Watched");
      assert.ok(E.taggedOut(filmVerdict), "setup: the found film must actually carry a verdict");
    } finally {
      E.watchGenreOff.stream.clear();
      E.watchAgentOff.clear();
      E.watchHeldOpen.stream.clear();
      E.setWatchTab(savedTab);
      E.setOpinion(idVerdict, "enjoyed");
      unplantFilm(idRental);
      unplantFilm(idVerdict);
    }
  });
});

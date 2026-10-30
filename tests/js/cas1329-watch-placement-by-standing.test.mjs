// CAS-1329 (Lee, 22 Oct 2026): a film is listed only under the stage it is actually in NOW — Watch On is
// information on the card, not a placement. filmMatchesWatchTab (app_template.html) now tests primaryStatus
// alone, never filmNotifyState's Watch On key, and the "tagged for <stage>" early sections/Also-show
// widening this ticket retires are gone with it. AC1a-c below are the ticket's own fixture tests; AC1d
// checks the stage-button/section-count invariant (CAS-1301) still holds now that a stage's rows can never
// be inflated by a film merely tagged for it.
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
// Clones a real catalogue film (same technique cas1146/cas1180 use) so every incidental field other
// predicates read stays valid — only tmdb_id and status are overridden.
let cloneSeq = 0;
function plantFilm(status){
  const donor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id));
  assert.ok(donor, "no unwatched film in the harness catalogue to clone — this test would prove nothing");
  cloneSeq++;
  const id = -1329000000 - cloneSeq;
  const film = { ...donor, tmdb_id: id, status: [status], cinema_date: null };
  E.MOVIES.push(film);
  return id;
}
function unplantFilm(id){
  const i = E.MOVIES.findIndex(m => m.tmdb_id === id);
  if (i !== -1) E.MOVIES.splice(i, 1);
  delete E.notify[id];
}
// Wires a film into notify (pinnedTo/cascadeIds, same as cas1146/cas1180's wireFilm) with a Watch On pick
// that deliberately disagrees with its standing — the exact scenario this ticket's placement rule must
// ignore.
function wireFilmWithWatchOn(id, cascadeId, watchOnKey){
  const wins = { in_cinema: false, premium: false, rent: false, stream: false };
  wins[watchOnKey] = true;
  E.notify[id] = {
    source: "auto", cascadeIds: [cascadeId], pinnedTo: [cascadeId], notIn: [],
    wins, winsSource: { [watchOnKey]: "manual" },
  };
}

test("CAS-1329 AC1a: in_cinema standing with Watch On=Streaming is in Now showing rows, not Streaming", () => {
  const a = seedCascade("cas1329-a", 0);
  const savedTab = E.watchTab, savedStage = E.watchCinemaStage;
  withTestCascades([a], () => {
    const id = plantFilm("in_cinema");
    wireFilmWithWatchOn(id, a.id, "stream");
    try {
      E.setWatchTab("in_cinema"); E.setWatchCinemaStage("in_cinema");
      assert.ok(E.watchScopeRows().some(m => m.tmdb_id === id), "AC1a: must be in Now showing rows");
      E.setWatchTab("stream");
      assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === id), "AC1a: must not be in Streaming rows");
    } finally {
      E.setWatchTab(savedTab); E.setWatchCinemaStage(savedStage);
      unplantFilm(id);
    }
  });
});

test("CAS-1329 AC1b: upcoming standing with Watch On=Streaming is in Upcoming rows, not Streaming", () => {
  const a = seedCascade("cas1329-b", 0);
  const savedTab = E.watchTab, savedStage = E.watchCinemaStage;
  withTestCascades([a], () => {
    const id = plantFilm("upcoming");
    wireFilmWithWatchOn(id, a.id, "stream");
    try {
      E.setWatchTab("in_cinema"); E.setWatchCinemaStage("upcoming");
      assert.ok(E.watchScopeRows().some(m => m.tmdb_id === id), "AC1b: must be in Upcoming rows");
      E.setWatchTab("stream");
      assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === id), "AC1b: must not be in Streaming rows");
    } finally {
      E.setWatchTab(savedTab); E.setWatchCinemaStage(savedStage);
      unplantFilm(id);
    }
  });
});

test("CAS-1329 AC1c: included_streaming standing with Watch On=Cinema/Rental is in Streaming rows only", () => {
  const a = seedCascade("cas1329-c", 0);
  const savedTab = E.watchTab, savedStage = E.watchCinemaStage;
  withTestCascades([a], () => {
    const id = plantFilm("included_streaming");
    wireFilmWithWatchOn(id, a.id, "in_cinema");
    try {
      E.setWatchTab("stream");
      assert.ok(E.watchScopeRows().some(m => m.tmdb_id === id), "AC1c: must be in Streaming rows");
      E.setWatchTab("in_cinema"); E.setWatchCinemaStage("in_cinema");
      assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === id), "AC1c: must not be in Now showing rows");
      E.setWatchCinemaStage("upcoming");
      assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === id), "AC1c: must not be in Upcoming rows");
      E.setWatchTab("rent");
      assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === id), "AC1c: must not be in Rental rows");
    } finally {
      E.setWatchTab(savedTab); E.setWatchCinemaStage(savedStage);
      unplantFilm(id);
    }
  });
});

test("CAS-1329 AC1d: every stage's button count equals the number of rows that stage actually lists", () => {
  const savedTab = E.watchTab, savedStage = E.watchCinemaStage;
  try {
    E.watchStageStopsNow().forEach(stop => {
      E.setWatchTab(stop.tabKey);
      if(stop.tabKey === "in_cinema") E.setWatchCinemaStage(stop.key === "upcoming" ? "upcoming" : "in_cinema");
      const { rows } = E.watchVisibleRows();
      assert.equal(E.watchStageCountFor(stop), rows.length,
        `AC1d: stop "${stop.key}" must count exactly the rows it lists, never more`);
    });
  } finally {
    E.setWatchTab(savedTab); E.setWatchCinemaStage(savedStage);
  }
});

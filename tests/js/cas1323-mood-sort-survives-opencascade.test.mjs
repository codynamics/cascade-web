// CAS-1323: applyCascade used to end every call (openCascade, the two agent create/duplicate paths, and
// boot) by stamping filt.sort/sortPicked from the opened agent's own criteria.sort — so opening an agent
// while a Watch mood was selected silently overrode the mood's own sort and regrouped the listing back
// into per-agent lanes (sortPicked false). Lee's decision (21 Oct 2026): agents carry no sort order; Watch
// order comes from the selected mood alone. Fix: applyCascade no longer touches filt.sort/sortPicked —
// applyMoodToState (run at mood-select time, and once at boot) is their sole owner.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function daysAfterToday(E, n){
  const d = new Date(Date.parse(E.TODAY));
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
// status:[]/imdb:10.1 agents admit nothing by criteria (imdb is above the real 0-10 scale) — ownership
// in AC3 below is wired entirely through notify[id].pinnedTo, the same synthetic-agent technique
// CAS-793/CAS-1146's own owner tests use. Only .order (agent rank) matters for this ticket.
function seedCascade(E, id, order){
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = id; c.order = order; c.paused = false; c.name = id;
  return c;
}
// Clones a real catalogue film so every incidental field other code reads stays valid — only tmdb_id,
// status and cinema_date are overridden, forcing the clone to stand purely in "upcoming" with a controlled
// release date.
let cloneSeq = 0;
function cloneUpcomingFilm(E, cinemaDate){
  const donor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id) && !E.blocked.has(m.tmdb_id));
  assert.ok(donor, "no unwatched/unblocked film in the harness catalogue to clone — this test would prove nothing");
  cloneSeq++;
  const id = -1323000000 - cloneSeq;
  const film = { ...donor, tmdb_id: id, status: ["upcoming"], cinema_date: cinemaDate, estimated: false };
  E.MOVIES.push(film);
  return id;
}
function unplantFilm(E, id){
  const i = E.MOVIES.findIndex(m => m.tmdb_id === id);
  if (i !== -1) E.MOVIES.splice(i, 1);
  delete E.notify[id];
}
function withMoodAndCascades(E, mood, cascadeList, fn){
  const savedCascades = E.cascades.slice();
  const savedMoods = [...E.watchMoods];
  const savedSel = E.watchMoodSel;
  E.cascades.length = 0; cascadeList.forEach(c => E.cascades.push(c));
  E.watchMoods.push(mood);
  E.window.setWatchMood(mood.id);
  try { fn(); }
  finally {
    E.cascades.length = 0; savedCascades.forEach(c => E.cascades.push(c));
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
    if (E.watchMoods.some(m => m.id === savedSel)) E.window.setWatchMood(savedSel);
  }
}
// Mirrors the real "Releases" built-in mood (sort:"release") — translates to filt.sort:"cinema" in
// applyMoodToState, with sortPicked forced true.
function releasesStyleMood(E, id){
  return { ...E.moodDefaultFieldsNow(), id, name: "Releases test", order: "release", sort: "release",
    topYou: null, topPublic: null };
}

test("CAS-1323 AC2: openCascade must not touch filt.sort/sortPicked once a mood has set them", () => {
  const E = loadEngine();
  const a = seedCascade(E, "cas1323-a2", 0);
  withMoodAndCascades(E, releasesStyleMood(E, "t-1323-ac2"), [a], () => {
    assert.equal(E.filt.sort, "cinema", "setup: the Releases-style mood must set filt.sort to the release-date key");
    assert.equal(E.sortPicked, true, "setup: applyMoodToState must leave sortPicked true");
    E.window.openCascade(a.id, false);
    assert.equal(E.filt.sort, "cinema", "AC2: opening an agent must not change filt.sort away from the mood's own pick");
    assert.equal(E.sortPicked, true, "AC2: opening an agent must not flip sortPicked back to false");
  });
});

test("CAS-1323 AC3: after opening an agent, the Watch listing is one flat run ordered by the mood's sort, not grouped by agent rank", () => {
  const E = loadEngine();
  const a = seedCascade(E, "cas1323-a3", 0);   // lower order -> would lead a per-agent-lanes sort
  const b = seedCascade(E, "cas1323-b3", 1);
  withMoodAndCascades(E, releasesStyleMood(E, "t-1323-ac3"), [a, b], () => {
    // idEarly is owned by the lower-order agent (a) but releases SOONER than idLate (owned by the
    // higher-order b) — release order and agent-rank order disagree, so the two behaviours produce
    // different listings and this test can tell them apart.
    const idEarly = cloneUpcomingFilm(E, daysAfterToday(E, 10));
    const idLate = cloneUpcomingFilm(E, daysAfterToday(E, 40));
    E.notify[idEarly] = { source: "auto", cascadeIds: [a.id], pinnedTo: [a.id], notIn: [] };
    E.notify[idLate] = { source: "auto", cascadeIds: [b.id], pinnedTo: [b.id], notIn: [] };
    try {
      const filmEarly = E.MOVIES.find(m => m.tmdb_id === idEarly);
      const filmLate = E.MOVIES.find(m => m.tmdb_id === idLate);
      assert.equal(E.filmOwnerCascade(filmEarly).id, a.id, "setup: a must own the sooner-release film");
      assert.equal(E.filmOwnerCascade(filmLate).id, b.id, "setup: b must own the later-release film");

      E.window.openCascade(a.id, false);   // CAS-1323's trigger: opening an agent used to reset the sort
      assert.equal(E.sortPicked, true, "setup: the mood's sort must have survived opening the agent");

      const groups = E.listingGroups([filmEarly, filmLate], null);
      const upcoming = groups.find(g => g.g === "upcoming");
      assert.ok(upcoming, "setup: both films must land in the upcoming group");
      // CAS-1325: Upcoming reads soonest release first, so idEarly leads — agent rank (a owns idEarly,
      // the lower order) never enters it, which is the behaviour this assertion is actually checking.
      assert.deepEqual([...upcoming.items].map(m => m.tmdb_id), [idEarly, idLate],
        "AC3: a flat release-date run — the sooner release leads, agent rank never enters it");
    } finally {
      unplantFilm(E, idEarly); unplantFilm(E, idLate);
    }
  });
});

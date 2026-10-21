// CAS-1325: the mood sort "Release date" (filt.sort:"cinema", the key applyMoodToState derives from a mood
// whose sort is "release" — see CAS-1296) used to pick Upcoming's direction off the OPEN AGENT's kind
// (sortForKey's own `cinema` flag), so opening a non-cinema agent flipped Upcoming from soonest-first to
// furthest-out-first even though filt.sort never changed — the exact bug cas1323's own AC3 fixture
// unintentionally baked in as "expected" (fixed alongside this ticket). Lee's decision (21 Oct 2026):
// Release date orders every stage by cinema_date alone — Upcoming ascending, every other stage descending,
// no-date films last by title, ties broken by title — and the order never depends on which agent is open.
// Fix: byCinemaDate (sortForKey) and listingGroups' own tie-break now read isUserSort/title, never the open
// agent's kind or filmOwnerOrder, for an explicit "cinema" pick.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// Raw literal films, same technique as tests/js/data-integrity.test.mjs's cinemaFilm/upcomingFilm — never
// inserted into MOVIES, so no ownership and no catalogue side effects; only sortForKey's title/cinema_date
// reads and primaryStatus's status read matter for AC1/AC2.
const upcomingFilm = (title, cinema_date) => ({ title, status: ["upcoming"], cinema_date });
const streamingFilm = (title, cinema_date) => ({ title, status: ["included_streaming"], cinema_date });

// watchTab:"stream" reads the same CASCADE journey order as "in_cinema" (CAS-750/CAS-754) but, unlike
// "in_cinema", is never subject to CAS-1309's "Next week" split of the Upcoming group — so these tests'
// hardcoded dates can't accidentally straddle that split depending on the real wall-clock date.
function withReleaseSort(E, fn){
  const sortBefore = E.filt.sort;
  const pickedBefore = E.sortPicked;
  const tabBefore = E.watchTab;
  E.filt.sort = "cinema";
  E.setSortPicked(true);
  E.setWatchTab("stream");
  try { fn(); }
  finally { E.filt.sort = sortBefore; E.setSortPicked(pickedBefore); E.setWatchTab(tabBefore); }
}

function upcomingTitles(E, films, ac){
  const groups = E.listingGroups(films, ac);
  const upcoming = groups.find(g => g.g === "upcoming" || g.g === "upcoming_soon");
  return upcoming ? [...upcoming.items].map(m => m.title) : [];
}

test("CAS-1325 AC1: Upcoming reads soonest cinema date first under Release date, whatever agent is open", () => {
  const E = loadEngine();
  withReleaseSort(E, () => {
    const films = [
      upcomingFilm("Late", "2026-11-26"),
      upcomingFilm("Soonest", "2026-10-29"),
      upcomingFilm("Mid", "2026-12-16"),
    ];
    const expected = ["Soonest", "Late", "Mid"];
    assert.deepEqual(upcomingTitles(E, films, { kind: "cinema" }), expected,
      "AC1: with a cinema agent open, Upcoming must read soonest release first");
    assert.deepEqual(upcomingTitles(E, films, { kind: "stream" }), expected,
      "AC1: with a non-cinema agent open, Upcoming must still read soonest release first");
    assert.deepEqual(upcomingTitles(E, films, null), expected,
      "AC1: with no agent open, Upcoming must still read soonest release first");
  });
});

test("CAS-1325 AC2: Streaming-standing films read most-recent cinema date first, with no-date last", () => {
  const E = loadEngine();
  withReleaseSort(E, () => {
    const films = [
      streamingFilm("Mid", "2025-03-01"),
      streamingFilm("Newest", "2026-01-10"),
      streamingFilm("Oldest", "2024-07-04"),
      streamingFilm("NoDate", null),
    ];
    const groups = E.listingGroups(films, { kind: "stream" });
    const stream = groups.find(g => g.g === "included_streaming");
    assert.ok(stream, "setup: the Streaming group must be present");
    assert.deepEqual([...stream.items].map(m => m.title), ["Newest", "Mid", "Oldest", "NoDate"],
      "AC2: most recent cinema date first, a film with no cinema date last");
  });
});

// status:[]/imdb:10.1 agents admit nothing by criteria — the same synthetic-agent technique
// CAS-1323/CAS-793/CAS-1146's own owner tests use. Only .order (agent rank) matters for this ticket.
function seedCascade(E, id, order){
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = id; c.order = order; c.paused = false; c.name = id;
  return c;
}
let cloneSeq = 0;
function cloneUpcomingFilm(E, title, cinemaDate){
  const donor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id) && !E.blocked.has(m.tmdb_id));
  assert.ok(donor, "no unwatched/unblocked film in the harness catalogue to clone — this test would prove nothing");
  cloneSeq++;
  const id = -1325000000 - cloneSeq;
  const film = { ...donor, tmdb_id: id, title, status: ["upcoming"], cinema_date: cinemaDate, estimated: false };
  E.MOVIES.push(film);
  return id;
}
function unplantFilm(E, id){
  const i = E.MOVIES.findIndex(m => m.tmdb_id === id);
  if (i !== -1) E.MOVIES.splice(i, 1);
  delete E.notify[id];
}

test("CAS-1325 AC3: two films sharing a cinema date list in title order, never by owning agent rank", () => {
  const E = loadEngine();
  withReleaseSort(E, () => {
    const savedCascades = E.cascades.slice();
    // lowOrder (rank 0, would lead a rank-first tiebreak) owns the alphabetically LATER title; highOrder
    // (rank 1) owns the alphabetically EARLIER one — rank order and title order disagree, so the fixture
    // can tell the two behaviours apart.
    const lowOrder = seedCascade(E, "cas1325-low", 0);
    const highOrder = seedCascade(E, "cas1325-high", 1);
    E.cascades.length = 0; E.cascades.push(lowOrder, highOrder);
    const idZeta = cloneUpcomingFilm(E, "Zeta", "2026-11-01");
    const idAlpha = cloneUpcomingFilm(E, "Alpha", "2026-11-01");
    E.notify[idZeta] = { source: "auto", cascadeIds: [lowOrder.id], pinnedTo: [lowOrder.id], notIn: [] };
    E.notify[idAlpha] = { source: "auto", cascadeIds: [highOrder.id], pinnedTo: [highOrder.id], notIn: [] };
    try {
      const filmZeta = E.MOVIES.find(m => m.tmdb_id === idZeta);
      const filmAlpha = E.MOVIES.find(m => m.tmdb_id === idAlpha);
      assert.equal(E.filmOwnerCascade(filmZeta).id, lowOrder.id, "setup: the lower-rank agent must own Zeta");
      assert.equal(E.filmOwnerCascade(filmAlpha).id, highOrder.id, "setup: the higher-rank agent must own Alpha");

      assert.deepEqual(upcomingTitles(E, [filmZeta, filmAlpha], null), ["Alpha", "Zeta"],
        "AC3: a tied cinema date must list in title order, not by owning agent rank");
    } finally {
      unplantFilm(E, idZeta); unplantFilm(E, idAlpha);
      E.cascades.length = 0; savedCascades.forEach(c => E.cascades.push(c));
    }
  });
});

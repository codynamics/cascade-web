// CAS-1240: the Watch bar's two-way sort switch lied on the Cinema tab. Its default sort there
// (listingGroups' own tabDflt, CAS-713) is "availability" — not DEFAULT_SORT ("cascade") — so the switch,
// which only ever read raw filt.sort, kept the "Cascade score" half lit while the list itself rendered
// release-date order. Worse: tapping "Cascade score" set filt.sort to DEFAULT_SORT's own value, which
// PICKER_KINDS.sort.pick (CAS-819) read as "choosing the default back" and left sortPicked false — so that
// tap could never actually reach the list on the one tab where it was the only way to leave the default.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// Lee's own fixture, reused from the CAS-819/CAS-702 test below it: cinema dates ascend 8 Jul / 23 Jul /
// 6 Aug, while buzz-percentile (Cascade score) order does not — so the two sorts can never agree by chance.
const cinemaFilm = (title, cinema_date, popularity) =>
  ({ title, status: ["in_cinema"], cinema_date, popularity, rt_critic: null, imdb_rating: null, imdb_votes: 0 });

test("CAS-1240 AC1/AC3: Cinema tab with no pick shows Release date ↑ selected, matching the rendered order", () => {
  const savedTab = E.watchTab, savedPicked = E.sortPicked, savedSort = E.filt.sort;
  try{
    E.setWatchTab("in_cinema");
    E.setSortPicked(false);
    const halves = E.watchSortSwitchHalves();
    assert.equal(halves.cinema.on, true, "the Release date half should be the one lit with nothing picked");
    assert.equal(halves.cascade.on, false, "Cascade score must not read as selected when the list isn't sorted by it");
    assert.equal(halves.cinema.label, "Release date ↑", "Release date's own arrow should read ascending (soonest first) on the in_cinema tab");

    const films = [
      cinemaFilm("Moana", "2026-07-08", 1),
      cinemaFilm("Motor City", "2026-07-23", 0.1),
      cinemaFilm("Spider-Man: Brand New Day", "2026-08-06", 10),
    ];
    const rendered = [...E.listingGroups(films, { kind: "cinema" }).flatMap(({ items }) => [...items]).map(m => m.title)];
    assert.deepEqual(rendered, ["Moana", "Motor City", "Spider-Man: Brand New Day"],
      `the switch claims Release date but the list rendered ${rendered.join(", ")}`);
  } finally {
    E.setWatchTab(savedTab);
    E.setSortPicked(savedPicked);
    E.filt.sort = savedSort;
  }
});

test("CAS-1240 AC2: on the Cinema tab, pick('cascade') reaches the list (descending score); pick('cinema') un-does it", () => {
  const savedTab = E.watchTab, savedPicked = E.sortPicked, savedSort = E.filt.sort;
  try{
    E.setWatchTab("in_cinema");
    E.setSortPicked(false);
    const ac = { kind: "cinema" };
    const films = [
      cinemaFilm("Moana", "2026-07-08", 1),
      cinemaFilm("Motor City", "2026-07-23", 0.1),
      cinemaFilm("Spider-Man: Brand New Day", "2026-08-06", 10),
    ];

    E.PICKER_KINDS.sort.pick("cascade");
    assert.equal(E.sortPicked, true, "tapping Cascade score must count as a real pick, even though it equals DEFAULT_SORT");
    assert.equal(E.watchSortSwitchHalves().cascade.on, true, "the switch should now show Cascade score selected");
    const byScore = [...E.listingGroups(films, ac).flatMap(({ items }) => [...items]).map(m => m.title)];
    assert.deepEqual(byScore, ["Spider-Man: Brand New Day", "Moana", "Motor City"],
      `Cascade score should read highest buzz percentile first — got ${byScore.join(", ")}`);

    E.PICKER_KINDS.sort.pick("cinema");
    assert.equal(E.sortPicked, true, "tapping Release date is still an explicit pick");
    assert.equal(E.watchSortSwitchHalves().cinema.on, true, "the switch should now show Release date selected");
    const byRelease = [...E.listingGroups(films, ac).flatMap(({ items }) => [...items]).map(m => m.title)];
    const expected = [...E.listingOrder(films, "cinema", ac, true).map(m => m.title)];
    assert.deepEqual(byRelease, expected,
      `the explicit Release date pick should read the same order sortForKey('cinema') itself produces — got ${byRelease.join(", ")}`);
    assert.notDeepEqual(byRelease, byScore, "tapping back to Release date must actually change the list, not leave it on the score order");
  } finally {
    E.setWatchTab(savedTab);
    E.setSortPicked(savedPicked);
    E.filt.sort = savedSort;
  }
});

test("CAS-1240 AC3: on a released tab (Rent), Release date reads newest-first (↓); Cascade score stays ↓ everywhere", () => {
  const savedTab = E.watchTab, savedPicked = E.sortPicked, savedSort = E.filt.sort;
  try{
    E.setWatchTab("rent");
    E.setSortPicked(false);
    let halves = E.watchSortSwitchHalves();
    assert.equal(halves.cascade.on, true, "Rent's own default is still Cascade score with nothing picked");
    assert.equal(halves.cascade.label, "Cascade score ↓");
    assert.equal(halves.cinema.on, false);

    E.PICKER_KINDS.sort.pick("cinema");
    halves = E.watchSortSwitchHalves();
    assert.equal(halves.cinema.on, true, "an explicit Release date pick should light that half on every tab");
    assert.equal(halves.cinema.label, "Release date ↓", "Release date reads newest-first on a released tab, not the in_cinema tab's soonest-first");
    assert.equal(halves.cascade.on, false);
    assert.equal(halves.cascade.label, "Cascade score");
  } finally {
    E.setWatchTab(savedTab);
    E.setSortPicked(savedPicked);
    E.filt.sort = savedSort;
  }
});

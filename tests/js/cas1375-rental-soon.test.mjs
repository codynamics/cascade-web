// CAS-1375: a film whose cinema run has ended with no offer yet (`released` — The Odyssey, tmdb 1368337,
// cinema_date more than CINEMA_RUN_DAYS behind TODAY with no offers) used to list nowhere in Watch at all.
// Lee's decision (3 Nov 2026, option B): it now lists in Rental, in its own "Rental soon" section ahead of
// the films with a real rental offer, card capsule in the Upcoming purple with the 🎫 icon. It counts
// towards the Rental stop's own count but is excluded from a mood's Best N cut entirely (always shown, on
// top of the N rule-based films, never eating into anyone else's slot). See also cas1374-mood-show-reasons
// AC2's update (the no-stage sentence this ticket supersedes for `released`).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1375-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"t-cas1375-mood", name:"Me", ...overrides };
}
let _nextId = 91750001;
function filmWith(overrides){
  return { tmdb_id:_nextId++, title:"CAS-1375 fixture", genres:["Action"], status:["released"],
    language:"en", wm_critic_score:null, wm_user_rating:9, _fixture:true, availability_confidence:"confirmed",
    offers:[], cinema_release:true, cinema_date:"2025-01-01", ...overrides };
}
// Same device cas1374-mood-show-reasons.test.mjs uses — a v2 account's one agent and mood pool live in
// E.cascades/E.watchMoods (oamFilmShownInMood/oamWilRankInMood/oamStagePool all read those globals, not an
// argument), and the real catalogue in E.MOVIES is replaced wholesale so a rank/cut/count assertion can
// never be diluted by however many real titles the current catalogue happens to also admit.
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

// ---- AC1: Watch placement, section heading/order, sort, stop count, card capsule --------------------------

test("CAS-1375 AC1: a `released` film lists in Rental under Rental soon, newest cinema_date first, ahead of real rental offers", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ show:"all" });
  const older = filmWith({ cinema_date:"2025-01-01" });
  const newer = filmWith({ cinema_date:"2025-06-01" });
  const rented = filmWith({ status:["rental"], offers:[{service:"Prime Video", type:"rent", price:6, format:"HD"}], cinema_date:"2024-01-01" });
  withMoviesAndMoods(c, [older, newer, rented], [mood], () => {
    const savedTab = E.watchTab;
    try{
      E.setWatchTab("rent");
      const { rows } = E.watchVisibleRows();
      const groups = E.listingGroups(rows, null);
      const soonGroup = groups.find(g => g.g === "rental_soon");
      assert.ok(soonGroup, "AC1: no rental_soon section among the Rental tab's own groups");
      // Compared as a string, not deepEqual: the engine runs in a vm realm, so an array it builds (map's
      // result here) doesn't share the host's Array.prototype, and a strict deep-equal of two otherwise-
      // identical arrays fails across that boundary (same gotcha data-integrity.test.mjs's own comment notes).
      assert.equal(soonGroup.items.map(m => m.tmdb_id).join(","), [newer.tmdb_id, older.tmdb_id].join(","),
        "AC1: Rental soon must sort by cinema_date, newest first");
      assert.equal(E.watchGroupHeading("rental_soon"), "Rental soon");
      const soonIdx = groups.findIndex(g => g.g === "rental_soon");
      const rentalIdx = groups.findIndex(g => g.g === "rental");
      assert.ok(rentalIdx >= 0, "setup: the ordinary Rental section must still exist");
      assert.ok(soonIdx < rentalIdx, "AC1: Rental soon must sit ahead of the ordinary Rental section");
    } finally {
      E.setWatchTab(savedTab);
    }
  });
});

test("CAS-1375 AC1: Rental soon films count towards the Rental stop's own count", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ show:"all" });
  const soon = filmWith({});
  const rented = filmWith({ status:["rental"], offers:[{service:"Prime Video", type:"rent", price:6, format:"HD"}] });
  withMoviesAndMoods(c, [soon, rented], [mood], () => {
    const savedTab = E.watchTab;
    try{
      E.setWatchTab("rent");
      const stop = E.watchStageStopsNow().find(s => s.tabKey === "rent");
      assert.ok(stop, "setup: the Rental stop must exist");
      const { rows } = E.watchVisibleRows();
      assert.equal(E.watchStageCountFor(stop), rows.length,
        "AC1: the Rental stop's count must equal every row it actually lists, Rental soon included");
      assert.equal(E.watchStageCountFor(stop), 2, "AC1: both the Rental soon and the real-offer film must count");
    } finally {
      E.setWatchTab(savedTab);
    }
  });
});

test("CAS-1375 AC1: the card capsule reads Rental soon in the Upcoming purple, with the 🎫 icon, never In cinemas", () => {
  const film = { status: ["released"], cinema_date: "2025-01-01" };
  const html = E.bandHTML(film, "");
  assert.match(html, /w-cin-released/, "AC1: capsule must carry its own w-cin-released class");
  assert.match(html, />Rental soon<\/b>/, "AC1: capsule must read Rental soon");
  assert.match(html, /🎫/, "AC1: capsule must carry the 🎫 icon");
  assert.doesNotMatch(html, /In cinemas/, "AC1: capsule must never read In cinemas");
});

// ---- AC2: the Best N cut keeps every Rental soon film on top of its N real-rental-offer films -------------

test("CAS-1375 AC2: a Best 40 mood keeps exactly 40 real-rental-offer films plus every Rental soon film on top", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ show:"40" });
  const rentalRows = Array.from({ length: 50 }, (_, i) => filmWith({ status:["rental"], wm_user_rating: 9 - i*0.01 }));
  const soonRows = Array.from({ length: 5 }, (_, i) => filmWith({ wm_user_rating: 9.9 - i*0.001 }));
  const kept = E.oamApplyShowCap([...soonRows, ...rentalRows], mood, c, new Set());
  const keptIds = new Set(kept.map(m => m.tmdb_id));
  assert.equal(kept.length, 45, "AC2: must keep 40 real-rental-offer films plus all 5 Rental soon films");
  soonRows.forEach(m => assert.ok(keptIds.has(m.tmdb_id), "AC2: every Rental soon film must survive the cut"));
  const keptRentalCount = kept.filter(m => E.primaryStatus(m) === "rental").length;
  assert.equal(keptRentalCount, 40, "AC2: the cut must still keep exactly 40 real-rental-offer films");
});

test("CAS-1375 AC2: Find's rank-in-mood check never counts a Rental soon film as part of the ranked pool", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ show:"40" });
  // 40 real-rental decoys that outscore the target, plus the target itself — genuinely 41st among the
  // rental-offer films, 1 below the cut — with 5 Rental soon films (higher score than everything) mixed in,
  // which must never be allowed to shift that rank.
  const rentalOffer = [{ service:"Prime Video", type:"rent", price:6, format:"HD" }];
  const decoys = Array.from({ length: 40 }, (_, i) => filmWith({ status:["rental"], offers:rentalOffer, wm_user_rating: 9 - i*0.001 }));
  const target = filmWith({ status:["rental"], offers:rentalOffer, wm_user_rating: 1 });
  const soonRows = Array.from({ length: 5 }, () => filmWith({ wm_user_rating: 9.9 }));
  withMoviesAndMoods(c, [...decoys, target, ...soonRows], [mood], () => {
    const r = E.oamWilCase(target, c);
    assert.match(r.sentence, /ranks 41st, below its best 40/,
      "AC2: Rental soon films must not count as competitors for the real-offer films' own rank");
  });
});

// ---- AC3: a real rental offer moves a `released` film out of Rental soon and into ordinary Rental ---------

test("CAS-1375 AC3: once a `released` film's status resolves to rental (a real offer landed), it leaves Rental soon for the ordinary Rental section", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ show:"all" });
  const film = filmWith({});
  withMoviesAndMoods(c, [film], [mood], () => {
    const savedTab = E.watchTab;
    try{
      E.setWatchTab("rent");
      let groups = E.listingGroups(E.watchVisibleRows().rows, null);
      assert.ok(groups.find(g => g.g === "rental_soon")?.items.some(m => m.tmdb_id === film.tmdb_id),
        "setup: the released fixture must start in Rental soon");
      // deriveStatus (skipped for a `_fixture` film) would resolve this to `rental` the moment a real rental
      // offer lands — flip the fixture's own status/offers directly to the same effect.
      film.status = ["rental"];
      film.offers = [{ service:"Prime Video", type:"rent", price:6, format:"HD" }];
      groups = E.listingGroups(E.watchVisibleRows().rows, null);
      const soonGroup = groups.find(g => g.g === "rental_soon");
      assert.ok(!soonGroup || !soonGroup.items.some(m => m.tmdb_id === film.tmdb_id),
        "AC3: must leave Rental soon once it holds a real rental offer");
      const rentalGroup = groups.find(g => g.g === "rental");
      assert.ok(rentalGroup && rentalGroup.items.some(m => m.tmdb_id === film.tmdb_id),
        "AC3: must appear in the ordinary Rental section instead");
    } finally {
      E.setWatchTab(savedTab);
    }
  });
});

// ---- AC4: Find's "Where it lists" names the Rental soon stage, with a working Show in Watch button --------

test("CAS-1375 AC4: Find gives \"Listed in <mood> · Rental soon\" with a Show in Watch button", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ show:"all", name:"Best" });
  const film = filmWith({});
  withMoviesAndMoods(c, [film], [mood], () => {
    const r = E.oamWilCase(film, c);
    assert.match(r.sentence, /Listed in<\/span> <b>Best<\/b> &middot; Rental soon/);
    assert.equal(r.buttons.length, 1);
    assert.equal(r.buttons[0].label, "Show in Watch ›");
  });
});

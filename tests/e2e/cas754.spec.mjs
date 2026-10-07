// CAS-754: on the Watch screen's Streaming tab, the Upcoming section moves from last to FIRST (same
// journey order, CASCADE, the Cinema tab already reads per CAS-750), and the jump-chip rail follows it —
// no separate chip change needed, renderJumpBar walks the groups the DOM already holds. Premium and
// Rental are unchanged and still lead with LISTING_ORDER (Upcoming last).
//
// Synthetic films pinned to the same real onboarded agent (so listedBy() admits them without depending on
// catalogue-derived taste matching, same technique cas753.spec.mjs uses) and armed on the tab's own Watch
// On level by hand (winsSource "manual", same technique cas751/752/753.spec.mjs use).
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

const FILM_UPCOMING_STREAM = 900754001;
const FILM_CINEMA_STREAM = 900754002;
const FILM_RENTAL_STREAM = 900754003;
const FILM_STREAM_STREAM = 900754004;
const FILM_UPCOMING_PREMIUM = 900754005;
const FILM_OPENING_PREMIUM = 900754006;
const FILM_UPCOMING_RENT = 900754007;
const FILM_RENTAL_RENT = 900754008;
const ALL_FILMS = [
  FILM_UPCOMING_STREAM, FILM_CINEMA_STREAM, FILM_RENTAL_STREAM, FILM_STREAM_STREAM,
  FILM_UPCOMING_PREMIUM, FILM_OPENING_PREMIUM, FILM_UPCOMING_RENT, FILM_RENTAL_RENT,
];

async function toWatchScreen(page){
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  return page.evaluate(() => {
    // The onboarded agent's own status/listStatus (CAS-674/CAS-279) narrows listedBy()'s window gate to
    // whatever windows onboarding picked — this ticket's fixture pins films across every window on
    // purpose, so widen the gate the same way an "every window" agent would, leaving the per-tab
    // filmMatchesWatchTab/watchAlsoShow gate (CAS-823) as the one each test still exercises on its own.
    cascades[0].status = [];
    cascades[0].listStatus = [];
    return cascades[0].id;
  });
}

async function seedFilm(page, { cascadeId, id, title, status, level }){
  await page.evaluate(({ cascadeId, id, title, status, level }) => {
    MOVIES.push({ tmdb_id: id, title, status: [status], offers: [] });
    const e = entryFor(id);
    e.pinnedTo = [cascadeId];
    e.wins = { [level]: true };
    e.winsSource = { [level]: "manual" };
  }, { cascadeId, id, title, status, level });
}

async function toTab(page, key){
  await page.evaluate(k => setWatchTab(k), key);
  await settleListing(page);
}

const groupKeys = page => page.locator("#groups .group").evaluateAll(gs => gs.map(g => g.dataset.g));

test.afterEach(async ({ page }) => {
  await page.evaluate(ids => {
    ids.forEach(id => {
      const i = MOVIES.findIndex(m => m.tmdb_id === id);
      if(i >= 0) MOVIES.splice(i, 1);
      delete notify[id];
    });
  }, ALL_FILMS);
});

test("CAS-754 AC1: the Streaming tab leads with Upcoming, jump chips follow (Upcoming leftmost)", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilm(page, { cascadeId, id: FILM_UPCOMING_STREAM, title: "CAS-754 — Upcoming", status: "upcoming", level: "stream" });
  await seedFilm(page, { cascadeId, id: FILM_CINEMA_STREAM, title: "CAS-754 — Cinema", status: "in_cinema", level: "stream" });
  await seedFilm(page, { cascadeId, id: FILM_RENTAL_STREAM, title: "CAS-754 — Rental", status: "rental", level: "stream" });
  await seedFilm(page, { cascadeId, id: FILM_STREAM_STREAM, title: "CAS-754 — Stream", status: "included_streaming", level: "stream" });
  // CAS-823 (post-dates this spec) narrowed each tab to its own standing (included_streaming for
  // Streaming) unless the Filters sheet's Also-show set is widened — real account state, set the way the
  // Filters sheet itself would, not an app-code change.
  await page.evaluate(() => { ["upcoming", "in_cinema", "rental"].forEach(k => watchAlsoShow.stream.add(k)); render(); });
  await toTab(page, "stream");

  // CAS-1223: the jump rail (#jumpBar/.nowstop) this test used to check alongside the group order is gone
  // from the Watch screen — the stage line replaced it, and neither stage stops nor their counts claim to
  // mirror the Streaming tab's own group order the way the old rail did. Group order is still this AC's
  // real subject and stays covered.
  expect((await groupKeys(page))[0]).toBe("upcoming");
});

// CAS-855, 2026-09-08 (post-dates this spec by a day): Lee reversed CAS-237 — every listing leads with
// Upcoming again, LISTING_ORDER included, so all tabs now agree with CASCADE (app_template.html:3877-3888).
// This AC's original premise ("Premium keeps LISTING_ORDER, Upcoming last") no longer holds; the section
// SET and COUNT this ticket actually cared about are unaffected, so the AC's spirit still passes.
test("CAS-754 AC2a: the Premium tab shows both its sections (order follows CAS-855's later Upcoming-leads reversal)", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilm(page, { cascadeId, id: FILM_UPCOMING_PREMIUM, title: "CAS-754 — Upcoming (premium)", status: "upcoming", level: "premium" });
  await seedFilm(page, { cascadeId, id: FILM_OPENING_PREMIUM, title: "CAS-754 — Opening (premium)", status: "opening_week", level: "premium" });
  // Premium starts fully off (CAS-243) and, post-CAS-823, restricts to its own standing (pvod) unless
  // widened — turn the tab on and widen it the way the Where & when / Filters sheets would.
  await page.evaluate(() => {
    watchPrefs.premium = { list: true, notify: false };
    watchAlsoShow.premium.add("opening_week");
    watchAlsoShow.premium.add("upcoming");
    render();
  });
  await toTab(page, "premium");

  expect(await groupKeys(page)).toEqual(["upcoming", "opening_week"]);
});

// CAS-855 reversal (see AC2a's comment above) applies here too.
test("CAS-754 AC2b: the Rental tab shows both its sections (order follows CAS-855's later Upcoming-leads reversal)", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilm(page, { cascadeId, id: FILM_UPCOMING_RENT, title: "CAS-754 — Upcoming (rent)", status: "upcoming", level: "rent" });
  await seedFilm(page, { cascadeId, id: FILM_RENTAL_RENT, title: "CAS-754 — Rental (rent)", status: "rental", level: "rent" });
  // CAS-823 (post-dates this spec) restricts Rental to its own standing (rental) unless widened.
  await page.evaluate(() => { watchAlsoShow.rent.add("upcoming"); render(); });
  await toTab(page, "rent");

  expect(await groupKeys(page)).toEqual(["upcoming", "rental"]);
});

// CAS-1244: tapping In Cinema while Upcoming is selected (or the reverse) changed watchCinemaStage but
// never rebuilt the Watch list — CAS-1236's settled-list nav key (watchNavKey(), app_template.html) didn't
// fingerprint the Cinema stage, so render() treated the tap as a non-navigating repaint and
// reconcilePatchSettledList() left the old cards exactly where they were. Two synthetic films pinned to the
// real onboarded agent (same technique cas754.spec.mjs uses for the Cinema tab's two sub-stages), one on
// each stage, so the stage switch has something real to prove it moved.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

const FILM_UPCOMING = 900124401;
const FILM_IN_CINEMA = 900124402;
const ALL_FILMS = [FILM_UPCOMING, FILM_IN_CINEMA];

async function toWatchScreen(page){
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  return page.evaluate(() => {
    // Same widening cas754.spec.mjs's toWatchScreen uses — the onboarded agent's own window gate narrowed
    // to whatever onboarding picked, not this fixture's concern.
    cascades[0].status = [];
    cascades[0].listStatus = [];
    return cascades[0].id;
  });
}

async function seedFilm(page, { cascadeId, id, title, status }){
  await page.evaluate(({ cascadeId, id, title, status }) => {
    MOVIES.push({ tmdb_id: id, title, status: [status], offers: [] });
    const e = entryFor(id);
    e.pinnedTo = [cascadeId];
    e.wins = { in_cinema: true };
    e.winsSource = { in_cinema: "manual" };
  }, { cascadeId, id, title, status });
}

test.afterEach(async ({ page }) => {
  await page.evaluate(ids => {
    ids.forEach(id => {
      const i = MOVIES.findIndex(m => m.tmdb_id === id);
      if(i >= 0) MOVIES.splice(i, 1);
      delete notify[id];
    });
  }, ALL_FILMS);
});

test("CAS-1244 AC1: tapping In Cinema / Upcoming actually rebuilds the Watch list", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilm(page, { cascadeId, id: FILM_UPCOMING, title: "CAS-1244 — Upcoming", status: "upcoming" });
  await seedFilm(page, { cascadeId, id: FILM_IN_CINEMA, title: "CAS-1244 — In Cinema", status: "in_cinema" });
  await page.evaluate(() => { setWatchTab("in_cinema"); render(); });
  await settleListing(page);

  // Sanity required by the ticket: the account must actually list one of each stage, or the rest of this
  // test proves nothing.
  const counts = await page.evaluate(() => ({
    upcoming: Number(document.querySelector('.stagestop[data-stage="upcoming"] .stagecount')?.textContent || 0),
    inCinema: Number(document.querySelector('.stagestop[data-stage="in_cinema"] .stagecount')?.textContent || 0),
  }));
  expect(counts.upcoming, "the seeded agent must list at least one Upcoming film").toBeGreaterThanOrEqual(1);
  expect(counts.inCinema, "the seeded agent must list at least one In Cinema film").toBeGreaterThanOrEqual(1);

  const firstCardBefore = await page.evaluate(() => document.querySelector("#groups .card")?.id);
  expect(firstCardBefore, "Upcoming must already show a card").toBeTruthy();

  await page.locator('.stagestop[data-stage="in_cinema"]').click();
  await settleListing(page);

  const afterInCinema = await page.evaluate(() => ({
    inCinemaOn: document.querySelector('.stagestop[data-stage="in_cinema"]').classList.contains("on"),
    inCinemaPressed: document.querySelector('.stagestop[data-stage="in_cinema"]').getAttribute("aria-pressed"),
    upcomingOn: document.querySelector('.stagestop[data-stage="upcoming"]').classList.contains("on"),
    firstCard: document.querySelector("#groups .card")?.id,
  }));
  expect(afterInCinema.inCinemaOn, "In Cinema must now be the selected stage").toBe(true);
  expect(afterInCinema.inCinemaPressed, "In Cinema's aria-pressed must be true").toBe("true");
  expect(afterInCinema.upcomingOn, "Upcoming must no longer be selected").toBe(false);
  expect(afterInCinema.firstCard, "the list must actually rebuild — the first card must change")
    .not.toBe(firstCardBefore);

  await page.locator('.stagestop[data-stage="upcoming"]').click();
  await settleListing(page);

  const afterUpcoming = await page.evaluate(() => ({
    upcomingOn: document.querySelector('.stagestop[data-stage="upcoming"]').classList.contains("on"),
    upcomingPressed: document.querySelector('.stagestop[data-stage="upcoming"]').getAttribute("aria-pressed"),
    inCinemaOn: document.querySelector('.stagestop[data-stage="in_cinema"]').classList.contains("on"),
    firstCard: document.querySelector("#groups .card")?.id,
  }));
  expect(afterUpcoming.upcomingOn, "Upcoming must be selected again").toBe(true);
  expect(afterUpcoming.upcomingPressed, "Upcoming's aria-pressed must be true").toBe("true");
  expect(afterUpcoming.inCinemaOn, "In Cinema must no longer be selected").toBe(false);
  expect(afterUpcoming.firstCard, "switching back must rebuild the list again")
    .not.toBe(afterInCinema.firstCard);
});

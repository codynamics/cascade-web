// CAS-1248: switching a ⚙️ service chip off, a Where & when window off, or renaming the selected mood all
// ended in a plain render() that CAS-1236's settled-list nav key (watchNavKey(), app_template.html)
// couldn't see — so render() ran reconcilePatchSettledList() instead of a full rebuild, and the Watch list/
// stage line/mood row sat disagreeing with the app's own state until the next tab or mood tap forced one.
// Not run by CI (only tests/e2e/smoke.spec.mjs is), kept here for a human or a later CC run to exercise
// directly, same convention cas1247-watch-top-moods.spec.mjs's own header comment already documents.
import { test, expect } from "@playwright/test";
import {
  toShortlist, finishFlow, toListing, settleListing,
  openWhereWhenScreen, closeWhereWhenScreen, openMyServicesScreen, closeMyServicesScreen,
} from "./helpers.mjs";

const FILM_SUB = 900124803;   // synthetic Streaming-tab film with a real subscription offer
const FILM_RENT = 900124804;  // synthetic Rental-tab film
const ALL_FILMS = [FILM_SUB, FILM_RENT];

async function toWatchScreen(page){
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  return page.evaluate(() => {
    // Same widening cas754.spec.mjs/CAS-1244.spec.mjs use — the onboarded agent's own window gate narrowed
    // to whatever onboarding picked, not this spec's concern.
    cascades[0].status = [];
    cascades[0].listStatus = [];
    return cascades[0].id;
  });
}

async function seedFilm(page, { cascadeId, id, title, status, winKey, offers }){
  await page.evaluate(({ cascadeId, id, title, status, winKey, offers }) => {
    MOVIES.push({ tmdb_id: id, title, status: [status], offers });
    const e = entryFor(id);
    e.pinnedTo = [cascadeId];
    e.wins = { [winKey]: true };
    e.winsSource = { [winKey]: "manual" };
  }, { cascadeId, id, title, status, winKey, offers });
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

/** The ticket's own "the screen matches" check — the three things every AC asserts within 2 seconds. */
async function screenMatches(page){
  return page.evaluate(() => {
    const domIds = new Set([...document.querySelectorAll('#groups [id^="card-"]')].map(el => Number(el.id.slice(5))));
    const stateIds = new Set(watchVisibleRows().rows.map(m => m.tmdb_id));
    const idsMatch = domIds.size === stateIds.size && [...domIds].every(id => stateIds.has(id));
    const domStages = [...document.querySelectorAll(".stagestop")].map(el => el.dataset.stage);
    const stateStages = watchStageStopsNow().map(s => s.key);
    const stagesMatch = JSON.stringify(domStages) === JSON.stringify(stateStages);
    const domMoods = [...document.querySelectorAll(".moodchip")].map(el => el.childNodes[0].textContent.trim());
    const stateMoods = watchMoodsList().map(m => m.name);
    const moodsMatch = JSON.stringify(domMoods) === JSON.stringify(stateMoods);
    return idsMatch && stagesMatch && moodsMatch;
  });
}

test("AC1: switching a picked subscription off updates the screen at once", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await openMyServicesScreen(page);
  const svcVal = await page.locator("#prefSubChips .chip").first().evaluate(el => el.dataset.val).catch(() => null);
  test.skip(!svcVal, "this catalogue build carries no subscription offer to pick");

  await seedFilm(page, {
    cascadeId, id: FILM_SUB, title: "CAS-1248 — Streaming", status: "included_streaming", winKey: "stream",
    offers: [{ service: svcVal, type: "sub" }],
  });
  await page.locator(`#prefSubChips .chip[data-val="${svcVal}"]`).click();   // pick it: switches the service ON
  await closeMyServicesScreen(page);
  await page.evaluate(() => { setWatchTab("stream"); render(); });
  await settleListing(page);

  expect(await screenMatches(page), "sanity: picking the service must already be reflected").toBe(true);
  const before = await page.evaluate(() => watchVisibleRows().rows.length);

  await openMyServicesScreen(page);
  await page.locator(`#prefSubChips .chip[data-val="${svcVal}"]`).click();   // switch it back off
  await closeMyServicesScreen(page);

  const after = await page.evaluate(() => watchVisibleRows().rows.length);
  expect(after, "sanity: switching the service off must actually change the account's own matching rows")
    .not.toBe(before);
  expect(await screenMatches(page), "AC1: the screen must match within 2 seconds, with no further tap").toBe(true);
});

test("AC2: switching the Rental window off (and back on) updates the stage line at once", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilm(page, {
    cascadeId, id: FILM_RENT, title: "CAS-1248 — Rental", status: "rental", winKey: "rent", offers: [],
  });
  await page.evaluate(() => { setWatchTab("rent"); render(); });
  await settleListing(page);

  expect(await screenMatches(page), "sanity: the seeded film must already be on the Rental tab").toBe(true);
  expect(await page.evaluate(() => watchStageStopsNow().some(s => s.key === "rent")),
    "sanity: Rental must start enabled").toBe(true);

  await openWhereWhenScreen(page);
  const rentalLane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: "Standard Rent" }) });
  await rentalLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(rentalLane).not.toHaveClass(/on/);
  await closeWhereWhenScreen(page);

  expect(await page.evaluate(() => windowEnabled("rent")), "sanity: the window must actually be off now").toBe(false);
  expect(await page.locator('.stagestop[data-stage="rent"]').count(), "AC2: no Rental stop once the window is off")
    .toBe(0);
  expect(await screenMatches(page), "AC2: the screen must match within 2 seconds, with no further tap").toBe(true);

  await openWhereWhenScreen(page);
  await rentalLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(rentalLane).toHaveClass(/on/);
  await closeWhereWhenScreen(page);

  expect(await page.locator('.stagestop[data-stage="rent"]').count(), "AC2: the Rental stop must be back").toBe(1);
  expect(await screenMatches(page)).toBe(true);
});

test("AC3: renaming the selected mood updates its chip and the collapsed-bar summary at once", async ({ page }) => {
  await toWatchScreen(page);
  await settleListing(page);

  const selectedId = await page.locator(".moodchip.on").getAttribute("data-mood");
  await page.locator(".moodchip.on").click();   // tapping the already-selected chip opens its sheet (C5)
  await expect(page.locator("#watchSheet")).toHaveClass(/open/);
  await page.locator("#moodName").fill("Best ten");
  await page.locator("#moodSaveBtn").click();

  expect(await page.evaluate(id => watchMoodsList().find(m => m.id === id).name, selectedId),
    "sanity: the mood must actually have been renamed").toBe("Best ten");
  await expect(page.locator(".moodchip.on")).toContainText("Best ten");
  expect(await screenMatches(page), "AC3: the screen must match within 2 seconds, with no further tap").toBe(true);

  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(100);
  await expect(page.locator("#wtMini .wtmood")).toHaveText("Best ten");
});

// AC4: the audit (ticket step 2) found no further live-state gap in watchScopeRows()/watchVisibleRows()/
// watchStageStopsNow()/renderWatchTop()/listingGroups() beyond the three above — see the Jira comment's
// table for the full read-through.

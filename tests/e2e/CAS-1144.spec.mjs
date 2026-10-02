// CAS-1144: the Watch empty state used to price its "Drop the …" buttons off the last-opened agent's
// Cascade-builder criteria (filt/RELAXERS) — criteria that plays no part in what the Watch tab actually
// lists, so the buttons named controls that didn't empty the tab and didn't fill it when tapped. This spec
// drives the real empty state through the Watch pipeline itself: no agent tracking the active tab (AC1),
// and the tab's own filters hiding everything a real agent would otherwise show (AC2) — asserting in both
// that the legacy per-criterion buttons are gone (AC3).
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

const FILM_ID = 900114401;

async function toWatchScreen(page, kind){
  await toShortlist(page, kind);
  await finishFlow(page);
  await toListing(page);
  return page.evaluate(() => cascades[0].id);
}

test.afterEach(async ({ page }) => {
  await page.evaluate(id => {
    const i = MOVIES.findIndex(m => m.tmdb_id === id);
    if(i >= 0) MOVIES.splice(i, 1);
    delete notify[id];
  }, FILM_ID);
});

test("CAS-1144 AC1/AC3: no agent tracking the tab names the real reason and offers Open Agents", async ({ page }) => {
  await toWatchScreen(page, "stream");
  await page.evaluate(() => {
    cascades.forEach(c => { c.watchMarkers.stream = null; });   // CAS-1144: every agent — nothing tracks Streaming
    render();
  });
  await page.evaluate(() => setWatchTab("stream"));
  await settleListing(page);

  const empty = page.locator("#groups .empty");
  await expect(empty).toBeVisible();
  await expect(empty.locator(".eh")).toHaveText("None of your agents track Streaming.");
  await expect(empty).not.toContainText(/Drop the|Look beyond my services/);

  await empty.locator(".ebtn", { hasText: "Open Agents" }).click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
});

test("CAS-1144 AC2/AC3: a Watch filter hiding everything prices an honest Clear filters, not legacy relax buttons", async ({ page }) => {
  const cascadeId = await toWatchScreen(page, "stream");
  // Same synthetic-film-past-deriveStatus technique cas753.spec.mjs uses: pinned straight to the agent and
  // armed manually, so it is admitted and placed on Streaming with no dependence on real catalogue taste
  // matching or a specific service pick.
  await page.evaluate(({ cascadeId, id }) => {
    MOVIES.push({ tmdb_id: id, title: "CAS-1144 — Streaming Film", status: ["included_streaming"], offers: [] });
    const e = entryFor(id);
    e.pinnedTo = [cascadeId];
    e.wins = { stream: true };
    e.winsSource = { stream: "manual" };
  }, { cascadeId, id: FILM_ID });
  await page.evaluate(() => { setWatchMineOnly(false); setWatchTab("stream"); render(); });
  await settleListing(page);
  await expect(page.locator(`#card-${FILM_ID}`)).toBeVisible();

  await page.fill("#watchSearchInput", "zzznomatch1144");
  await page.waitForTimeout(250);   // CAS-514's debounced render picking up the new search text
  await settleListing(page);

  const empty = page.locator("#groups .empty");
  await expect(empty).toBeVisible();
  await expect(empty).not.toContainText(/Drop the|Look beyond my services/);
  const btn = empty.locator(".ebtn");
  await expect(btn).toHaveCount(1);
  await expect(btn).toContainText("Clear filters");
  const n = Number((await btn.locator("b").textContent()).replace(/\D+/g, ""));
  expect(n).toBeGreaterThan(0);

  await btn.click();
  await settleListing(page);
  await expect(page.locator("#groups .card, #groups .stub")).toHaveCount(n);
});

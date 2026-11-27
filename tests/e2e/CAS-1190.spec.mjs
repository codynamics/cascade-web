// CAS-1190: the header's three chips (Watch, Moving, Find) must share one row at every phone width.
// CAS-1185 made .hdr-actions a 2-column grid for two chips; CAS-1186 added Find without a third column,
// so Find wrapped to a second row. Checked at 390 (icon-only chips, below the 429px breakpoint) and 430
// (labelled chips, above it).
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

async function buildListing(page){
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await expect(page.locator("#groups .card, #groups .stub").first()).toBeVisible();
}

for(const width of [390, 430]){
  test.describe(`CAS-1190 header row at ${width} wide`, () => {
    test.use({ viewport: { width, height: 844 } });

    test(`chips share one row, brandrow fits, Find stays inside, no sideways scroll`, async ({ page }) => {
      await buildListing(page);

      // Compare vertical centres, not tops: Watch is deliberately taller (48px vs 38px, 2026-11-20) and the
      // row is align-items:center, so tops differ by design while the chips still share one row.
      const midY = id => page.locator(id).evaluate(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
      const moviesMid = await midY("#moviesBtn");
      const movingMid = await midY("#movingBtn");
      const findMid = await midY("#findBtn");
      const agentsMid = await midY("#agentsBtn");
      expect(Math.abs(moviesMid - movingMid)).toBeLessThanOrEqual(1);
      expect(Math.abs(moviesMid - findMid)).toBeLessThanOrEqual(1);
      expect(Math.abs(moviesMid - agentsMid)).toBeLessThanOrEqual(1);

      const brandrowBox = await page.locator(".brandrow").evaluate(el => el.getBoundingClientRect());
      expect(brandrowBox.height).toBeLessThan(60);

      const findRight = await page.locator("#findBtn").evaluate(el => el.getBoundingClientRect().right);
      expect(findRight).toBeLessThanOrEqual(brandrowBox.right);

      const docFits = await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      expect(docFits).toBe(true);
    });
  });
}

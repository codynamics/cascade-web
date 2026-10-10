// CAS-1246: header — four nav items (Watch, Alerts, Find, Agents) in one row, the menu moved to the far
// right, the logo and update date hidden, and one shared "violet haze" selected style (--sel-bg/--sel-bd)
// instead of solid blue. AC1-3 and AC5 vary by phone width; AC4 and AC6-8 don't, so they run once.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

async function buildOnboardedAccount(page){
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
}

for(const width of [360, 390, 430]){
  test.describe(`CAS-1246 header nav at ${width} wide`, () => {
    test.use({ viewport: { width, height: 844 } });

    test("four equal-width nav chips, the menu clears them, no sideways scroll, no logo/date", async ({ page }) => {
      await buildOnboardedAccount(page);

      // AC1
      const chips = page.locator(".hdr-actions .modechip");
      await expect(chips).toHaveCount(4);
      const ids = await chips.evaluateAll(els => els.map(el => el.id));
      expect(ids).toEqual(["moviesBtn", "movingBtn", "findBtn", "agentsBtn"]);
      for(const id of ids) await expect(page.locator(`#${id}`)).toBeVisible();
      const widths = await chips.evaluateAll(els => els.map(el => el.getBoundingClientRect().width));
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);

      // AC2
      await expect(page.locator("#navMenuBtn")).toBeVisible();
      const menuLeft = await page.locator("#navMenuBtn").evaluate(el => el.getBoundingClientRect().left);
      const agentsRight = await page.locator("#agentsBtn").evaluate(el => el.getBoundingClientRect().right);
      expect(menuLeft).toBeGreaterThanOrEqual(agentsRight);
      const docFits = await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      expect(docFits).toBe(true);

      // AC3
      const displays = await page.evaluate(() => ({
        brandlockup: getComputedStyle(document.querySelector(".brandlockup")).display,
        updated: getComputedStyle(document.querySelector("#updated")).display,
      }));
      expect(displays.brandlockup).toBe("none");
      expect(displays.updated).toBe("none");

      // AC5
      await page.locator("#navMenuBtn").click();
      await expect(page.locator("#navMenu")).toHaveClass(/open/);
      const navItemTexts = await page.locator("#navMenu .navitem").allTextContents();
      expect(navItemTexts.some(t => t.trim() === "Agents")).toBe(false);
      const firstItem = page.locator("#navMenu .navitem").first();
      await expect(firstItem).toContainText("Invites");
      await expect(firstItem).not.toHaveClass(/navsep/);
      const navBox = await page.locator("#navMenu").evaluate(el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      expect(navBox.right).toBeLessThanOrEqual(width);
      expect(navBox.left).toBeGreaterThanOrEqual(0);
    });
  });
}

test("CAS-1246 AC4: the selected chip wears violet haze, not blue", async ({ page }) => {
  await buildOnboardedAccount(page);

  const moviesStyle = await page.locator("#moviesBtn").evaluate(el => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, bd: cs.borderTopColor };
  });
  expect(moviesStyle.bg).toBe("rgba(124, 92, 255, 0.2)");
  expect(moviesStyle.bd).toBe("rgba(140, 112, 255, 0.62)");

  const findStyle = await page.locator("#findBtn").evaluate(el => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, bd: cs.borderTopColor };
  });
  expect(findStyle.bg).not.toBe("rgba(124, 92, 255, 0.2)");
  expect(findStyle.bd).not.toBe("rgba(140, 112, 255, 0.62)");
});

test("CAS-1246 AC6: tapping Agents opens the screen and lights the chip; Watch closes it again", async ({ page }) => {
  await buildOnboardedAccount(page);

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await expect(page.locator("#agentsBtn")).toHaveClass(/active/);
  await expect(page.locator("#agentsBtn")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#moviesBtn")).not.toHaveClass(/active/);

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#agentsScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#agentsBtn")).not.toHaveClass(/active/);
  await expect(page.locator("#agentsBtn")).not.toHaveAttribute("aria-pressed", "true");
});

test("CAS-1246 AC7: the tutorial's first card anchors to Agents, not a menu", async ({ page }) => {
  await buildOnboardedAccount(page);

  const card0 = await page.evaluate(() => tutorialCardDefs()[0]);
  expect(card0.sel).toBe("#agentsBtn");
  expect(card0.text).not.toMatch(/\bmenu\b/);
});

test("CAS-1246 AC8: the saving dot sits inside the header, clear of every chip", async ({ page }) => {
  await buildOnboardedAccount(page);

  await page.locator("#savingDot").evaluate(el => el.classList.add("show"));
  const rects = await page.evaluate(() => {
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
    };
    return {
      dot: rect(document.querySelector("#savingDot")),
      header: rect(document.querySelector("header")),
      chips: [...document.querySelectorAll(".hdr-actions .modechip")].map(rect),
    };
  });
  expect(rects.dot.left).toBeGreaterThanOrEqual(rects.header.left);
  expect(rects.dot.right).toBeLessThanOrEqual(rects.header.right);
  expect(rects.dot.top).toBeGreaterThanOrEqual(rects.header.top);
  expect(rects.dot.bottom).toBeLessThanOrEqual(rects.header.bottom);
  for(const c of rects.chips){
    const overlaps = rects.dot.left < c.right && rects.dot.right > c.left &&
      rects.dot.top < c.bottom && rects.dot.bottom > c.top;
    expect(overlaps).toBe(false);
  }
});

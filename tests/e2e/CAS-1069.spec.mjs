// CAS-1168: the membership screen carries the price and free-month copy again (CAS-1069 reversed on this
// screen only, Lee, 3 Oct 2026) but still not the "Prototype" disclaimer. Covers both #membScreen paths:
// the onboarding recap (openOnbMembership, reached via finishFlow) and the standalone preview
// (openMembership, reached via ?step=membership, same entry CAS-909/CAS-910 use for other preview steps).
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

/** The screen's own rendered text carries the restored price copy and never the "Prototype" disclaimer. */
async function expectPriceCopy(page){
  const text = (await page.locator("#membBody").textContent()) || "";
  expect(text).toContain("Free for your first month");
  expect(text).toContain("$4.99/month");
  expect(text.toLowerCase()).not.toContain("prototype");
}

test("onboarding recap (openOnbMembership): price copy, 'Start my free month' CTA, and membStart() still lands on the listing (CAS-1168)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);   // lands on #membScreen.open — the onboarding recap

  await expect(page.locator("#membScreen.open")).toBeVisible();
  await expectPriceCopy(page);
  await expect(page.locator(".membcta")).toHaveText("Start my free month");

  // membStart() behaviour is unchanged: guest mode (config.js 404'd by freshApp) needs no email and
  // proceeds straight through to the listing.
  await toListing(page);
  await expect(page.locator("#groups")).toBeVisible();
});

test("standalone preview (openMembership via ?step=membership): price copy and 'Start my free month' CTA (CAS-1168)", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html?step=membership");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await expect(page.locator("#membScreen.open")).toBeVisible();
  await expectPriceCopy(page);
  await expect(page.locator(".membcta")).toHaveText("Start my free month");
});

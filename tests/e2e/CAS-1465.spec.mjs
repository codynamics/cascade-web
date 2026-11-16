// CAS-1465: Alerts opens on Today the first time in an app session; once the user picks a period it stays
// on that period for every later open in the same session (memory only). A reload or a sign-out returns the
// next open to Today.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 } });

const periodText = page => page.locator("#movingWindowName").textContent().then(t => t.trim());

async function pickPeriod(page, label){
  await page.locator("#movingWindowBtn").click();
  await page.locator(".popt", { hasText: label }).first().click();
  await expect(page.locator("#movingWindowName")).toHaveText(label);
}

test("CAS-1465: Alerts keeps the period the user chose for the rest of the session, then resets", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#movingBtn").click();
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  expect(await periodText(page)).toBe("Today");

  await pickPeriod(page, "Week");

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#movingScreen")).not.toHaveClass(/open/);
  await page.locator("#movingBtn").click();
  expect(await periodText(page)).toBe("Week");

  await pickPeriod(page, "Month");
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await page.locator("#movingBtn").click();
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  expect(await periodText(page)).toBe("Month");

  // Sign-out puts it back to Today (the real chokepoint, per CAS-959's own convention).
  await page.evaluate(() => window.CascadePersistence.signOutReset());
  await page.evaluate(() => { closeMovingScreen(); openMovingScreen(); });
  expect(await periodText(page)).toBe("Today");

  // Not persisted: pick Week again, reload, and the next open is Today.
  await pickPeriod(page, "Week");
  await page.reload();
  await page.waitForFunction(() => typeof openMovingScreen === "function" && Array.isArray(MOVIES));
  await page.evaluate(() => openMovingScreen());
  expect(await periodText(page)).toBe("Today");
});

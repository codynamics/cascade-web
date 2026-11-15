// CAS-971 AC3: on the web build the membership screen shows no purchase button and no console error.
// cascademovies.com never sells the membership - it is bought only in the iOS app.
import { test, expect } from "@playwright/test";

test("web membership screen: no purchase button, the iPhone-app message, and no console error (CAS-971)", async ({ page }) => {
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(String(e)));
  await page.route("**/config.js", route => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto("/index.html?step=membership");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await expect(page.locator("#membScreen.open")).toBeVisible();
  const body = (await page.locator("#membBody").textContent()) || "";
  expect(body).not.toContain("Membership is started in the Cascade iPhone app.");   // Lee, 14 Nov: the web line is gone; the offer box carries the terms
  expect(body).toContain("First month free");
  for (const word of ["Start free trial", "Subscribe", "Restore Purchases", "Start my free month"]) {
    expect(body).not.toContain(word);
  }
  await expect(page.locator("#membRestoreBtn")).toHaveCount(0);
  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

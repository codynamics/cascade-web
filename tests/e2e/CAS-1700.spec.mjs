// CAS-1700: services -> topSvc is a shared-element transition. The ticked streaming chips glide (transform only),
// taps are dropped while it runs, and reduced motion gets a plain cross-fade.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 } });

// Walks welcome -> who -> services and makes sure at least three streaming chips are ticked. Returns the CTA.
async function toServices(page){
  await page.evaluate(() => window.oafOpen());
  const cta = page.locator("#oafCta");
  await cta.click();                                           // welcome -> who
  await page.locator('.whopill[data-field="age"][data-val="18plus"]').click();
  await cta.click();                                           // who -> services
  await expect(page.locator("#oafInner .osh")).toHaveText("Which services do you have?");
  const chips = page.locator("#oafSvcSubs .chip.svc");
  for(let i = 0; i < 3; i++){
    const c = chips.nth(i);
    if(!(await c.evaluate(e => e.classList.contains("on")))) await c.click();
  }
  return cta;
}
const hasTransform = page => page.evaluate(() =>
  [...document.querySelectorAll("#oafTopSvcOpts .chip")].map(c => getComputedStyle(c).transform !== "none"));

test("CAS-1700 AC1: the ticked chips carry a transform during the transition, then topSvc stands alone", async ({ page }) => {
  await freshApp(page);
  const cta = await toServices(page);
  const ticked = await page.locator("#oafSvcSubs .chip.svc.on").count();
  expect(ticked).toBeGreaterThanOrEqual(3);
  await cta.click();
  await expect(page.locator("#oafInner .osh")).toHaveText("Which streaming service do you use most?");
  const during = await hasTransform(page);
  expect(during.length).toBe(ticked);
  expect(during.some(Boolean)).toBe(true);
  await page.waitForTimeout(900);
  await expect(page.locator("#oafTopSvcOpts .chip")).toHaveCount(ticked);
  expect(await page.locator("#oafSvcSubs, #oafSvcStores").count()).toBe(0);
  expect((await hasTransform(page)).some(Boolean)).toBe(false);
});

test("CAS-1700 AC2: reduced motion — no transform, and the step changes within 300 ms", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await freshApp(page);
  const cta = await toServices(page);
  const t0 = Date.now();
  await cta.click();
  await expect(page.locator("#oafInner .osh")).toHaveText("Which streaming service do you use most?");
  expect(Date.now() - t0).toBeLessThan(300);
  expect((await hasTransform(page)).some(Boolean)).toBe(false);
});

test("CAS-1700 AC3: a tap 100 ms into the transition does not select a service", async ({ page }) => {
  await freshApp(page);
  const cta = await toServices(page);
  await cta.click();
  await page.waitForTimeout(100);
  await page.locator("#oafTopSvcOpts .chip").first().dispatchEvent("click");
  expect(await page.evaluate(() => oafState.topSvc)).toBeNull();
  await page.waitForTimeout(800);
  await page.locator("#oafTopSvcOpts .chip").first().click();
  expect(await page.evaluate(() => oafState.topSvc)).not.toBeNull();
});

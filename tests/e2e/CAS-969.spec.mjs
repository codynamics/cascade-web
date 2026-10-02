// CAS-969: the App Store rating prompt. Apple's SKStoreReviewController is unreachable from a Playwright
// web run — the ticket's own Change section says as much ("it will only work in a TestFlight or App Store
// build"). What these assert is exactly what the ACs ask for on the WEB surface: driving the trigger
// throws nothing, shows nothing, logs nothing (AC2), and the "asked at most once per version" state holds
// even across a reload (AC4) — proven with a Capacitor.Plugins.InAppReview stub injected before the app's
// own scripts run, standing in for the native plugin so a call count can be asserted without a device.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

/** A fake native Capacitor + a counting InAppReview.requestReview stub, present before any app script
 * runs. The count is kept in localStorage (not a plain window var) because a `page.reload()` gives every
 * window variable a clean slate but leaves localStorage — the same device-persistence gap AC4 is about. */
async function primeNativeReviewStub(page){
  await page.addInitScript(() => {
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { InAppReview: { requestReview: () => {
        const n = Number(localStorage.getItem("__cas969_review_requests") || 0) + 1;
        localStorage.setItem("__cas969_review_requests", String(n));
        return Promise.resolve();
      } } },
    };
  });
}

/** A real onboarding-built roster (same recipe as CAS-930.spec.mjs's signedInListing) — a genuinely
 * matching agent, not a hand-built stand-in, so `cascades.some(c => watchCount(c) > 0)` and the listed
 * film's own membership in `found` are both real rather than asserted by construction. Returns the first
 * listed film's id. */
async function buildRealListingFilm(page){
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  return card.evaluate(el => Number(el.id.replace("card-", "")));
}

async function windUpSessions(page){
  await page.evaluate(() => { for(let i = 0; i < REVIEW_PROMPT_MIN_SESSIONS; i++) bumpReviewPromptSessionCount(); });
}

test("CAS-969 AC2: driving the trigger on the web surface shows nothing, throws nothing, logs nothing", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if(m.type() === "error") errors.push(m.text()); });

  const id = await buildRealListingFilm(page);
  await windUpSessions(page);
  // CAS-1150 requeue: AC2 is about driving the trigger, not about the real listing built to drive it —
  // clear whatever boot/poster-load noise (e.g. a catalogue poster 404) landed in `errors` while building
  // that listing above, so only console/page activity from the actual setOpinion tap below is asserted on.
  errors.length = 0;
  await page.evaluate((filmId) => setOpinion(filmId, "enjoyed"), id);
  await page.waitForTimeout(200);

  expect(errors).toEqual([]);
  // No custom modal, no rating UI of any kind — the app never grew one for this (AC5 covers the copy;
  // this covers that nothing rendered on the page it's absent from).
  expect(await page.locator('[class*="review" i], [id*="review" i]').count()).toBe(0);
});

test("CAS-969 AC4: the native plugin is asked at most once per version, even across a reload", async ({ page }) => {
  await primeNativeReviewStub(page);
  const id1 = await buildRealListingFilm(page);
  await windUpSessions(page);
  await page.evaluate((filmId) => setOpinion(filmId, "enjoyed"), id1);
  await page.waitForFunction(() => Number(localStorage.getItem("__cas969_review_requests") || 0) > 0, null, { timeout: 5000 });
  expect(await page.evaluate(() => Number(localStorage.getItem("__cas969_review_requests")))).toBe(1);

  // Reload (not a fresh onboarding run) — the point is the SAME device storage surviving into a new load.
  // The init script re-primes the same native stub; the listing itself streams back in from local state.
  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.waitForFunction(() => document.querySelectorAll("#groups .card").length > 0, null, { timeout: 30_000 });
  const card2 = page.locator("#groups .card").first();
  const id2 = await card2.evaluate(el => Number(el.id.replace("card-", "")));
  await windUpSessions(page);
  await page.evaluate((filmId) => setOpinion(filmId, "wow"), id2);
  await page.waitForTimeout(300);

  // AC4: driving the trigger a second time, after a reload, on the same version, must not raise a second
  // request — the count started by the first drive must be the count that survives to the end.
  expect(await page.evaluate(() => Number(localStorage.getItem("__cas969_review_requests")))).toBe(1);
});

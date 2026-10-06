// CAS-1206: a notification tap must land on Alerts (Today), not the film page — reverses the
// CAS-466/CAS-445 behaviour (pushNotificationActionPerformed -> openNotifyFilm). No existing spec
// covered the old behaviour (checked tests/ for CAS-445/CAS-466/openNotifyFilm/pushNotification — none
// found), so there is nothing here to rewrite per the ticket's AC3; this spec is new.
//
// Guest mode (freshApp + walkToServices/finishFlow/toListing), same reasoning CAS-1152's own header
// comment gives: this sandbox has neither reason nor means to spin up the local Supabase stack (Docker)
// for a client-side-only behaviour, and a guest device reaches the same real listing with a real agent.
// A guest device's own "ledger" is firstFound (movingData()'s guest branch) rather than the signed-in
// notifications table — any film the fresh agent just admitted is in it, dated today, which is exactly
// "an id in the fixture ledger" for this suite's purposes.
//
// Capacitor.Plugins.PushNotifications.addListener is called once, synchronously, deep inside the boot
// script's own native-only block — long before any page.evaluate could run — so it must already exist
// (and already report isNativePlatform() true) the moment that block executes. An addInitScript-set
// window.Capacitor cannot survive that: the real (vendored) capacitor-core.js loads straight after it
// and reinitialises window.Capacitor from scratch, clobbering whatever was there (CAS-932/CAS-969's own
// comments document this). So instead this intercepts the network request for
// capacitor-push-notifications.js (loaded immediately after the real capacitor-core.js) and serves a
// fake in its place — the same page.route substitution technique CAS-740/smoke.spec.mjs uses for
// supabase-js.js. The real capacitor-core.js is left to run normally (so App/InAppReview/ContactPicker,
// registered by the other untouched vendor files right after, keep working exactly as every other spec
// here expects); only the PushNotifications plugin and the public isNativePlatform() flag are replaced.
import { test, expect } from "@playwright/test";
import { freshApp, walkToServices, finishFlow, toListing } from "./helpers.mjs";

async function stubPushNotifications(page){
  await page.route("**/capacitor-push-notifications.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.Capacitor.isNativePlatform = () => true;
      window.__cas1206Listeners = {};
      window.Capacitor.Plugins.PushNotifications = {
        addListener(event, cb){
          window.__cas1206Listeners[event] = cb;
          return Promise.resolve({ remove: async () => {} });
        },
        checkPermissions(){ return Promise.resolve({ receive: "granted" }); },
        requestPermissions(){ return Promise.resolve({ receive: "granted" }); },
        register(){ return Promise.resolve(); },
        removeAllListeners(){ return Promise.resolve(); },
        removeAllDeliveredNotifications(){ return Promise.resolve(); },
        getDeliveredNotifications(){ return Promise.resolve({ notifications: [] }); },
      };
    `,
  }));
}

async function fireActionPerformed(page, movieId){
  await page.waitForFunction(() => !!(window.__cas1206Listeners && window.__cas1206Listeners.pushNotificationActionPerformed));
  await page.evaluate(movieId => window.__cas1206Listeners.pushNotificationActionPerformed(
    { notification: { data: { movie_id: String(movieId) } } }
  ), movieId);
}

/** A fresh, fully onboarded guest device with one real agent — the admitted film's own id (first in
 * #groups) is "an id in the fixture ledger": movingData()'s guest branch (firstFound) dates it today,
 * so Moving's Today window — the window it always opens on (CAS-1197) — shows it. */
async function onboardedGuestDevice(page){
  await stubPushNotifications(page);
  await freshApp(page);
  await page.waitForFunction(() => flowOn === true || document.querySelector("#splashCta"));
  if(!(await page.evaluate(() => flowOn === true))) await page.locator("#splashCta").click();
  await walkToServices(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await page.waitForFunction(() => document.querySelectorAll("#groups .card").length > 0);
  return page.evaluate(() => Number(document.querySelector("#groups .card").id.replace("card-", "")));
}

test("CAS-1206 AC1: a notification tap opens Alerts on Today, not the film page", async ({ page }) => {
  const filmId = await onboardedGuestDevice(page);

  await fireActionPerformed(page, filmId);

  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  await expect(page.locator("#filmPage")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => movingWindow)).toBe("today");
  // The tapped film's own row, inside Alerts specifically (not the Watch listing underneath it).
  await expect(page.locator(`#movingScreen [id="card-${filmId}"]`)).toBeInViewport();
});

test("CAS-1206 AC2: a tap that arrives before boot finishes is held and opens Alerts once boot completes", async ({ page }) => {
  await stubPushNotifications(page);
  await freshApp(page);
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  // Still on the splash: boot has not decided anything yet (CAS-740's own race — sign-in restore or,
  // here, the first-run decision itself — still pending), and onboarding has not started either.
  expect(await page.evaluate(() => onboardingSeen())).toBe(false);
  expect(await page.evaluate(() => flowOn)).toBe(false);

  await fireActionPerformed(page, 999999);
  await expect(page.locator("#movingScreen")).not.toHaveClass(/open/);   // held, not applied yet

  await page.locator("#splashCta").click();
  await walkToServices(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  // membStartWork() — first run genuinely finished — is one of applyPendingPushAlert()'s own call
  // sites, the same moment applyDeepLink() already acts on a held ?dl=.
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  expect(await page.evaluate(() => movingWindow)).toBe("today");
});

test("CAS-1206 AC4 (onboarding showing): a tap that arrives mid-flow is dropped, not queued", async ({ page }) => {
  await stubPushNotifications(page);
  await freshApp(page);
  await page.waitForFunction(() => flowOn === true || document.querySelector("#splashCta"));
  if(!(await page.evaluate(() => flowOn === true))) await page.locator("#splashCta").click();
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Let's get you set up.");
  expect(await page.evaluate(() => flowOn)).toBe(true);

  await fireActionPerformed(page, 999999);

  await walkToServices(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  // Dropped at arrival (onboarding was on screen), not merely delayed — finishing onboarding must not
  // reopen it, unlike the AC2 "boot still running" case above.
  await expect(page.locator("#movingScreen")).not.toHaveClass(/open/);
});

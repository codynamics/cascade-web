// CAS-962: deep links for custom product pages. The app always cold-boots the same bundled
// index.html natively (no server.url in capacitor.config.json), so a real device's cold-start path
// can't be driven from here — only the web equivalent can: loading the built app fresh with
// ?dl=<destination> already in the URL is the same "arrives with a destination in the query string"
// shape a Universal Link's native appUrlOpen/getLaunchUrl handling reduces to once parsed. That native
// half (app_template.html's appUrlOpen listener) has no browser-testable counterpart and is out of
// scope for this suite, same as every other native-only path here.
//
// Destinations still covered: dl=cinema (Watch, Cinema tab), dl=streaming (Watch, Streaming tab),
// dl=moving (Moving). CAS-1548: dl=family is gone from here — it opened the Family Movies agent's setup, an
// agent a current account (one v2 agent since CAS-1344) never has, so applyDeepLink()'s family branch is
// unreachable for them. Every test now reaches the app through the CURRENT first run (#oafScreen, via the
// shared helpers), not the retired v2_* wizard.
import { test, expect } from "@playwright/test";
import { freshApp, walkToServices, finishFlow, toListing } from "./helpers.mjs";

/** Base64url-encode a plain object the same way the (now receive-only) share-link format expects —
 * see app_template.html's unb64url/sanitiseShared. An empty-ish object is a valid share: every field
 * degrades to a default. */
function b64urlShare(obj){
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The current first run: splash -> #oafScreen (welcome, where, services, ...) -> membership -> Watch.
 * Assumes the page has already navigated (with whatever ?dl= is under test already in the URL). Stops at the
 * services step; finishFlow/toListing take it from there. */
async function walkOnboarding(page){
  await page.locator("#splashCta").click();
  await walkToServices(page, "cinema");
}

/** A device that has already onboarded — the fixture the per-destination cases reload against with their own
 * ?dl=, so each is a genuine cold load (a fresh navigation, re-running the whole boot script) rather than an
 * in-page state change. */
async function onboardedDevice(page){
  await freshApp(page);
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await walkOnboarding(page);
  await finishFlow(page);
  await toListing(page);
}

for(const [dest, tab] of [["cinema", "in_cinema"], ["streaming", "stream"]]){
  test(`CAS-962 AC1/AC2: ?dl=${dest} opens on the Watch ${dest} tab for a returning user`, async ({ page }) => {
    await onboardedDevice(page);
    await page.goto(`/index.html?dl=${dest}`);
    await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
    expect(await page.evaluate(() => location.search)).toBe("");         // consumed, same as ?step=/?reset
    expect(await page.evaluate(() => watchTab)).toBe(tab);
    const log = await page.evaluate(() => JSON.parse(localStorage.getItem("cascade_log") || "[]"));
    expect(log.some(e => e.type === "deeplink_applied" && e.dest === dest)).toBe(true);
  });
}

test("CAS-962 AC1/AC2: ?dl=moving opens the Moving screen for a returning user", async ({ page }) => {
  await onboardedDevice(page);
  await page.goto("/index.html?dl=moving");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
});

test("CAS-962 AC3: ?dl=cinema on a device that has never onboarded still runs first run to completion", async ({ page }) => {
  await freshApp(page);
  await page.goto("/index.html?dl=cinema");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  expect(await page.evaluate(() => location.search)).toBe("");
  await expect(page.locator("#splash")).toHaveClass(/open/);   // dl does not skip or shortcut onboarding
  await walkOnboarding(page);
  const reveal = await finishFlow(page);
  expect(reveal).toBeGreaterThan(0);
  await toListing(page);
  // The current first run builds exactly one v2 agent (CAS-1344).
  expect(await page.evaluate(() => cascades.map(c => c.v))).toEqual([2]);
  expect(await page.evaluate(() => watchTab)).toBe("in_cinema");
});

test("CAS-962 AC4: ?dl= alongside an existing ?c= share link — the share still resolves and neither breaks the other", async ({ page }) => {
  await freshApp(page);
  const payload = b64urlShare({ name: "Test Share" });
  await page.goto(`/index.html?c=${payload}&dl=moving`);
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await expect(page.locator("#builder")).toHaveClass(/open/);   // the share editor, same as ?c= alone
  expect(await page.evaluate(() => location.search)).toBe("");
  await expect(page.locator("#movingScreen")).not.toHaveClass(/open/);   // dl stayed inert — share wins
});

test("CAS-962 AC6: a load with no ?dl= is unaffected — no deep-link event fires", async ({ page }) => {
  await onboardedDevice(page);
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  const log = await page.evaluate(() => JSON.parse(localStorage.getItem("cascade_log") || "[]"));
  expect(log.some(e => e.type === "deeplink_applied")).toBe(false);
});

// CAS-962: deep links for custom product pages. The app always cold-boots the same bundled
// index.html natively (no server.url in capacitor.config.json), so a real device's cold-start path
// can't be driven from here — only the web equivalent can: loading the built app fresh with
// ?dl=<destination> already in the URL is the same "arrives with a destination in the query string"
// shape a Universal Link's native appUrlOpen/getLaunchUrl handling reduces to once parsed. That native
// half (app_template.html's appUrlOpen listener) has no browser-testable counterpart and is out of
// scope for this suite, same as every other native-only path here.
//
// Four named destinations only, exactly as the ticket's own "do not re-raise" list requires:
//   dl=cinema    -> Watch, Cinema tab
//   dl=streaming -> Watch, Streaming tab
//   dl=moving    -> Moving
//   dl=family    -> the Family Movies agent's own setup (Edit Agent), if this account has one
import { test, expect } from "@playwright/test";
import { freshApp, ctaLocator, finishFlow, toListing } from "./helpers.mjs";

/** Base64url-encode a plain object the same way the (now receive-only) share-link format expects —
 * see app_template.html's unb64url/sanitiseShared. An empty-ish object is a valid share: every field
 * degrades to a default. */
function b64urlShare(obj){
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Walks the splash through the v2 sequence to v2_services — same steps toShortlist (helpers.mjs)
 * walks, but with `kids` exposed so a "family" test can answer yes and get the Family agent built.
 * Assumes the page has already navigated (with whatever ?dl= is under test already in the URL). */
async function walkOnboarding(page, { kids = "no" } = {}){
  await page.locator("#splashCta").click();
  // CAS-1018: scoped to #onbStepInner, not a bare ".obhd" — gotoStep's dual-pane slide leaves the
  // outgoing step's .obhd in the DOM alongside the incoming one for the length of the transition, so a
  // bare ".obhd" is a strict-mode violation (resolves to 2 elements) for as long as that overlap lasts.
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Cascade finds your movies for you.");   // v2_about
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Massive Movies");                       // v2_intro
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#obCinemaOpts")).toBeVisible();                                 // v2_cinema
  await page.locator('#obCinemaOpts .obopt[data-val="yes"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#obRentOpts")).toBeVisible();                                   // v2_rent
  await page.locator('#obRentOpts .obopt[data-val="yes"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  for(const marker of ["v2_massive", "v2_handoff", "v2_styles", "v2_budget", "v2_ages", "v2_favs"]){
    await ctaLocator(page).click();
    await page.waitForTimeout(120);
  }
  await expect(page.locator("#obPartnerOpts")).toBeVisible();                                // v2_partner
  await page.locator('#obPartnerOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#obKidsOpts")).toBeVisible();                                   // v2_kids
  await page.locator(`#obKidsOpts .obopt[data-val="${kids}"]`).click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  if(kids === "yes"){
    await expect(page.locator(".agname")).toContainText("Family Movies");                    // v2_family reveal
    await ctaLocator(page).click();
    await page.waitForTimeout(120);
  }
  await expect(page.locator("#obSvcStores")).toBeVisible();                                  // v2_services
}

/** A device that has already onboarded (kids=no unless overridden) — the fixture the four AC1/AC2
 * per-destination cases reload against with their own ?dl=, so each is a genuine cold load (a fresh
 * navigation, re-running the whole boot script) rather than an in-page state change. */
async function onboardedDevice(page, opts){
  await freshApp(page);
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await walkOnboarding(page, opts);
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

test("CAS-962 AC1/AC2: ?dl=family opens the Family agent's own setup for a returning user", async ({ page }) => {
  await onboardedDevice(page, { kids: "yes" });
  await page.goto("/index.html?dl=family");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await expect(page.locator("#onbStep")).toHaveClass(/open/);
  await expect(page.locator(".osh.eahn")).toContainText("Family Movies");
});

// CAS-1159: confirmed app defect, not a stale assertion. applyDeepLink() (app_template.html) fires
// `logEvent("deeplink_applied", {dest})` unconditionally after its if/else-if chain, including the
// `dest==="family"` branch when `cascades.find(c=>c.template==="onb_family")` finds no agent and the
// branch body is a no-op — contradicting the function's own header comment ("a destination whose target
// doesn't exist for this account ... is silently ignored"). Reproduced locally: the event is always logged.
test.fixme("CAS-962 AC1: ?dl=family is silently inert for an account with no Family agent", async ({ page }) => {
  await onboardedDevice(page);   // kids=no — no Family agent was ever built
  await page.goto("/index.html?dl=family");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  const log = await page.evaluate(() => JSON.parse(localStorage.getItem("cascade_log") || "[]"));
  expect(log.some(e => e.type === "deeplink_applied")).toBe(false);
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
  const templates = await page.evaluate(() => cascades.map(c => c.template));
  expect(templates).toContain("onb_massive");
  expect(templates).toContain("onb_favs");
  expect(templates).not.toContain("onb_family");   // kids=no here — no agent skipped or corrupted, just none built
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

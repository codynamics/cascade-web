// CAS-1551: browser tests for the six tutorials (TOURS), the Tutorials screen and the tutorial banner (CAS-1534).
// tutorialAdvance() silently skips any step whose target is missing, so a renamed screen breaks a tour with no
// error. These tests walk every tour from Menu -> Tutorials and assert that NO step was skipped: the step index
// advances by exactly one per Next, and each non-centred step's resolved targets are in the DOM and visible.
// A step whose target is genuinely missing is a product bug: mark that test `fixme` with the reason and the bug
// ticket key; do not change the tutorial. Guest device with a real one-agent account (helpers.guestOnboarded);
// the banner and the Invite tour are signed-in-only, so those tests stub CascadeAuth's account fields.
// Runs in e2e-full only (not the push gate).
import { test, expect } from "@playwright/test";
import { guestOnboarded } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 } });

const TOUR_KEYS = ["watch", "moods", "alerts", "database", "agent", "invite"];
const DAY_MS = 86_400_000;

/** Make the page believe a signed-in account created `daysAgo` days ago is present — only the fields the tour
 * and banner code read (CascadeAuth.enabled/status/user). Re-renders so signed-in-only controls (the film
 * card's invite button) are drawn. Also resets the banner's per-visit and seen state. */
async function fakeSignedIn(page, daysAgo){
  await page.evaluate(days => {
    const a = window.CascadeAuth;
    a.enabled = true; a.status = "signed-in";
    a.user = { id: "cas1551-user", email: "cas1551@example.com", created_at: new Date(Date.now() - days * 86_400_000).toISOString() };
    tutSeenMap = {}; tutVisitShown = false;
    render();
  }, daysAgo);
}

async function openTutorialsScreen(page){
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Tutorials" }).click();
  await expect(page.locator("#tutorialsScreen")).toHaveClass(/open/);
}

async function startFromMenu(page, key){
  await openTutorialsScreen(page);
  await page.locator(`#tutorialsScreen .tutrow[onclick*="'${key}'"]`).click();
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);
}

test("CAS-1551 tutorials: the tutorial list, TOURS and the Tutorials screen's rows agree", async ({ page }) => {
  await guestOnboarded(page);
  expect(await page.evaluate(() => Object.keys(TOURS))).toEqual(TOUR_KEYS);
  expect(await page.evaluate(() => TUTORIAL_ROWS.map(r => r.key))).toEqual(TOUR_KEYS);
  await openTutorialsScreen(page);
  // Signed out: every row except the account-only Invite tour.
  const rows = await page.locator("#tutorialsScreen .tutrow").evaluateAll(
    els => els.map(e => /playTutorial\('(\w+)'\)/.exec(e.getAttribute("onclick"))[1]));
  expect(rows).toEqual(TOUR_KEYS.filter(k => k !== "invite"));
});

for(const key of TOUR_KEYS){
  test(`CAS-1551 tutorials: the ${key} tutorial runs every step to its closing card`, async ({ page }) => {
    await guestOnboarded(page);
    if(key === "invite") await fakeSignedIn(page, 10);   // the Invite tour (and its row) need an account
    await startFromMenu(page, key);

    const total = await page.evaluate(() => tutSteps.length);
    const expected = await page.evaluate(([k, signedIn]) => TOURS[k].steps.filter(s => !s.needsAccount || signedIn).length,
      [key, key === "invite"]);
    expect(total, `${key}: tutSteps is the whole script for this account`).toBe(expected);
    expect(total).toBeGreaterThan(0);

    for(let i = 0; i < total; i++){
      // No step was skipped by the engine: the index is exactly where the walk has got to.
      expect(await page.evaluate(() => tutIdx), `${key}: step ${i + 1} shown, none skipped before it`).toBe(i);
      await expect(page.locator("#tutProg")).toHaveText(`${i + 1} of ${total}`);
      const info = await page.evaluate(() => {
        const s = tutSteps[tutIdx], els = (tutCurrent && tutCurrent.els) || [];
        return {
          center: !!s.center,
          sel: (s.sel || []).join(" | "),
          n: els.length,
          allVisible: els.every(el => { const r = el.getBoundingClientRect(); return el.isConnected && r.width > 0 && r.height > 0; }),
          text: document.getElementById("tutText").textContent.trim().slice(0, 60),
        };
      });
      if(!info.center){
        expect(info.n, `${key} step ${i + 1} ("${info.text}"): a target for ${info.sel} exists`).toBeGreaterThan(0);
        expect(info.allVisible, `${key} step ${i + 1} ("${info.text}"): its targets are visible`).toBe(true);
      }
      if(i < total - 1){
        await expect(page.locator("#tutNextBtn")).toHaveText("Next");
        await page.locator("#tutNextBtn").click();
        await expect.poll(() => page.evaluate(() => tutIdx), { message: `${key}: Next from step ${i + 1} moved on` }).not.toBe(i);
      }
    }

    // The closing card: Done, no Skip, and Done ends the tour.
    await expect(page.locator("#tutNextBtn")).toHaveText("Done");
    await expect(page.locator("#tutSkipBtn")).toBeHidden();
    if(key === "watch") await expect(page.locator("#tutText")).toContainText("That's Watch.");
    await page.locator("#tutNextBtn").click();
    await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);
    expect(await page.evaluate(() => tutIdx)).toBe(-1);
  });
}

test("CAS-1551 tutorials: the Watch tutorial starts once after first run, and not again", async ({ page }) => {
  await guestOnboarded(page, { skipTutorial: false });
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);
  await expect(page.locator("#tutTitle")).toHaveText("Watch tutorial");

  // Skip shows the closing box first; Done there ends it and marks it seen.
  await page.locator("#tutSkipBtn").click();
  await page.locator("#tutNextBtn").click();
  await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => tourV2Seen())).toBe(true);

  // The automatic trigger fires again (as it would on the next boot): nothing starts.
  await page.evaluate(() => maybeStartTutorial());
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(300);
  await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);
});

async function openTaste(page){
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
}
const newVisit = page => page.evaluate(() => { tutVisitShown = false; });

test("CAS-1551 banner: not on day 0", async ({ page }) => {
  await guestOnboarded(page);
  await fakeSignedIn(page, 0);
  await openTaste(page);
  await expect(page.locator("#agentsBody .oarow").first()).toBeVisible();
  await expect(page.locator(".tutban")).toHaveCount(0);
});

test("CAS-1551 banner: shows on day 2 (account created two Sydney days back), once per visit", async ({ page }) => {
  await guestOnboarded(page);
  await fakeSignedIn(page, 2);
  expect(await page.evaluate(() => tutAccountAgeDays(window.CascadeAuth.user.created_at, Date.now()))).toBe(2);
  await openTaste(page);
  const ban = page.locator("#agentsBody .tutban");
  await expect(ban).toBeVisible();
  await expect(ban.locator(".tutbant")).toHaveText("New to Taste?");
  await expect(ban.locator(".tutbango")).toHaveText("View tutorial");

  // Same visit: no second banner on another screen, and not on Taste again.
  await page.evaluate(() => closeAgentsScreen());
  await page.locator("#findBtn").click();
  await expect(page.locator("#findScreen")).toHaveClass(/open/);
  await expect(page.locator(".tutban")).toHaveCount(0);
  await page.evaluate(() => closeFindScreen());
  await openTaste(page);
  await expect(page.locator(".tutban")).toHaveCount(0);

  // A new visit (app reopened after 30 minutes away) shows one again.
  await page.evaluate(() => closeAgentsScreen());
  await newVisit(page);
  await openTaste(page);
  await expect(page.locator("#agentsBody .tutban .tutbant")).toHaveText("New to Taste?");
});

test("CAS-1551 banner: stops after two dismissals", async ({ page }) => {
  await guestOnboarded(page);
  await fakeSignedIn(page, 2);
  for(let n = 1; n <= 2; n++){
    await newVisit(page);
    await openTaste(page);
    const ban = page.locator("#agentsBody .tutban");
    await expect(ban, `dismissal ${n}: the banner is still offered`).toBeVisible();
    await ban.locator(".tutbanx").click();
    await expect(page.locator(".tutban")).toHaveCount(0);
    await page.evaluate(() => closeAgentsScreen());
  }
  expect(await page.evaluate(() => tutSeenMap.agent.dismissed)).toBe(2);
  await newVisit(page);
  await openTaste(page);
  await expect(page.locator("#agentsBody .oarow").first()).toBeVisible();
  await expect(page.locator(".tutban")).toHaveCount(0);
});

test("CAS-1551 banner: View tutorial plays the tour and marks it played", async ({ page }) => {
  await guestOnboarded(page);
  await fakeSignedIn(page, 2);
  await openTaste(page);
  await page.locator("#agentsBody .tutban .tutbango").click();
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);
  expect(await page.evaluate(() => tutSeenMap.agent.played)).toBe(true);
});

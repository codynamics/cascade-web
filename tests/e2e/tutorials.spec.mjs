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
    tutSeenMap = {}; tutVisitShown = false; tutVisitState = {};
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

    // A step the product documents as conditional (CAS-976's rule: skipped when its anchor doesn't resolve) is not
    // a missing target: the Watch tour's "made moods" step points at the Top-service / Favourite-person moods the
    // first-run answers can create, and a guest with a plain one-agent setup has neither. Everything else still
    // may not be skipped.
    const optional = new Set([`.moodrow .moodchip[data-mood="topsvc"] | .moodrow .moodchip[data-mood="fav-person"]`,
      "#oamSvcSec"]);   // the Lists tour's "STREAMING ON" section only renders when the account has services (prefs.sub)
    const total = await page.evaluate(() => tutSteps.length);
    const expected = await page.evaluate(([k, signedIn]) => TOURS[k].steps.filter(s => !s.needsAccount || signedIn).length,
      [key, key === "invite"]);
    expect(total, `${key}: tutSteps is the whole script for this account`).toBe(expected);
    expect(total).toBeGreaterThan(0);

    for(let i = 0; i < total; i++){
      // No step was skipped by the engine (bar the documented conditional ones): the index is exactly where the
      // walk has got to.
      const at = await page.evaluate(() => tutIdx);
      for(; i < at; i++){
        const sel = await page.evaluate(n => (tutSteps[n].sel || []).join(" | "), i);
        expect(optional.has(sel), `${key}: step ${i + 1} shown, none skipped before it`).toBe(true);
      }
      expect(at, `${key}: step ${i + 1} shown, none skipped before it`).toBe(i);
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

test("CAS-1702 AC1: no automatic tour after first run; Watch shows its banner instead", async ({ page }) => {
  await guestOnboarded(page, { skipTutorial: false });
  await fakeSignedIn(page, 0);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);
  await expect(page.locator("#moviesBtn")).toHaveClass(/active/);
  const ban = page.locator("#tutbanSlot .tutban");
  await expect(ban).toBeVisible();
  await expect(ban.locator(".tutbant")).toHaveText("New to Cascade? Take the tour");
  await expect(ban.locator(".tutbans")).toHaveText("1 minute · see how Watch works");
});

async function openTaste(page){
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
}
/** A new visit: hidden for `mins` minutes on a stubbed clock, then back to the foreground. */
async function awayFor(page, mins){
  await page.evaluate(m => {
    const real = Date.now.bind(Date);
    window.__clockOff = window.__clockOff || 0;
    Date.now = () => real() + window.__clockOff;
    const vis = v => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v }); document.dispatchEvent(new Event("visibilitychange")); };
    vis("hidden");
    window.__clockOff += m * 60_000;
    vis("visible");
  }, mins);
}

test("CAS-1702 AC2: Watch banner shows on visits 1-3 (31 min apart), not 4; 10 minutes away is not a new visit", async ({ page }) => {
  await guestOnboarded(page);
  await fakeSignedIn(page, 0);
  const ban = page.locator("#tutbanSlot .tutban");
  await expect(ban).toBeVisible();
  // Gone and back after only 10 minutes: still the same visit, same single showing.
  await page.locator("#tutbanSlot .tutbanx").click();
  await awayFor(page, 10);
  await expect(ban).toHaveCount(0);
  expect(await page.evaluate(() => tutSeenMap.watch.shown)).toBe(1);
  for(const visit of [2, 3]){
    await awayFor(page, 31);
    await expect(ban, `visit ${visit}`).toBeVisible();
  }
  await awayFor(page, 31);
  await expect(page.locator("#groups .card").first()).toBeVisible();
  await expect(ban, "visit 4").toHaveCount(0);
});

test("CAS-1702 AC3: on visit 1 Taste, Alerts and Database each show their own banner", async ({ page }) => {
  await guestOnboarded(page);
  await fakeSignedIn(page, 0);
  await openTaste(page);
  await expect(page.locator("#agentsBody .tutban .tutbant")).toHaveText("New to Taste? Take the tour");
  await expect(page.locator("#agentsBody .tutban .tutbans")).toHaveText("1 minute · see how your agent learns");
  await page.evaluate(() => closeAgentsScreen());
  await page.locator("#movingBtn").click();
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  await expect(page.locator("#movingBody .tutban .tutbant")).toHaveText("New to Alerts? Take the tour");
  await page.evaluate(() => closeMovingScreen());
  await page.locator("#findBtn").click();
  await expect(page.locator("#findScreen")).toHaveClass(/open/);
  await expect(page.locator("#findBody .tutban .tutbant")).toHaveText("New to Database? Take the tour");
  await expect(page.locator("#findBody .tutban .tutbans")).toHaveText("1 minute · search every film, anywhere");
});

test("CAS-1702 AC4: X hides Watch's banner for the visit, it returns next visit, and the dismissed visit counts", async ({ page }) => {
  await guestOnboarded(page);
  await fakeSignedIn(page, 0);
  const ban = page.locator("#tutbanSlot .tutban");
  await expect(ban).toBeVisible();
  await ban.locator(".tutbanx").click();
  await expect(ban).toHaveCount(0);
  await awayFor(page, 31);
  await expect(ban).toBeVisible();
  expect(await page.evaluate(() => tutSeenMap.watch.shown)).toBe(2);
  expect(await page.evaluate(() => tutSeenMap.watch.dismissed)).toBe(1);
});

test("CAS-1702 AC5: View tutorial on Taste starts the Taste tour; its banner never returns", async ({ page }) => {
  await guestOnboarded(page);
  await fakeSignedIn(page, 0);
  await openTaste(page);
  await page.locator("#agentsBody .tutban .tutbango").click();
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);
  await page.evaluate(() => endTutorial(true));
  await awayFor(page, 31);
  await page.evaluate(() => { if($("agentsScreen").classList.contains("open")) closeAgentsScreen(); });
  await openTaste(page);
  await expect(page.locator("#agentsBody .oarow").first()).toBeVisible();
  await expect(page.locator("#agentsBody .tutban")).toHaveCount(0);
});

test("CAS-1702 AC6: the banner pulses 3 times; none with reduced motion", async ({ page, browser }) => {
  await guestOnboarded(page);
  await fakeSignedIn(page, 0);
  await expect(page.locator("#tutbanSlot .tutban")).toBeVisible();
  expect(await page.locator("#tutbanSlot .tutban").evaluate(e => getComputedStyle(e).animationIterationCount)).toBe("3");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator("#tutbanSlot .tutban").evaluate(e => getComputedStyle(e).animationName)).toBe("none");
});

test("CAS-1551 banner: View tutorial plays the tour and marks it played", async ({ page }) => {
  await guestOnboarded(page);
  await fakeSignedIn(page, 2);
  await openTaste(page);
  await page.locator("#agentsBody .tutban .tutbango").click();
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);
  expect(await page.evaluate(() => tutSeenMap.agent.played)).toBe(true);
});

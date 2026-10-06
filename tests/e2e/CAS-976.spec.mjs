// CAS-976: the first-run tutorial — five coach marks over the real listing controls, shown once per
// account the first time the listing paints after onboarding. These drive a genuine fresh account through
// finishFlow/toListing (same recipe as CAS-969's own spec) rather than calling startTutorial() as the
// primary path, so the automatic trigger itself — membStartWork's own maybeStartTutorial() call — is what's
// under test, not just the tour mechanics in isolation.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

const CARD_TEXT = [
  "Your agents live in this menu. Each one watches for a different kind of film, all the time, so you don't have to.",
  "Two numbers: what people thought, and what critics thought. Your agent only speaks up when a film clears the bar you set.",
  "Films move — cinema, then rent, then streaming. Your agent follows each one and tells you when it reaches a window you actually use.",
  "Alerts shows what your agents have found for you — Today, Week, 2 weeks or Month. It opens on Today.",
  "You're set. Nothing more to do today — your agents report at 5pm.",
];

async function buildFreshListing(page){
  await toShortlist(page, "cinema");
  await finishFlow(page);
  // Every other spec's toListing() clears the tour automatically (helpers.mjs) so it doesn't intercept
  // clicks on a listing that has nothing to do with it — this suite is the one caller that wants to see it
  // as it actually first appears.
  await toListing(page, { skipTutorial: false });
}

test("CAS-976: a fresh account sees all five cards verbatim, in order, ending on the anchorless closer", async ({ page }) => {
  await buildFreshListing(page);

  await expect(page.locator("#tutScrim")).toHaveClass(/open/);
  for(let i = 0; i < CARD_TEXT.length; i++){
    await expect(page.locator("#tutText")).toHaveText(CARD_TEXT[i]);
    const isLast = i === CARD_TEXT.length - 1;
    await expect(page.locator("#tutNextBtn")).toHaveText(isLast ? "Done" : "Next");
    if(isLast){
      // The closing card has no anchor — tutorialReposition() collapses the hole to a zero-size box
      // rather than pointing it at anything, so the screen dims evenly with no spotlight.
      await expect(page.locator("#tutHole")).toHaveCSS("width", "0px");
      await expect(page.locator("#tutHole")).toHaveCSS("height", "0px");
    }
    await page.locator("#tutNextBtn").click();
    await page.waitForTimeout(60);
  }
  await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);

  // "A second visit shows nothing" — finishing the tour marks it seen, so a reload of the same account's
  // device state doesn't replay it.
  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.waitForFunction(() => document.querySelectorAll("#groups .card, #groups .stub").length > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(300);
  await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);
});

test("CAS-976: the spotlight sits over the current card's own anchor, and follows a scroll", async ({ page }) => {
  await buildFreshListing(page);
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);

  // Card 2's anchor (a card's score row, inside the scrollable listing) actually moves when the page
  // scrolls — card 1's (#navMenuBtn, in the sticky header) wouldn't, which would prove nothing either way.
  await page.locator("#tutNextBtn").click();
  await expect(page.locator("#tutText")).toHaveText(CARD_TEXT[1]);
  await page.waitForTimeout(150);

  // CAS-1209: a condensed ("cinfo") card hides its own .r-scores via display:none rather than removing it
  // (tutorialResolveAnchor's own comment, app_template.html) — a plain .first() can resolve to one of
  // those on a real roster and return a null boundingBox. The app's own anchor resolution already skips
  // a hidden match; mirror that here with :visible so the anchor is the same element the tour itself used.
  const anchor = page.locator("#groups .card .r-scores:visible").first();
  const anchorBox = await anchor.boundingBox();
  let holeBox = await page.locator("#tutHole").boundingBox();
  expect(Math.abs(holeBox.x - anchorBox.x)).toBeLessThan(12);
  expect(Math.abs(holeBox.y - anchorBox.y)).toBeLessThan(12);

  await page.evaluate(() => window.scrollBy(0, 60));
  await page.waitForTimeout(150);
  const anchorBoxAfter = await anchor.boundingBox();
  expect(Math.abs(anchorBoxAfter.y - anchorBox.y)).toBeGreaterThan(20);   // the scroll actually moved it
  holeBox = await page.locator("#tutHole").boundingBox();
  expect(Math.abs(holeBox.x - anchorBoxAfter.x)).toBeLessThan(12);
  expect(Math.abs(holeBox.y - anchorBoxAfter.y)).toBeLessThan(12);
});

test("CAS-976: Skip on the first card marks the tour seen and it doesn't replay", async ({ page }) => {
  await buildFreshListing(page);
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);
  await expect(page.locator("#tutText")).toHaveText(CARD_TEXT[0]);

  await page.locator("#tutSkipBtn").click();
  await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);

  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.waitForFunction(() => document.querySelectorAll("#groups .card, #groups .stub").length > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(300);
  await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);
});

test("CAS-976: an anchor that isn't on screen is skipped, not pointed at", async ({ page }) => {
  await buildFreshListing(page);
  // Let the auto-started tour finish so state is clean, then drive a fresh run directly with the Moving
  // chip removed — startTutorial() re-resolves every anchor from scratch each time it's called.
  await page.locator("#tutSkipBtn").click();
  await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);

  await page.evaluate(() => { document.querySelector("#movingBtn")?.remove(); });
  await page.evaluate(() => startTutorial());
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);

  const seen = [];
  for(let i = 0; i < CARD_TEXT.length; i++){
    seen.push(await page.locator("#tutText").textContent());
    const label = await page.locator("#tutNextBtn").textContent();
    await page.locator("#tutNextBtn").click();
    await page.waitForTimeout(60);
    if(label.trim() === "Done") break;
  }
  expect(seen).not.toContain(CARD_TEXT[3]);   // the Moving card, whose anchor was removed
  expect(seen[seen.length - 1]).toBe(CARD_TEXT[4]);   // still ends on the anchorless closer
});

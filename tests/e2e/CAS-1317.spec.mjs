// CAS-1317: the guided tour v2 — replaces CAS-976's five coach marks with a 20-step script that shows the
// whole interface first, then drills into detail, driving the app itself (switching screens, expanding a
// card, opening the menu) rather than just pointing at fixed controls in place. These drive a genuine fresh
// account through finishFlow/toListing (same recipe as CAS-976's own spec) so the automatic trigger itself
// (membStartWork's own maybeStartTutorial() call) stays under test, not just the tour mechanics alone.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

// Verbatim per the ticket's own "Script (approved copy — use verbatim)" section.
const CARD_TEXT = [
  "Welcome to Cascade. Here's a one-minute tour of how it works.",
  "Cascade has four places. Here's what each one does.",
  "Watch — the films your agents have found, organised by where you can watch them: cinema, rental or streaming.",
  "Alerts — films you're tracking that have just arrived somewhere you watch.",
  "Find — search any film in Cascade, whether an agent found it or not.",
  "Agents — each one hunts for a different kind of film for you, every day.",
  "This is a film card. Tap any card to open it.",
  "Opened, it shows the full picture — the story, trailers, cast, and where to watch.",
  "Want company? Invite friends to watch it with you.",
  "Three buttons tell your agents what you want.",
  "When to watch. Your agent suggests the best time — cinema, rental or streaming — and you can change it any time. Listed for cinema but you'd rather wait? Tell it to wait for streaming. Not for you? Choose Never.",
  "Which agent found it. You can hand a film to a different agent — spot one the kids would love? Move it to your Family agent.",
  "Seen it? Tell your agents, and what you thought. Every verdict teaches them what you like.",
  "Public — one score combining what audiences and critics thought.",
  "You — how much you're likely to enjoy it. It appears once you've rated a few films. It starts from Public, then moves up or down depending on how you've rated films with a similar mix of styles, and gets sharper with every verdict.",
  "As films you're tracking reach cinemas, rental or your streaming services, they're listed here. We'll email you the same alerts, so you won't miss one.",
  "Search the whole catalogue and open any film.",
  "Agents are fully adjustable. Each one starts with sensible settings. As you rate films it learns your taste and suggests changes to its own settings, so it finds more of what you'll love.",
  "Change your streaming services here any time, and see which services suit you best.",
  "You're all set. Your agents report every day at 5pm.",
];

async function buildFreshListing(page){
  await toShortlist(page, "cinema");
  await finishFlow(page);
  // Every other spec's toListing() clears the tour automatically (helpers.mjs) so it doesn't intercept
  // clicks on a listing that has nothing to do with it — this suite is the one caller that wants to see it
  // as it actually first appears.
  await toListing(page, { skipTutorial: false });
}

function rectsOverlap(a, b){
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test("CAS-1317: a fresh account walks all 20 steps verbatim, in order, with the banner/progress and no overlap", async ({ page }) => {
  await buildFreshListing(page);
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);

  for(let i = 0; i < CARD_TEXT.length; i++){
    await expect(page.locator("#tutText")).toHaveText(CARD_TEXT[i]);
    await expect(page.locator(".tutbanner")).toContainText("Cascade tour");
    await expect(page.locator("#tutProg")).toHaveText(`${i + 1} of ${CARD_TEXT.length}`);
    const isLast = i === CARD_TEXT.length - 1;
    await expect(page.locator("#tutNextBtn")).toHaveText(isLast ? "Done" : "Next");
    // AC1: the tour card's box must never overlap the spotlight's box, on any step.
    const holeBox = await page.locator("#tutHole").boundingBox();
    const cardBox = await page.locator("#tutCard").boundingBox();
    expect(rectsOverlap(holeBox, cardBox)).toBe(false);
    await page.locator("#tutNextBtn").click();
    await page.waitForTimeout(80);
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

test("CAS-1317 AC2: step 2's spotlight contains all four nav chips together", async ({ page }) => {
  await buildFreshListing(page);
  await page.locator("#tutNextBtn").click();   // step 1 -> step 2
  await expect(page.locator("#tutText")).toHaveText(CARD_TEXT[1]);
  await page.waitForTimeout(150);

  const holeBox = await page.locator("#tutHole").boundingBox();
  for(const sel of ["#moviesBtn", "#movingBtn", "#findBtn", "#agentsBtn"]){
    const chipBox = await page.locator(sel).boundingBox();
    expect(chipBox.x).toBeGreaterThanOrEqual(holeBox.x - 1);
    expect(chipBox.y).toBeGreaterThanOrEqual(holeBox.y - 1);
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(holeBox.x + holeBox.width + 1);
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(holeBox.y + holeBox.height + 1);
  }
});

test("CAS-1317 AC3: the card expands at step 8, collapses at step 10, and Skip at step 12 leaves a clean Watch screen", async ({ page }) => {
  await buildFreshListing(page);
  for(let i = 0; i < 6; i++) await page.locator("#tutNextBtn").click();   // step 1 -> step 7 (the card)
  await expect(page.locator("#tutText")).toHaveText(CARD_TEXT[6]);
  const cardId = await page.evaluate(() => tourCardId);

  await page.locator("#tutNextBtn").click();   // step 7 -> step 8 (expand)
  await expect(page.locator("#tutText")).toHaveText(CARD_TEXT[7]);
  await expect(page.locator(`[id="card-${cardId}"]`)).toHaveClass(/expanded/);

  for(let i = 0; i < 2; i++) await page.locator("#tutNextBtn").click();   // step 8 -> step 10 (collapse)
  await expect(page.locator("#tutText")).toHaveText(CARD_TEXT[9]);
  await expect(page.locator(`[id="card-${cardId}"]`)).not.toHaveClass(/expanded/);

  for(let i = 0; i < 2; i++) await page.locator("#tutNextBtn").click();   // step 10 -> step 12 (Agent button)
  await expect(page.locator("#tutText")).toHaveText(CARD_TEXT[11]);

  await page.locator("#tutSkipBtn").click();
  await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);
  await expect(page.locator(`[id="card-${cardId}"]`)).not.toHaveClass(/expanded/);
  await expect(page.locator("#moviesBtn")).toHaveClass(/active/);
  await expect(page.locator(".uscreen.open")).toHaveCount(0);
  await expect(page.locator("#navMenu")).not.toHaveClass(/open/);
});

test("CAS-1317 AC4: step 15 shows a sample You chip when the card has none, and removes it on exit", async ({ page }) => {
  await buildFreshListing(page);
  for(let i = 0; i < 13; i++) await page.locator("#tutNextBtn").click();   // step 1 -> step 14 (Public)
  await expect(page.locator("#tutText")).toHaveText(CARD_TEXT[13]);
  const cardId = await page.evaluate(() => tourCardId);
  await expect(page.locator(`[id="card-${cardId}"] .qyou`)).toHaveCount(0);   // fresh account: no real You score yet

  await page.locator("#tutNextBtn").click();   // step 14 -> step 15 (You)
  await expect(page.locator("#tutText")).toHaveText(CARD_TEXT[14]);
  const sample = page.locator(`[id="card-${cardId}"] .qyou.tutsample`);
  await expect(sample).toHaveCount(1);
  await expect(sample).toContainText("88");

  await page.locator("#tutSkipBtn").click();
  await expect(page.locator(`[id="card-${cardId}"] .qyou`)).toHaveCount(0);   // removed again on exit
});

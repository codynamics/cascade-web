// CAS-1079: replaying the tour from Menu → Account while Moving is open underneath it used to leave two of
// the five cards (the score row and the notify control, both inside #groups .card) pointed at a covered,
// off-screen anchor instead of skipped — replayTutorial() only closed Account, and closing Account just
// uncovered whatever was open under it (Moving, in this repro), not the Watch listing the anchors live on.
// The fix (app_template.html) has replayTutorial() also call showAgentsHome(), the same "uncover the Watch
// listing" helper applyDeepLink() already uses, so Moving (or Agents) closes too before the tour starts.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

const CARD_TEXT = [
  "Your agents live in this menu. Each one watches for a different kind of film, all the time, so you don't have to.",
  "Two numbers: what people thought, and what critics thought. Your agent only speaks up when a film clears the bar you set.",
  "Films move — cinema, then rent, then streaming. Your agent follows each one and tells you when it reaches a window you actually use.",
  "Moving shows what's changed recently — Today, Week, 2 weeks or Month. It opens on 2 weeks, so that's the page to come back to.",
  "You're set. Nothing more to do today — your agents report at 5pm.",
];

test("CAS-1079: replaying the tour from Moving (via Help) uncovers the listing first, no card left anchorless", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);   // default skipTutorial:true — the automatic first-run tour is not what's under test

  await page.locator("#movingBtn").click();
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);

  // CAS-1159 requeue: CAS-1126 moved "Replay the tour" off the Account screen onto Help — the nesting
  // this test is about (opened on top of Moving, closing both before the tour starts) still applies, just
  // one menu item over.
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Help" }).click();
  await expect(page.locator("#helpScreen")).toHaveClass(/open/);
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);   // still nested underneath

  await page.locator("#helpScreen .urow", { hasText: "Replay the tour" }).click();

  // Both screens it was nested under are gone — "no scrim may be left on screen" — and the tour is the only
  // thing showing.
  await expect(page.locator("#helpScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#movingScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);

  const seen = [];
  for(let i = 0; i < CARD_TEXT.length; i++){
    seen.push(await page.locator("#tutText").textContent());
    const label = await page.locator("#tutNextBtn").textContent();
    await page.locator("#tutNextBtn").click();
    await page.waitForTimeout(60);
    if(label.trim() === "Done") break;
  }
  // The Watch listing is uncovered before the tour starts, so all five cards resolve — same as starting the
  // tour from the Watch screen directly, per the ticket's own repro.
  expect(seen).toEqual(CARD_TEXT);
  await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);
});

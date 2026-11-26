// CAS-1079: replaying the tour from Menu → Account while Moving is open underneath it used to leave two of
// the five cards (the score row and the notify control, both inside #groups .card) pointed at a covered,
// off-screen anchor instead of skipped — replayTutorial() only closed Account, and closing Account just
// uncovered whatever was open under it (Moving, in this repro), not the Watch listing the anchors live on.
// The fix (app_template.html) has replayTutorial() also call showAgentsHome(), the same "uncover the Watch
// listing" helper applyDeepLink() already uses, so Moving (or Agents) closes too before the tour starts.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

// CAS-1548: the five-card tour this spec used to pin verbatim is gone — replayTutorial() now plays the Watch
// tutorial (TOURS.watch) for a one-agent account. Its card text changes with product copy, so this no longer
// hard-codes it: it plays the tour once straight from the Watch listing (the reference run), then again via
// Moving -> Help -> Replay, and requires the same cards — a card pointed at a covered anchor would be skipped
// and the two runs would differ.
async function playTour(page){
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);
  const seen = [];
  for(let i = 0; i < 80; i++){
    seen.push((await page.locator("#tutText").textContent()).trim());
    const label = (await page.locator("#tutNextBtn").textContent()).trim();
    await page.locator("#tutNextBtn").click();
    await page.waitForTimeout(60);
    if(label === "Done") break;
  }
  await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);
  return seen;
}

test("CAS-1079: replaying the tour from Moving (via Help) uncovers the listing first, no card left anchorless", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);   // default skipTutorial:true — the automatic first-run tour is not what's under test

  // Reference run: TOURS.watch started with the Watch listing already uncovered.
  await page.evaluate(() => startTour("watch"));
  const reference = await playTour(page);
  expect(reference[0]).toContain("quick tour of");
  expect(reference.length).toBeGreaterThan(5);

  await page.locator("#movingBtn").click();
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);

  // CAS-1159 requeue: CAS-1126 moved "Replay the tour" off the Account screen onto Help — the nesting
  // this test is about (opened on top of Moving, closing both before the tour starts) still applies.
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Help" }).click();
  await expect(page.locator("#helpScreen")).toHaveClass(/open/);
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);   // still nested underneath

  await page.locator("#helpScreen .urow", { hasText: "Replay the Watch tutorial" }).click();

  // Both screens it was nested under are gone — "no scrim may be left on screen" — and the tour is the only
  // thing showing, and it is the Watch tutorial.
  await expect(page.locator("#helpScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#movingScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);
  expect(await page.evaluate(() => tutKey)).toBe("watch");

  expect(await playTour(page)).toEqual(reference);
});

// CAS-1152: the tour's spotlight (#tutHole) and card (#tutCard) are positioned by tutorialReposition()
// writing geometry read via getBoundingClientRect()/offsetWidth/offsetHeight straight into .style — under
// Chromium's `zoom:var(--ui-scale)` (CAS-157) those reads come back post-zoom while a plain style write
// lands pre-zoom, so every value landed 1.12x off (not reproduced in WebKit, which doesn't split the two
// conventions this way). This spec runs under both engines and checks the actual rendered geometry, not
// just that the feature "looks present".
//
// Guest mode (freshApp + walkToServices), not helpers.mjs's toShortlist/freshAppSignedIn — those need a
// local Supabase stack (Docker), which this sandbox has neither reason nor means to spin up for a pure
// client-side layout bug. Guest mode reaches the same real listing with real agents since membStart()
// only gates on email when CascadeAuth is configured (CAS-1030), which it isn't under freshApp's own
// config.js 404.
import { test, expect } from "@playwright/test";
import { freshApp, walkToServices, finishFlow, toListing } from "./helpers.mjs";

async function buildFreshListing(page){
  await freshApp(page);
  await page.waitForFunction(() => flowOn === true || document.querySelector("#splashCta"));
  if(!(await page.evaluate(() => flowOn === true))) await page.locator("#splashCta").click();
  await walkToServices(page, "cinema");
  await finishFlow(page);
  await toListing(page, { skipTutorial: false });
}

/** Anchor box (Playwright's {x,y,width,height} shape) expanded by the tour's own 8px pad, same math
 * tutorialReposition() targets. */
function padded(box, pad = 8){
  return { left: box.x - pad, top: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
}

test("CAS-1152: the spotlight hole matches its anchor's real rect (plus pad) on every anchored card, no double-zoom drift", async ({ page }) => {
  await buildFreshListing(page);
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);

  // startTutorial() drops any of the 4 anchored cards whose selector doesn't resolve on screen (own
  // comment at tutorialResolveAnchor) and always keeps at least 2 — so walk by "does the CURRENT card
  // have an anchor" rather than assuming card indices 1-4 all survived.
  let checked = 0;
  while(await page.evaluate(() => !!(tutCards[tutIdx] && tutCards[tutIdx].el))){
    const anchorHandle = await page.evaluateHandle(() => tutCards[tutIdx].el);
    const anchorBox = await anchorHandle.asElement().boundingBox();
    const want = padded(anchorBox);
    const holeBox = await page.locator("#tutHole").boundingBox();

    expect(Math.abs(holeBox.x - want.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(holeBox.y - want.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(holeBox.width - want.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(holeBox.height - want.height)).toBeLessThanOrEqual(1);

    // #tutCard stays fully inside the viewport and beside its hole, in both engines.
    const vp = page.viewportSize();
    const cardBox = await page.locator("#tutCard").boundingBox();
    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.y).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(vp.width + 1);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(vp.height + 1);

    checked++;
    const label = (await page.locator("#tutNextBtn").textContent()).trim();
    if(label === "Done") break;
    await page.locator("#tutNextBtn").click();
    await page.waitForTimeout(80);
  }
  expect(checked).toBeGreaterThanOrEqual(2);   // the app's own floor — see tutorialResolveAnchor's comment
});

test("CAS-1152: the closing, anchorless card stays centred", async ({ page }) => {
  await buildFreshListing(page);
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);

  // Walk to the final (anchorless) card — same loop shape as CAS-976's own spec.
  for(let i = 0; i < 10; i++){
    const label = await page.locator("#tutNextBtn").textContent();
    if(label.trim() === "Done") break;
    await page.locator("#tutNextBtn").click();
    await page.waitForTimeout(80);
  }
  await expect(page.locator("#tutHole")).toHaveCSS("width", "0px");
  await expect(page.locator("#tutHole")).toHaveCSS("height", "0px");

  const vp = page.viewportSize();
  const holeBox = await page.locator("#tutHole").boundingBox();
  expect(Math.abs(holeBox.x - vp.width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(holeBox.y - vp.height / 2)).toBeLessThanOrEqual(1);

  const cardBox = await page.locator("#tutCard").boundingBox();
  expect(cardBox.x).toBeGreaterThanOrEqual(0);
  expect(cardBox.y).toBeGreaterThanOrEqual(0);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(vp.width + 1);
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(vp.height + 1);
});

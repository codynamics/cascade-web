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
  // The tour is now v2 (CAS-1317): steps live in tutSteps, the resolved anchors of the current one in
  // tutCurrent.els (one or several; several => 1px pad, a single one => 6px pad, same as tutorialReposition).
  // Steps with no anchors (els empty) have a zero-size hole and are not checked here.
  for(let guard = 0; guard < 30; guard++){
    await page.waitForTimeout(700);   // the tour card/hole is placed once the page under it has settled
    const rects = await page.evaluate(() => (tutCurrent && tutCurrent.els ? tutCurrent.els : []).map(el => {
      const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }));
    if(rects.length){
      const pad = rects.length > 1 ? 1 : 6;
      const left = Math.min(...rects.map(r => r.left)), top = Math.min(...rects.map(r => r.top));
      const right = Math.max(...rects.map(r => r.right)), bottom = Math.max(...rects.map(r => r.bottom));
      const want = { left: left - pad, top: top - pad, width: right - left + pad * 2, height: bottom - top + pad * 2 };
      const holeBox = await page.locator("#tutHole").boundingBox();

      expect(Math.abs(holeBox.x - want.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(holeBox.y - want.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(holeBox.width - want.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(holeBox.height - want.height)).toBeLessThanOrEqual(1);
      checked++;
    }
    // #tutCard stays fully inside the viewport and beside its hole, in both engines.
    const vp = page.viewportSize();
    const cardBox = await page.locator("#tutCard").boundingBox();
    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.y).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(vp.width + 1);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(vp.height + 1);

    const label = (await page.locator("#tutNextBtn").textContent()).trim();
    if(label === "Done") break;
    await page.locator("#tutNextBtn").click();
    await page.waitForTimeout(80);
  }
  expect(checked).toBeGreaterThanOrEqual(2);
});

test("CAS-1152: the closing card (v2 Watch tour, anchored on the menu button) hugs its anchor and stays on screen", async ({ page }) => {
  await buildFreshListing(page);
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);

  // Walk to the final card — same loop shape as CAS-976's own spec. Since the v2 tour (CAS-1317) the closing
  // step is anchored on #navMenuBtn (a 6px-padded ring), no longer an anchorless centred card, so the hole is
  // checked against that anchor's real rect rather than against the viewport centre.
  for(let i = 0; i < 30; i++){
    const label = await page.locator("#tutNextBtn").textContent();
    if(label.trim() === "Done") break;
    await page.locator("#tutNextBtn").click();
    await page.waitForTimeout(80);
  }
  await expect(page.locator("#tutNextBtn")).toHaveText("Done");
  await page.waitForTimeout(700);   // the card/hole is placed once the page under it has settled

  const rects = await page.evaluate(() => (tutCurrent && tutCurrent.els ? tutCurrent.els : []).map(el => {
    const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }));
  expect(rects.length).toBeGreaterThan(0);
  const pad = rects.length > 1 ? 1 : 6;
  const left = Math.min(...rects.map(r => r.left)), top = Math.min(...rects.map(r => r.top));
  const right = Math.max(...rects.map(r => r.right)), bottom = Math.max(...rects.map(r => r.bottom));
  const holeBox = await page.locator("#tutHole").boundingBox();
  expect(Math.abs(holeBox.x - (left - pad))).toBeLessThanOrEqual(1);
  expect(Math.abs(holeBox.y - (top - pad))).toBeLessThanOrEqual(1);
  expect(Math.abs(holeBox.width - (right - left + pad * 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(holeBox.height - (bottom - top + pad * 2))).toBeLessThanOrEqual(1);

  const vp = page.viewportSize();
  const cardBox = await page.locator("#tutCard").boundingBox();
  expect(cardBox.x).toBeGreaterThanOrEqual(0);
  expect(cardBox.y).toBeGreaterThanOrEqual(0);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(vp.width + 1);
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(vp.height + 1);
});

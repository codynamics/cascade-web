// CAS-1350: the first-run flow (?oneagent=setup) left #oafScreen's "open" class off whenever control handed
// back to it mid-flow, so a painted step stayed display:none with the fixed header/nav floating over the app
// underneath with nothing to tap. window.oafOpen() is the entry point itself (neither the account's
// ?oneagent=setup URL param nor "Preview setup ›" gate it), so this drives it directly in guest mode, exactly
// as CAS-1349's own first-run trigger does — every click from there on is the real UI, per helpers.mjs's
// "anything a person does, the test clicks" rule.
// CAS-1354: this spec runs in CI as part of `npm run test:e2e` on every staging push.
// CAS-1368: the middle of the flow was replaced — favourite genres, age, partner/children/family — retiring
// the CAS-1346/1347 scores+alerts wizard (#oneAgentSetupScreen) and the "Who do you watch with?" step this
// spec used to drive. Covers the new screens' own order/skip rules (AC1) end to end.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

// CAS-1361 AC2/AC5: every #oafScreen step's .osh heading must clear the fixed #oafHdr, not sit behind it
// (.sharpstep.chromed .osinner's padding-top, added by this ticket).
async function expectHeadingBelowHeader(page){
  const hdrBox = await page.locator("#oafHdr").boundingBox();
  const oshBox = await page.locator("#oafInner .osh").boundingBox();
  expect(oshBox.y).toBeGreaterThanOrEqual(hdrBox.y + hdrBox.height);
}

// CAS-1699: the order is welcome, who, services, topSvc, favourites, people, done (no together/family screens).
test("CAS-1350/CAS-1699: the first run completes end to end, welcome through Start watching — partner and kids both on", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());

  await expect(page.locator("#oafScreen")).toHaveClass(/open/);
  await expect(page.locator("#oafInner .osh")).toHaveText("Let's get you set up.");
  await expectHeadingBelowHeader(page);
  await page.locator("#oafCta").click();   // welcome -> who

  await expect(page.locator("#oafInner .osh")).toHaveText("Who watches movies with you?");
  await expectHeadingBelowHeader(page);
  await expect(page.locator("#oafCta")).toBeDisabled();
  await page.locator('.whopill[data-field="age"][data-val="18plus"]').click();
  await page.locator('.whotile[data-who="partner"]').click();
  await page.locator('.whotile[data-who="children"]').click();
  await expect(page.locator("#oafCta")).toBeEnabled();
  await page.locator("#oafCta").click();   // who -> services

  await expect(page.locator("#oafInner .osh")).toHaveText("Which services do you have?");
  await expectHeadingBelowHeader(page);
  await expect(page.locator("#oafSvcStores")).toBeVisible();
  await expect(page.locator("#oafSvcSubs")).toBeVisible();
  await page.locator("#oafCta").click();   // services -> favourites (under 2 streaming services: no topSvc)

  // CAS-1699: every genre starts Off, so Continue is disabled until at least one is Include or Favourite.
  await expect(page.locator("#oafInner .osh")).toHaveText("Your favourite genres");
  await expectHeadingBelowHeader(page);
  await expect(page.locator('.favcell[data-style="Comedy"]')).not.toHaveClass(/ on/);
  await expect(page.locator("#oafCta")).toBeDisabled();
  await page.locator('.favcell[data-style="Action"] .favbtn.heart').click();
  await page.locator('.favcell[data-style="Drama"] .favbtn.check').click();
  await expect(page.locator('.favcell[data-style="Action"]')).toHaveClass(/fav/);
  await expect(page.locator('.favcell[data-style="Drama"]')).toHaveClass(/incl/);
  await expect(page.locator("#oafCta")).toBeEnabled();
  await page.locator("#oafCta").click();   // favourites -> people (no together, no family screens)

  // Lee, 14 Nov: an optional favourite actor or director (one box); empty, the CTA reads Skip.
  await expect(page.locator("#oafInner .osh")).toHaveText("A favourite actor or director?");
  await expectHeadingBelowHeader(page);
  await expect(page.locator("#oafCta")).toHaveText("Skip");
  await page.locator("#oafCta").click();   // people -> done

  await expect(page.locator("#oafInner .osh")).toHaveText("Your agent is ready.");
  await expectHeadingBelowHeader(page);
  await expect(page.locator("#oafInner .oafdtold .oafdtoldh")).toHaveText("Your agent is working for you");
  await expect(page.locator("#oafDoneCount")).not.toHaveText("0", { timeout: 4000 });
  await expect(page.locator("#oafCta")).toHaveText("Proceed");
  // CAS-1368: the moods table follows the answers (partner+kids both on) — and the done screen shows it.
  await expect(page.locator("#oafInner .oafdmood"))
    .toHaveText(["Cinema releases", "Me", "Partner", "Family"]);   // no Starred (Lee, 14 Nov)
  await page.locator("#oafCta").click();

  // CAS-1361 part 1: after Start watching, the setup header/nav must not float over Watch underneath.
  await expect(page.locator("#oafScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#oafHdr")).toBeHidden();
  await expect(page.locator("#oafNav")).toBeHidden();
});

test("CAS-1699: under 18 with no partner goes favourites -> people", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  await page.locator("#oafCta").click();   // welcome -> who
  await page.locator('.whopill[data-field="age"][data-val="under18"]').click();
  await page.locator("#oafCta").click();   // who -> services
  await page.locator("#oafCta").click();   // services -> favourites
  await page.locator('.favcell[data-style="Action"] .favtoggle').click();
  await page.locator("#oafCta").click();   // favourites -> people (no together, no family)

  await expect(page.locator("#oafInner .osh")).toHaveText("A favourite actor or director?");
});

test("CAS-1350 AC3: '‹ Back' from the services step shows the who step visibly, not the app behind it", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  await page.locator("#oafCta").click();   // welcome -> who
  await page.locator('.whopill[data-field="age"][data-val="under18"]').click();
  await page.locator("#oafCta").click();   // who -> services

  await expect(page.locator("#oafInner .osh")).toHaveText("Which services do you have?");
  await page.locator("#oafBack").click();   // services' own back

  await expect(page.locator("#oafScreen")).toHaveClass(/open/);
  await expect(page.locator("#oafInner .osh")).toHaveText("Who watches movies with you?");
});

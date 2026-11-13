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

test("CAS-1350/CAS-1368: the first run completes end to end, welcome through Start watching — partner and children both yes", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());

  await expect(page.locator("#oafScreen")).toHaveClass(/open/);
  await expect(page.locator("#oafInner .osh")).toHaveText("Let's get you set up.");
  await expectHeadingBelowHeader(page);
  await page.locator("#oafCta").click();   // welcome -> where

  await expect(page.locator("#oafInner .osh")).toHaveText("Where do you watch movies?");
  await expectHeadingBelowHeader(page);
  await page.locator('#oafWhereOpts .obopt[data-val="cinema"]').click();
  await page.locator("#oafCta").click();   // where -> favourites (no services step, cinema only)

  // Lee, 13 Nov (pm): every genre starts on ✓, so Continue is ready at once; switching every genre Off
  // disables it again (CAS-1368's "at least one genre" rule still holds).
  await expect(page.locator("#oafInner .osh")).toHaveText("Your favourite genres");
  await expectHeadingBelowHeader(page);
  await expect(page.locator('.favcell[data-style="Comedy"]')).toHaveClass(/ on incl/);
  await expect(page.locator("#oafCta")).toBeEnabled();
  await page.evaluate(() => document.querySelectorAll("#oafFavGrid .favbtn.off").forEach(b => b.click()));
  await expect(page.locator("#oafCta")).toBeDisabled();
  await page.locator('.favcell[data-style="Action"] .favbtn.heart').click();
  await page.locator('.favcell[data-style="Drama"] .favbtn.check').click();
  await expect(page.locator('.favcell[data-style="Action"]')).toHaveClass(/fav/);
  await expect(page.locator('.favcell[data-style="Drama"]')).toHaveClass(/incl/);
  await expect(page.locator("#oafCta")).toBeEnabled();
  await page.locator("#oafCta").click();   // favourites -> age

  await expect(page.locator("#oafInner .osh")).toHaveText("How old are you?");
  await expectHeadingBelowHeader(page);
  await expect(page.locator("#oafCta")).toBeDisabled();
  await page.locator('#oafAgeOpts .obopt[data-val="18plus"]').click();
  await page.locator("#oafCta").click();   // age -> partner

  await expect(page.locator("#oafInner .osh")).toHaveText("Do you watch with a partner?");
  await expectHeadingBelowHeader(page);
  await page.locator('#oafPartnerOpts .obopt[data-val="yes"]').click();
  await page.locator("#oafCta").click();   // partner (yes) -> together

  await expect(page.locator("#oafInner .osh")).toHaveText("What do you watch together?");
  await expectHeadingBelowHeader(page);
  // Pre-ticked with the favourites step's own picks (Action/Drama).
  // Lee, 11 Nov: Date night pre-ticks a fixed five (ONE_AGENT_TOGETHER_DEFAULT), not the person's own picks.
  for(const s of ["Comedy","Documentary","Romance","Mystery","Drama"])
    await expect(page.locator(`.favcell[data-style="${s}"]`)).toHaveClass(/ on incl/);   // Lee, 13 Nov: middle setting
  await expect(page.locator('.favcell[data-style="Action"]')).not.toHaveClass(/on/);
  await page.locator("#oafCta").click();   // together -> children (18 or over)

  await expect(page.locator("#oafInner .osh")).toHaveText("Do you watch with a young family?");
  await expectHeadingBelowHeader(page);
  await page.locator('#oafChildrenOpts .obopt[data-val="yes"]').click();
  await page.locator("#oafCta").click();   // children (yes) -> family

  await expect(page.locator("#oafInner .osh")).toHaveText("What do you watch as a family?");
  await expectHeadingBelowHeader(page);
  // Pre-ticked with the usual family genres (ticket's own default list).
  await expect(page.locator('.favcell[data-style="Family"]')).toHaveClass(/on/);
  await expect(page.locator('.favcell[data-style="Animation"]')).toHaveClass(/on/);
  await page.locator("#oafCta").click();   // family -> name your agent

  await expect(page.locator("#oafInner .osh")).toHaveText("Name your agent");
  await expectHeadingBelowHeader(page);
  await expect(page.locator("#oafCta")).toBeDisabled();
  await page.locator('#oafNameChips .chip[data-name="Nova"]').click();
  await expect(page.locator("#oafNameInput")).toHaveValue("Nova");
  await expect(page.locator("#oafCta")).toBeEnabled();
  await page.locator("#oafCta").click();   // name your agent -> done

  // Lee, 13 Nov (pm): the done screen is the payoff — the named agent, a count of what it found, the answers played back.
  await expect(page.locator("#oafInner .osh")).toHaveText("Nova is ready.");
  await expectHeadingBelowHeader(page);
  await expect(page.locator("#oafInner .oafdtold .oafdtoldh")).toHaveText("Nova is working for you");
  await expect(page.locator("#oafDoneCount")).not.toHaveText("0", { timeout: 4000 });
  await expect(page.locator("#oafCta")).toHaveText("Proceed");
  // CAS-1368: the moods table follows the answers (partner+kids both yes) — and the done screen shows it (Lee, 13 Nov).
  await expect(page.locator("#oafInner .oafdmood"))
    .toHaveText(["All Latest", "Best of the best", "Me", "Partner", "Family"]);   // no Starred (Lee, 14 Nov)
  await page.locator("#oafCta").click();

  // CAS-1361 part 1: after Start watching, the setup header/nav must not float over Watch underneath.
  await expect(page.locator("#oafScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#oafHdr")).toBeHidden();
  await expect(page.locator("#oafNav")).toBeHidden();
});

test("CAS-1368 AC1: under 18 skips children and family, and 'No' to partner skips together", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  await page.locator("#oafCta").click();   // welcome -> where
  await page.locator('#oafWhereOpts .obopt[data-val="cinema"]').click();
  await page.locator("#oafCta").click();   // where -> favourites
  await page.locator('.favcell[data-style="Comedy"] .favbtn.check').click();
  await page.locator("#oafCta").click();   // favourites -> age

  await page.locator('#oafAgeOpts .obopt[data-val="under18"]').click();
  await page.locator("#oafCta").click();   // age -> partner

  await page.locator('#oafPartnerOpts .obopt[data-val="no"]').click();
  await page.locator("#oafCta").click();   // partner (no) -> straight to name your agent, skipping together/children/family

  await expect(page.locator("#oafInner .osh")).toHaveText("Name your agent");
});

test("CAS-1368 AC1: 'Which services do you have?' is skipped when only Cinema is picked, shown when Stream is also picked", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  await page.locator("#oafCta").click();   // welcome -> where
  await page.locator('#oafWhereOpts .obopt[data-val="cinema"]').click();
  await page.locator('#oafWhereOpts .obopt[data-val="stream"]').click();
  await page.locator("#oafCta").click();   // where -> services (Stream picked)

  await expect(page.locator("#oafInner .osh")).toHaveText("Which services do you have?");
});

test("CAS-1350 AC3: '‹ Back' from the favourites step shows the where step visibly, not the app behind it", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  await page.locator("#oafCta").click();   // welcome -> where
  await page.locator('#oafWhereOpts .obopt[data-val="cinema"]').click();
  await page.locator("#oafCta").click();   // where -> favourites

  await expect(page.locator("#oafInner .osh")).toHaveText("Your favourite genres");
  await page.locator("#oafBack").click();   // favourites' own back

  await expect(page.locator("#oafScreen")).toHaveClass(/open/);
  await expect(page.locator("#oafInner .osh")).toHaveText("Where do you watch movies?");
});

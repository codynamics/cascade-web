// CAS-1593 (rewritten by CAS-1690): the list sheet's genre rows at the 390x844 frame — the Off / Include / Favourite
// control. Asserts: no Override segment / Taste link / thumb; tapping the genre name toggles Off <-> Include; the ♥
// segment makes a Favourite; All on / All off set every genre.
import { test, expect } from "@playwright/test";
import { guestOnboarded } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 } });

async function openSheet(page){
  await guestOnboarded(page);
  await page.evaluate(() => {
    const al = { cinema:false, rent:false, stream:false };
    cascades.length = 0;
    cascades.push({ id: cascadeNewId(), name: "Agent", v: 2, combo: {}, seenAdj: {}, seenAdjAt: {}, dismissed: [],
      styles: { Action:{ bar:60, al }, Drama:{ bar:65, al }, Comedy:{ bar:70, al } } });
    saveCascades();
    setActive(cascades[0].id);
    watchMoods = [{ ...oamMoodDefaultFields(), id: "cas1593", name: "Levels", styles: [], favs: [] }];
    watchMoodSel = "cas1593";
    render();
    window.openOamMoodSheetFor("cas1593");
    if (!oamSecOpen.has("primary")) window.oamToggleSec("primary");
  });
  await expect(page.locator("#watchSheet")).toHaveClass(/open/);
  await expect(page.locator("#watchSheetBody .favcell").first()).toBeVisible();
}

test("CAS-1593 AC2a: the list sheet has no Override segment, Taste link or thumb", async ({ page }) => {
  await openSheet(page);
  await expect(page.locator("#watchSheetBody .oamlvlseg, #watchSheetBody .oamtastelink, #watchSheetBody .oamthumb")).toHaveCount(0);
  await expect(page.locator("#watchSheetBody .oamallbtns button")).toHaveCount(2);
});

test("CAS-1593 AC2b: tapping a genre's name toggles it Off <-> Include (as in onboarding)", async ({ page }) => {
  await openSheet(page);
  const cell = page.locator('#watchSheetBody .favcell[data-style="Action"]');
  await cell.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => oamDraftTicked(oamDraft, "Action"));
  await cell.locator(".favtoggle").click();
  expect(await page.evaluate(() => oamDraftTicked(oamDraft, "Action"))).toBe(!before);
  await page.locator('#watchSheetBody .favcell[data-style="Action"] .favtoggle').click();
  expect(await page.evaluate(() => oamDraftTicked(oamDraft, "Action"))).toBe(before);
});

test("CAS-1593 AC2c: the ♥ segment makes a Favourite, and the summary counts it", async ({ page }) => {
  await openSheet(page);
  const cell = page.locator('#watchSheetBody .favcell[data-style="Action"]');
  await cell.scrollIntoViewIfNeeded();
  await cell.locator('[data-pick="fav"]').click();
  expect(await page.evaluate(() => oamDraft.picks.Action)).toBe("fav");
  await expect(page.locator("#watchSheetBody .oamsecsum").first()).toContainText("1 favourite");
});

test("CAS-1593 AC2d: All off clears every genre; All on turns them all to Include", async ({ page }) => {
  await openSheet(page);
  await page.locator("#watchSheetBody .oamallbtns button", { hasText: "All off" }).click();
  expect(await page.evaluate(() => Object.keys(oamDraft.picks).length)).toBe(0);
  await page.locator("#watchSheetBody .oamallbtns button", { hasText: "All on" }).click();
  expect(await page.evaluate(() => ALL_GENRES.every(g => oamDraft.picks[g] === "incl"))).toBe(true);
});

// CAS-1593: the list sheet's genre levels — five-stop rows and the Set all genres box, at the 390x844 frame.
// Asserts: no Override segment / Taste link / thumb; the genre name never toggles the tick; a tap on the exact
// junction between boxes 2 and 3 picks Top 10%; Set all genres at 50% makes every ticked row read Top 50%.
// (The iPhone long-press magnifier is Lee's to judge on device — it cannot be checked here.)
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
    watchMoods = [{ ...oamMoodDefaultFields(), id: "cas1593", name: "Levels", styles: [], levels: {} }];
    watchMoodSel = "cas1593";
    render();
    window.openOamMoodSheetFor("cas1593");
    if (!oamSecOpen.has("primary")) window.oamToggleSec("primary");
  });
  await expect(page.locator("#watchSheet")).toHaveClass(/open/);
  await expect(page.locator("#watchSheetBody .oamlvlrow").first()).toBeVisible();
}

test("CAS-1593 AC2a: the list sheet has no Override segment, Taste link or thumb", async ({ page }) => {
  await openSheet(page);
  await expect(page.locator("#watchSheetBody .oamlvlseg, #watchSheetBody .oamtastelink, #watchSheetBody .oamthumb")).toHaveCount(0);
  await expect(page.locator("#watchSheetBody .oamlvlall")).toHaveCount(1);
});

test("CAS-1593 AC2b: clicking a genre row's name leaves its checkbox unchanged", async ({ page }) => {
  await openSheet(page);
  const row = page.locator('#watchSheetBody .oamlvlrow[data-style="Action"]');
  const box = row.locator("input[type=checkbox]");
  const before = await box.isChecked();
  await row.locator(".oamstylename").click();
  expect(await box.isChecked()).toBe(before);
  expect(await page.evaluate(() => oamDraftTicked(oamDraft, "Action"))).toBe(before);
});

test("CAS-1593 AC2c: clicking the track exactly between boxes 2 and 3 sets the row to Top 10%", async ({ page }) => {
  await openSheet(page);
  const row = page.locator('#watchSheetBody .oamlvlrow[data-style="Action"]');
  await row.scrollIntoViewIfNeeded();
  const r = await row.locator(".oamlvltrack").boundingBox();
  await page.mouse.click(r.x + r.width * 0.4, r.y + r.height / 2);
  await expect(row.locator(".oamlvlval b")).toHaveText("Top 10%");
  expect(await page.evaluate(() => oamDraft.levels.Action)).toBe(10);
});

test("CAS-1593 AC2d: Set all genres at 50% makes every ticked row read Top 50%", async ({ page }) => {
  await openSheet(page);
  const all = page.locator("#watchSheetBody .oamlvlall");
  await all.scrollIntoViewIfNeeded();
  const r = await all.locator(".oamlvltrack").boundingBox();
  await page.mouse.click(r.x + r.width * 0.8, r.y + r.height / 2);   // the junction at the right end of box 4
  await expect(all.locator(".oamlvlval b")).toHaveText("Top 50%");
  const texts = await page.evaluate(() => [...document.querySelectorAll("#watchSheetBody .oamlvlrow:not(.off) .oamlvlval b")].map(b => b.textContent));
  expect(texts.length).toBeGreaterThan(0);
  texts.forEach(t => expect(t).toBe("Top 50%"));
});

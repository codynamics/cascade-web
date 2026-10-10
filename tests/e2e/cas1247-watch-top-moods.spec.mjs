// CAS-1247: Watch top — two stage groups (Cinema/Home), moods in place of the sort switch/search/Filters/
// agent lozenges, and a bar that collapses to one row on scroll. Drives the real guest flow (toShortlist/
// finishFlow/toListing), same convention every other tests/e2e spec in this file set uses — not run by CI
// (only tests/e2e/smoke.spec.mjs is), but kept here for a human or a later CC run to exercise directly.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toWatchScreen(page, kind = "stream"){
  await toShortlist(page, kind);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
}

test("AC1/AC2/AC3: stage groups, moods, and the removed controls", async ({ page }) => {
  await toWatchScreen(page);

  const labels = await page.locator("#watchTop .stgrplbl").allTextContents();
  expect(labels[0]).toBe("Cinema");
  expect(labels[1]).toBe("Home");
  const inCinemaName = page.locator('.stagestop[data-stage="in_cinema"] .stagename');
  if(await inCinemaName.count()) await expect(inCinemaName).toHaveText("Now showing");

  // AC1: at three widths, no .stagename overhangs its own button.
  for(const width of [360, 390, 430]){
    await page.setViewportSize({ width, height: 844 });
    const overhangs = await page.evaluate(() => {
      const range = document.createRange();
      return [...document.querySelectorAll(".stagestop")].filter(btn => {
        const name = btn.querySelector(".stagename");
        range.selectNodeContents(name);
        return range.getBoundingClientRect().width > btn.getBoundingClientRect().width + 0.5;
      }).length;
    });
    expect(overhangs, `at ${width}px wide`).toBe(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });

  const selectedBg = await page.locator(".stagestop.on").first().evaluate(el => getComputedStyle(el).backgroundColor);
  expect(selectedBg).toBe("rgba(124, 92, 255, 0.2)");

  // AC2: every removed control is gone.
  for(const sel of ["#watchTools", "#watchSortSwitch", "#watchSearchBtn", "#watchFilterBtn", ".watchagentrow", "#watchActiveFilters .chip"]){
    expect(await page.locator(sel).count(), sel).toBe(0);
  }

  // AC3: the two default moods, Top scores selected, filt.sort "cascade"; tapping Releases flips both.
  const chipNames = await page.locator(".moodchip").allTextContents();
  expect(chipNames[0]).toContain("Top scores");
  expect(chipNames[1]).toContain("Releases");
  await expect(page.locator('.moodchip[data-mood="top"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('.moodchip[data-mood="releases"]')).not.toHaveClass(/\bon\b/);
  expect(await page.evaluate(() => filt.sort)).toBe("cascade");

  await page.locator('.moodchip[data-mood="releases"]').click();
  await settleListing(page);
  await expect(page.locator('.moodchip[data-mood="releases"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('.moodchip[data-mood="top"]')).not.toHaveClass(/\bon\b/);
  expect(await page.evaluate(() => filt.sort)).toBe("cinema");
});

test("AC5: no account write on boot; selecting a mood pushes exactly one mood field", async ({ page }) => {
  await toWatchScreen(page);

  const pushed = await page.evaluate(() => {
    const calls = [];
    const orig = window.CascadePersistence && window.CascadePersistence.pushViewField;
    if(window.CascadePersistence) window.CascadePersistence.pushViewField = (k, v) => { calls.push(k); return orig ? orig(k, v) : undefined; };
    window.__cas1247Calls = calls;
    return true;
  });
  expect(pushed).toBe(true);
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => window.__cas1247Calls.length)).toBe(0);

  await page.locator('.moodchip[data-mood="releases"]').click();
  await settleListing(page);
  const calls = await page.evaluate(() => window.__cas1247Calls);
  expect(calls.filter(k => k === "mood")).toHaveLength(1);
  expect(calls).not.toContain("moods");
});

test("AC7/AC8: creating and deleting a mood", async ({ page }) => {
  await toWatchScreen(page);

  await page.locator("#moodAddBtn").click();
  await expect(page.locator("#watchSheetTitle")).toHaveText("New mood");
  await page.locator("#moodSaveBtn").click();
  await expect(page.locator(".moodchip")).toHaveCount(2);   // empty name saves nothing
  await expect(page.locator("#moodName")).toBeFocused();

  await page.locator("#moodName").fill("Friday");
  await page.locator("#moodSaveBtn").click();
  await expect(page.locator(".moodchip")).toHaveCount(3);
  await expect(page.locator('.moodchip[data-mood]').last()).toHaveClass(/\bon\b/);

  // Delete it back off: first tap arms, second tap (within 4s) deletes.
  await page.locator('.moodchip.on').click();
  await page.locator("#moodDeleteBtn").click();
  await expect(page.locator("#moodDeleteBtn")).toHaveText("Tap again to delete");
  await page.locator("#moodDeleteBtn").click();
  await expect(page.locator(".moodchip")).toHaveCount(2);
});

test("AC9/AC10: the bar collapses on scroll and reopens in place", async ({ page }) => {
  await toWatchScreen(page);
  const cardCount = await page.locator("#groups .card, #groups .stub").count();
  test.skip(cardCount < 4, "not enough cards on this catalogue build to scroll meaningfully");

  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(50);
  await expect(page.locator("#cascbar")).toHaveClass(/wtcollapsed/);
  await expect(page.locator("#watchTop")).not.toBeVisible();
  await expect(page.locator("#wtMini")).toBeVisible();
  await expect(page.locator("#wtMini")).toContainText("Change");

  await page.locator("#wtMini").click();
  await expect(page.locator("#cascbar")).toHaveClass(/wtopen/);
  await expect(page.locator("#watchTop")).toBeVisible();
  expect(Math.abs(await page.evaluate(() => window.scrollY) - 300)).toBeLessThanOrEqual(1);

  await page.evaluate(() => window.scrollTo(0, 360));
  await page.waitForTimeout(50);
  await expect(page.locator("#cascbar")).not.toHaveClass(/wtopen/);
  await expect(page.locator("#cascbar")).toHaveClass(/wtcollapsed/);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(50);
  await expect(page.locator("#cascbar")).not.toHaveClass(/wtcollapsed/);
  await expect(page.locator("#cascbar")).not.toHaveClass(/wtopen/);
});

test("AC12: watchNavKey() differs between two moods that differ only in top", async ({ page }) => {
  await toWatchScreen(page);
  const differ = await page.evaluate(() => {
    const a = window.CascadePersistence.watchNavKey();
    const mood = window.watchMoodsList ? window.watchMoodsList()[0] : null;
    // Flip the selected mood's own `top` via the real save path so the live state (and the key) reflect it.
    window.openMoodSheetFor(window.onMoodChipTap ? document.querySelector(".moodchip.on").dataset.mood : null);
    document.getElementById("moodTop").click();
    document.getElementById("moodSaveBtn").click();
    const b = window.CascadePersistence.watchNavKey();
    return a !== b;
  });
  expect(differ).toBe(true);
});

test("AC13: no stale selector for a removed control remains", async ({ page }) => {
  await toWatchScreen(page);
  for(const sel of ["#watchSortSwitch", "#watchSearchBtn", "#watchFilterBtn", ".watchagentrow"]){
    expect(await page.locator(sel).count(), sel).toBe(0);
  }
});

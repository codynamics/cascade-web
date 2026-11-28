// CAS-1247: Watch top — two stage groups (Cinema/Home), moods in place of the sort switch/search/Filters/
// agent lozenges. CAS-1283: the bar collapses to one row only on a tap (#wtHandle/#wtMini), never on scroll.
// Drives the real guest flow (toShortlist/finishFlow/toListing), same convention every other tests/e2e spec
// in this file set uses — not run by CI (only tests/e2e/smoke.spec.mjs is), but kept here for a human or a
// later CC run to exercise directly.
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

  // AC3 (CAS-1662: rewritten for the one-agent lists, CAS-1491/CAS-1693 — the old Top scores/Releases pair is
  // gone): the built-in list is "releases", named Cinema releases, pinned first and selected on open.
  const chipNames = await page.locator(".moodchip").allTextContents();
  expect(chipNames[0]).toContain("Cinema releases");
  await expect(page.locator('.moodchip[data-mood="releases"]')).toHaveClass(/on/);
});

test("AC5: no account write on boot; selecting a mood pushes exactly one mood field", async ({ page }) => {
  await toWatchScreen(page);

  // CAS-1663: "releases" (the one built-in, CAS-1662) is already selected on open, and tapping the selected chip
  // opens its edit sheet instead of selecting — so add a second list and select it first, then watch the
  // switch BACK to releases. The spy goes in after, so these set-up writes are not counted.
  await page.evaluate(() => {
    const extra = { ...oamMoodDefaultFields(), id: "t-cas1663-extra", name: "Extra" };
    watchMoods = [...oamMoodsListReal().map(m => ({ ...m })), extra];
    window.setWatchMood(extra.id);
  });
  await settleListing(page);
  await expect(page.locator('.moodchip[data-mood="t-cas1663-extra"]')).toHaveClass(/on/);

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

  // CAS-1664: rewritten for the one-agent lists (CAS-1341/CAS-1491) — "+ List" opens the OAM sheet, whose name
  // input is #oamMoodName and whose Save is .oamhead .donebtn (#moodSaveBtn is hidden there). One built-in
  // list ships, so the chip count runs 1 -> 2 -> 1, not 2 -> 3 -> 2.
  await page.locator("#moodAddBtn").click();
  await expect(page.locator("#watchSheetTitle")).toHaveText("New list");
  await page.locator("#watchSheetBody .oamhead .donebtn").click();
  await expect(page.locator(".moodchip")).toHaveCount(1);   // empty name saves nothing
  await expect(page.locator("#oamMoodName")).toBeFocused();

  await page.locator("#oamMoodName").fill("Friday");
  await page.locator("#watchSheetBody .oamhead .donebtn").click();
  await expect(page.locator(".moodchip")).toHaveCount(2);
  await expect(page.locator('.moodchip[data-mood]').last()).toHaveClass(/on/);

  // Delete it back off: first tap arms, second tap (within 4s) deletes.
  await page.locator('.moodchip.on').click();
  await page.locator("#moodDeleteBtn").click();
  await expect(page.locator("#moodDeleteBtn")).toHaveText("Tap again to delete");
  await page.locator("#moodDeleteBtn").click();
  await expect(page.locator(".moodchip")).toHaveCount(1);
});

// Lee, 2026-11-17: the collapse control (CAS-1283 AC2/AC3) is removed — the bar is always open.
test("CAS-1283 AC1 (kept): the bar stays open while scrolling, and there is no collapse control", async ({ page }) => {
  await toWatchScreen(page);
  await expect(page.locator("#wtHandle")).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(50);
  await expect(page.locator("#cascbar")).not.toHaveClass(/wtcollapsed/);
  await expect(page.locator(".stagestop").first()).toBeVisible();
});

test("a device that had saved the bar collapsed still boots open", async ({ page }) => {
  await toWatchScreen(page);
  await page.evaluate(() => localStorage.setItem("cascade_wt_collapsed", "1"));
  await page.reload();
  await settleListing(page);
  await expect(page.locator("#cascbar")).not.toHaveClass(/wtcollapsed/);
  await expect(page.locator(".stagestop").first()).toBeVisible();
});

test("AC12: watchNavKey() differs between two moods that differ only in top", async ({ page }) => {
  await toWatchScreen(page);
  // CAS-1665: rewritten for the one-agent lists (CAS-1341/CAS-1491) — the v1 sheet's #moodTop/#moodSaveBtn and
  // openMoodSheetFor are gone. The v2 equivalent of "Show top" is the list's SHOW cap (HOW MANY section): tap the
  // selected chip to open its sheet, change Show, save, and the nav key must change.
  const before = await page.evaluate(() => window.CascadePersistence.watchNavKey());
  await page.locator(".moodchip.on").click();
  await page.locator('#watchSheetBody .oamsec[data-sec="how"] .oamsechd').click();
  const seg = page.locator('#watchSheetBody .mfseg[aria-label="Show"]');
  const cur = await seg.locator('[aria-pressed="true"]').first().textContent();
  await seg.locator("button", { hasText: /^Best 20$/ }).click();
  expect(cur.trim()).not.toBe("Best 20");   // the list must change, else the key can't
  await page.locator("#watchSheetBody .oamhead .donebtn").click();
  const after = await page.evaluate(() => window.CascadePersistence.watchNavKey());
  expect(after).not.toBe(before);
});

test("AC13: no stale selector for a removed control remains", async ({ page }) => {
  await toWatchScreen(page);
  for(const sel of ["#watchSortSwitch", "#watchSearchBtn", "#watchFilterBtn", ".watchagentrow"]){
    expect(await page.locator(sel).count(), sel).toBe(0);
  }
});

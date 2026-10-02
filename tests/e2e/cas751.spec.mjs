// CAS-751: two behaviour changes to the per-card Watch On control — click-away close (shared panel
// plumbing, so it applies to every card panel closeWatchPanel closes, not just Watch On) and a human
// re-tap of an agent-armed level claiming it as manual (gold) instead of unticking it.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

test("Watch On panel: click-away, re-tap, and Escape all close it (CAS-751 AC1/AC2)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  const chip = card.locator(".ctl.notify");

  // AC1: a press on the card body, outside the panel and outside the chip, closes it.
  await chip.click();
  await expect(card.locator(".cpop.npop")).toBeVisible();
  await card.locator(".titletext").click();
  await expect(card.locator(".cpop.npop")).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-expanded", "false");

  // AC2: re-tapping the chip still closes the panel.
  await chip.click();
  await expect(card.locator(".cpop.npop")).toBeVisible();
  await chip.click();
  await expect(card.locator(".cpop.npop")).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-expanded", "false");

  // AC2: Escape still closes the panel.
  await chip.click();
  await expect(card.locator(".cpop.npop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card.locator(".cpop.npop")).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-expanded", "false");
});

test("Watch On: a human re-tap claims an agent-armed level; a manual level still toggles off (CAS-751 AC3/AC4)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const card = page.locator("#groups .card").first();
  const filmId = Number((await card.getAttribute("id")).replace("card-", ""));
  const chip = card.locator(".ctl.notify");

  // Arm a level the way an agent's auto-tick does (winsSource "auto"), on a level this film hasn't
  // already passed — an upcoming film (this listing's first group, CAS-750) has none spent yet.
  const key = await page.evaluate(id => watchLevelsFor(id).find(l => !l.spent).key, filmId);
  await page.evaluate(({ id, key }) => {
    const e = entryFor(id);
    e.wins = e.wins || {};
    e.winsSource = e.winsSource || {};
    WATCH_LEVEL_KEYS.forEach(k => { e.wins[k] = false; delete e.winsSource[k]; });
    e.wins[key] = true;
    e.winsSource[key] = "auto";
    repaintWatchControl(id);
  }, { id: filmId, key });
  await expect(chip).toHaveClass(/wsrc-auto/);

  // AC3: tapping that same (already-on) level leaves it ticked and flips the chip to manual (gold).
  await chip.click();
  const row = page.locator(`.nopt[data-wk="${key}"]`);
  await expect(row).toHaveClass(/on/);
  await row.click();
  await expect(chip).toHaveClass(/wsrc-manual/);
  await expect(chip).not.toHaveClass(/wsrc-auto/);
  const claimed = await page.evaluate(id => ({ ...notify[id].wins, src: notify[id].winsSource }), filmId);
  expect(claimed[key]).toBe(true);
  expect(claimed.src[key]).toBe("manual");

  // AC4: with the level now "manual", tapping the still-ticked row clears it — the existing toggle-off.
  // toggleFilmOpt (app_template.html) always calls closeWatchPanel() on every tap, including the claim tap
  // above (CAS-1037: "dismiss on pick"), so the panel is already gone here — reopen it before reaching
  // for the row again instead of assuming it stayed open.
  await chip.click();
  const rowAgain = page.locator(`.nopt[data-wk="${key}"]`);
  await expect(rowAgain).toHaveClass(/on/);
  await rowAgain.click();
  const cleared = await page.evaluate(id => !!notify[id].wins, filmId);
  expect(cleared).toBe(true);
  const clearedOn = await page.evaluate((id) => notify[id].wins, filmId);
  expect(clearedOn[key]).toBeFalsy();
});

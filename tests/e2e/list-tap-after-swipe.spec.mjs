// CAS-1706: after a swipe of the list row (pan) neither pointerup nor iOS fires a click, so _moodSuppressClick used
// to survive and swallow the NEXT real tap on a chip (two taps to change list). Every new press now starts clean.
import { test, expect } from "@playwright/test";
import { guestOnboarded } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 } });

test("CAS-1706: one tap changes the list after swiping the list row", async ({ page }) => {
  await guestOnboarded(page);
  await page.evaluate(() => {
    watchMoods = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map(n =>
      ({ ...oamMoodDefaultFields(), id: "cas1706" + n, name: "List " + n + " long name", styles: [], favs: [] }));
    watchMoodSel = watchMoods[0].id;
    render();
  });
  const row = page.locator(".moodrow");
  await expect(row).toBeVisible();
  expect(await row.evaluate(r => r.scrollWidth > r.clientWidth)).toBe(true);

  // Touch swipe on the row: pointerdown, 40px move, pointerup — and no click (as on iOS).
  await page.evaluate(() => {
    const row = document.querySelector(".moodrow");
    const chip = row.querySelector(".moodchip:not(.pinned)");
    const r = chip.getBoundingClientRect(), y = r.top + r.height / 2, x = r.left + 20;
    const ev = (type, cx) => chip.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: cx, clientY: y }));
    ev("pointerdown", x); ev("pointermove", x - 40); ev("pointerup", x - 40);
  });

  // ONE tap on a different list chip.
  const target = page.locator('.moodchip[data-mood="cas1706charlie"]');
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await expect(target).toHaveClass(/\bon\b/);
  expect(await page.evaluate(() => watchMoodSel)).toBe(await target.getAttribute("data-mood"));
});

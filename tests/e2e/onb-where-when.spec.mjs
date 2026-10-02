// CAS-1157: a member who says "No" to the cinema question and "No" to the rent question during
// onboarding must land with Upcoming, In cinema and Standard Rent all switched OFF in Where & when
// (Streaming stays on) — not just in-memory for the rest of the session, but still off after a reload.
// Walks a guest-mode first run the same way tests/e2e/helpers.mjs's walkToServices/finishFlow do, answering
// "No" to both gated questions instead of their usual "yes"/"yes" or "no"/"yes".
//
// Not part of the smoke gate (CAS-385) — run directly via `node scripts/test-e2e.mjs
// tests/e2e/onb-where-when.spec.mjs`.
import { test, expect } from "@playwright/test";
import { freshApp, ctaLocator, finishFlow, toListing, openWhereWhenScreen, closeWhereWhenScreen } from "./helpers.mjs";

test("CAS-1157 AC9: cinema No + rent No leaves Upcoming/In cinema/Standard Rent off and Streaming on, after a reload", async ({ page }) => {
  await freshApp(page);
  await page.locator("#splashCta").click();

  await expect(page.locator("#onbStepInner .obhd")).toContainText("Cascade finds your movies for you.");   // v2_about
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Massive Movies");   // v2_intro
  await ctaLocator(page).click();
  await page.waitForTimeout(120);

  await expect(page.locator("#obCinemaOpts")).toBeVisible();              // v2_cinema
  await page.locator('#obCinemaOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);

  await expect(page.locator("#obRentOpts")).toBeVisible();                // v2_rent
  await page.locator('#obRentOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);

  for(const marker of ["v2_massive", "v2_handoff", "v2_styles", "v2_budget", "v2_ages", "v2_favs"]){
    await ctaLocator(page).click();
    await page.waitForTimeout(120);
  }

  await expect(page.locator("#obPartnerOpts")).toBeVisible();             // v2_partner
  await page.locator('#obPartnerOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#obKidsOpts")).toBeVisible();                // v2_kids — v2_date skipped
  await page.locator('#obKidsOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);                                        // v2_family skipped
  await expect(page.locator("#obSvcStores")).toBeVisible();               // v2_services

  await finishFlow(page);        // v2_services -> v2_done (roster commit) -> membership
  await toListing(page);         // guest mode: membStart() proceeds straight through, no email gate

  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await openWhereWhenScreen(page);
  const laneFor = labelText => page.locator(".wwlane", { has: page.locator(".wwn", { hasText: labelText }) });
  for(const label of ["Upcoming", "In cinema", "Standard Rent"]){
    await expect(laneFor(label).locator(".agwt")).toHaveAttribute("aria-pressed", "false");
  }
  await expect(laneFor("Streaming").locator(".agwt")).toHaveAttribute("aria-pressed", "true");
  await closeWhereWhenScreen(page);
});

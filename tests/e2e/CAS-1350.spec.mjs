// CAS-1350: the first-run flow (?oneagent=setup) left #oafScreen's "open" class off whenever control handed
// back to it from #oneAgentSetupScreen (oafBackFromSetup, oafGoFromAlerts), so the painted step stayed
// display:none and the fixed header/nav floated over the app underneath with nothing to tap. A third defect
// (oafGoContinue missing a "who" branch) also left Continue on the Who screen a silent no-op. window.oafOpen()
// is the entry point itself (neither the account's ?oneagent=setup URL param nor "Preview setup ›" gate it),
// so this drives it directly in guest mode, exactly as CAS-1349's own first-run trigger does — every click from
// there on is the real UI, per helpers.mjs's "anything a person does, the test clicks" rule.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test("CAS-1350: the first run completes end to end, welcome through Start watching", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());

  await expect(page.locator("#oafScreen")).toHaveClass(/open/);
  await expect(page.locator("#oafInner .osh")).toHaveText("Let's get you set up.");
  await page.locator("#oafCta").click();   // welcome -> where

  await expect(page.locator("#oafInner .osh")).toHaveText("Where do you watch movies?");
  await page.locator('#oafWhereOpts .obopt[data-val="cinema"]').click();
  await page.locator("#oafCta").click();   // where -> genres and scores (no services step, cinema only)

  // CAS-1352: the new "Genres and scores" explainer, screen 4 of 9.
  await expect(page.locator("#oafScreen")).toHaveClass(/open/);
  await expect(page.locator("#oafInner .osh")).toHaveText("Genres and scores");
  await page.locator("#oafCta").click();   // genres and scores -> scores

  await expect(page.locator("#oneAgentSetupScreen")).toHaveClass(/open/);
  await expect(page.locator("#oafScreen")).not.toHaveClass(/open/);
  await expect(page.locator(".oassteplbl")).toHaveText("Your agent · genres");
  await page.locator(".onbbtn.primary", { hasText: "Next: alerts" }).click();   // scores -> alerts

  await expect(page.locator(".oassteplbl")).toHaveText("Your agent · alerts");
  await page.locator(".onbbtn.primary", { hasText: "Next ›" }).click();   // alerts -> who

  // The CAS-1350 bug: #oafScreen never regained "open" here, so the who step painted but stayed hidden.
  await expect(page.locator("#oafScreen")).toHaveClass(/open/);
  await expect(page.locator("#oneAgentSetupScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#oafInner .osh")).toHaveText("Who do you watch with?");
  await expect(page.locator("#oafCta")).toBeDisabled();

  await page.locator('#oafWhoOpts .obopt[data-val="solo"]').click();
  await expect(page.locator("#oafCta")).toBeEnabled();
  await page.locator("#oafCta").click();   // who -> name your agent (the third defect: oafGoContinue had no "who" branch)

  // CAS-1352: the new "Name your agent" step, screen 8 of 9 — Continue stays disabled until a name exists.
  await expect(page.locator("#oafInner .osh")).toHaveText("Name your agent");
  await expect(page.locator("#oafCta")).toBeDisabled();
  await page.locator('#oafNameChips .chip[data-name="Ruby"]').click();
  await expect(page.locator("#oafNameInput")).toHaveValue("Ruby");
  await expect(page.locator("#oafCta")).toBeEnabled();
  await page.locator("#oafCta").click();   // name your agent -> done

  await expect(page.locator("#oafInner .osh")).toHaveText("Your agent is set up.");
  await expect(page.locator("#oafInner .ossub").first()).toHaveText("Name: Ruby");
  await expect(page.locator("#oafCta")).toHaveText("Start watching");
  await page.locator("#oafCta").click();

  await expect(page.locator("#oafScreen")).not.toHaveClass(/open/);
});

test("CAS-1350 AC3: '‹ Back' from the scores step shows the Genres and scores step visibly, not the app behind it", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  await page.locator("#oafCta").click();   // welcome -> where
  await page.locator('#oafWhereOpts .obopt[data-val="cinema"]').click();
  await page.locator("#oafCta").click();   // where -> genres and scores
  await page.locator("#oafCta").click();   // genres and scores -> scores

  await expect(page.locator("#oneAgentSetupScreen")).toHaveClass(/open/);
  await page.locator(".onbbtn.ghost", { hasText: "Back" }).click();   // scores' own '‹ Back' -> oafBackFromSetup

  await expect(page.locator("#oneAgentSetupScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#oafScreen")).toHaveClass(/open/);
  await expect(page.locator("#oafInner .osh")).toHaveText("Genres and scores");
});

// CAS-1198: a per-agent Alerts switch — on for Massive Movies, off for every other agent (CAS-843
// deliberately removed the last one; this brings a per-agent decision back). AC1-4 and AC7 are covered
// at the engine/monitor level (tests/js/cas1198-alerts-switch.test.mjs, monitor/tests/test_matching.py's
// AlertsOffGateTests) — this file covers the two Playwright ACs the ticket names explicitly.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, openAgentsScreenFromNav } from "./helpers.mjs";

async function buildOnboardedAccount(page){
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
}

// CAS-1209: scoped to #agentsScreen — onbAgentRevealHTML() (the onboarding reveal step, app_template.html)
// renders its own .agrow/.agname markup for the first-built agent and never removes it from the DOM once
// the flow moves on, so an unscoped page-wide .agrow query here resolved to two elements (a Playwright
// strict-mode violation) once the real Agents screen opened: the stale reveal row (bare WHO_LABELS text,
// no occasions or alerts) alongside the real one (occasions + "🔔 Alerts on"). The Agents screen itself was
// correct; only this helper's own query was too broad to say "on the Agents screen" as its title claims.
const agentRow = (page, name) => page.locator("#agentsScreen .agrow", { has: page.locator(".agname", { hasText: name }) });

test("CAS-1198 AC6: the Agents screen shows Alerts on for the first-built agent, and not for Personal Favs", async ({ page }) => {
  await buildOnboardedAccount(page);
  await openAgentsScreenFromNav(page);
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);

  // CAS-1270: cinema Yes (toShortlist's "cinema" kind) renames the onb_massive template "In Cinema".
  await expect(agentRow(page, "In Cinema").locator(".agwho")).toContainText("🔔 Alerts on");

  const favsWho = agentRow(page, "Personal Favs").locator(".agwho");
  // The who-line is only drawn at all when it has something to say (CAS-826) — either no .agwho element
  // at all, or one that exists for the who/occasion text and must not also claim Alerts on.
  if(await favsWho.count() > 0) await expect(favsWho).not.toContainText("🔔 Alerts on");
});

test("CAS-1198 AC5: the Edit Agent page's ALERTS switch sits under Occasions inside Advanced, toggles, survives Back/reopen, and has no horizontal overflow", async ({ page }) => {
  await buildOnboardedAccount(page);
  await openAgentsScreenFromNav(page);
  await agentRow(page, "Personal Favs").locator(".ag-edit").click();
  await expect(page.locator(".osh.eahn")).toHaveText("Personal Favs");   // CAS-531: the page header IS the name

  // CAS-1274: Alerts lives under the Advanced tab now, alongside Occasions — not its own collapsible
  // section with a dedicated "ALERTS" heading.
  await page.locator("#briefTabAdvanced").click();
  const sectionOrder = await page.evaluate(() => {
    const body = document.querySelector("#onbStepInner");
    const occasions = body.querySelector(".osdial.cardbtn");           // occasionsCardHTML()'s own card
    const alerts = document.querySelector("#onbAlertsOn");
    const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { occasionsBeforeAlerts: occasions && alerts ? before(occasions, alerts) : false };
  });
  expect(sectionOrder.occasionsBeforeAlerts).toBe(true);

  // Personal Favs is not the onboarding-massive template, so it must open with alerts off.
  const sw = page.locator("#onbAlertsOn");
  await expect(sw).toBeVisible();
  await expect(sw).not.toHaveClass(/on/);
  await expect(sw).toHaveAttribute("aria-checked", "false");

  await sw.click();
  await expect(sw).toHaveClass(/on/);
  await expect(sw).toHaveAttribute("aria-checked", "true");

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  // Back commits the draft (briefClose/briefCommit, CAS-934) — reopening must show the saved state.
  await page.locator("#onbStepInner .osback").click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  await agentRow(page, "Personal Favs").locator(".ag-edit").click();
  await page.locator("#briefTabAdvanced").click();
  await expect(page.locator("#onbAlertsOn")).toHaveClass(/on/);

  // And the Agents screen marker now follows the saved switch.
  await page.locator("#onbStepInner .osback").click();
  await expect(agentRow(page, "Personal Favs").locator(".agwho")).toContainText("🔔 Alerts on");
});

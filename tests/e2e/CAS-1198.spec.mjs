// CAS-1198/CAS-1297: a per-agent Alerts switch — on by default for every agent (CAS-843 deliberately
// removed the last one; this brings a per-agent decision back; CAS-1297 widened the default from
// Massive Movies only to every agent). AC1-4 and AC7 are covered at the engine/monitor level
// (tests/js/cas1198-alerts-switch.test.mjs, monitor/tests/test_matching.py's AlertsOffGateTests) —
// this file covers the two Playwright ACs the ticket names explicitly.
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

test("CAS-1198/CAS-1297 AC6: the Agents screen shows Alerts on for every built agent", async ({ page }) => {
  await buildOnboardedAccount(page);
  await openAgentsScreenFromNav(page);
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);

  // CAS-1312: the onb_massive template is always named "Cinema Releases" now.
  await expect(agentRow(page, "Cinema Releases").locator(".agwho")).toContainText("🔔 Alerts on");
  // CAS-1297: every agent defaults to Alerts on now, not just the onboarding-massive template.
  await expect(agentRow(page, "Personal Favs").locator(".agwho")).toContainText("🔔 Alerts on");
});

test("CAS-1198/CAS-1297 AC5: the Edit Agent page's ALERTS switch sits under Occasions inside Advanced, defaults on, toggles, survives Back/reopen, and has no horizontal overflow", async ({ page }) => {
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

  // CAS-1297: every agent, including Personal Favs, now opens with alerts on by default.
  const sw = page.locator("#onbAlertsOn");
  await expect(sw).toBeVisible();
  await expect(sw).toHaveClass(/on/);
  await expect(sw).toHaveAttribute("aria-checked", "true");

  await sw.click();
  await expect(sw).not.toHaveClass(/on/);
  await expect(sw).toHaveAttribute("aria-checked", "false");

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
  await expect(page.locator("#onbAlertsOn")).not.toHaveClass(/on/);

  // And the Agents screen marker now follows the saved switch-off — the who-line is only drawn at all
  // when it has something to say (CAS-826), so either no .agwho element at all, or one that must not
  // claim Alerts on.
  await page.locator("#onbStepInner .osback").click();
  const favsWho = agentRow(page, "Personal Favs").locator(".agwho");
  if(await favsWho.count() > 0) await expect(favsWho).not.toContainText("🔔 Alerts on");
});

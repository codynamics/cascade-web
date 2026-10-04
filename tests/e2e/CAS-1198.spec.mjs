// CAS-1198: a per-agent Alerts switch — on for Massive Movies, off for every other agent (CAS-843
// deliberately removed the last one; this brings a per-agent decision back). AC1-4 and AC7 are covered
// at the engine/monitor level (tests/js/cas1198-alerts-switch.test.mjs, monitor/tests/test_matching.py's
// AlertsOffGateTests) — this file covers the two Playwright ACs the ticket names explicitly.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, openAgentsScreenFromMenu } from "./helpers.mjs";

async function buildOnboardedAccount(page){
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
}

const agentRow = (page, name) => page.locator(".agrow", { has: page.locator(".agname", { hasText: name }) });

test("CAS-1198 AC6: the Agents screen shows Alerts on for Massive Movies, and not for Personal Favs", async ({ page }) => {
  await buildOnboardedAccount(page);
  await openAgentsScreenFromMenu(page);
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);

  await expect(agentRow(page, "Massive Movies").locator(".agwho")).toContainText("🔔 Alerts on");

  const favsWho = agentRow(page, "Personal Favs").locator(".agwho");
  // The who-line is only drawn at all when it has something to say (CAS-826) — either no .agwho element
  // at all, or one that exists for the who/occasion text and must not also claim Alerts on.
  if(await favsWho.count() > 0) await expect(favsWho).not.toContainText("🔔 Alerts on");
});

test("CAS-1198 AC5: the Edit Agent page's ALERTS section sits between Occasions and WHAT IT LOOKS FOR, toggles, survives Back/reopen, and has no horizontal overflow", async ({ page }) => {
  await buildOnboardedAccount(page);
  await openAgentsScreenFromMenu(page);
  await agentRow(page, "Personal Favs").locator(".ag-edit").click();
  await expect(page.locator(".osh.eahn")).toHaveText("Personal Favs");   // CAS-531: the page header IS the name

  const sectionOrder = await page.evaluate(() => {
    const body = document.querySelector("#onbStepInner");
    const occasions = body.querySelector(".osdial.cardbtn");           // occasionsCardHTML()'s own card
    const usecs = [...body.querySelectorAll(".usec")].map(e => e.textContent.trim());
    const alerts = [...body.querySelectorAll(".usec")].find(e => e.textContent.trim() === "ALERTS");
    const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { usecs, occasionsBeforeAlerts: occasions && alerts ? before(occasions, alerts) : false };
  });
  expect(sectionOrder.usecs[0]).toBe("ALERTS");
  expect(sectionOrder.usecs[1]).toBe("WHAT IT LOOKS FOR");
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
  await expect(page.locator("#onbAlertsOn")).toHaveClass(/on/);

  // And the Agents screen marker now follows the saved switch.
  await page.locator("#onbStepInner .osback").click();
  await expect(agentRow(page, "Personal Favs").locator(".agwho")).toContainText("🔔 Alerts on");
});

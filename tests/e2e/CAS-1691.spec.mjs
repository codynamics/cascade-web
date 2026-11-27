// CAS-1691: onboarding is 10 screens — "Who's watching?" first, no "Where" or "Name your agent".
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const readLog = page => page.evaluate(() => JSON.parse(localStorage.getItem("cascade_log") || "[]"));
const shownKeys = async page => (await readLog(page)).filter(e => e.type === "onbstep_shown").map(e => e.step.replace(/^oaf_/, ""));
const pill = (page, field, val) => page.locator(`.whopill[data-field="${field}"][data-val="${val}"]`);

test.use({ viewport: { width: 390, height: 844 } });

test("CAS-1691 AC1/AC6/AC7/AC8/AC9: every yes, 18+, two services — exact step sequence; windows all on; no name or where", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  const cta = page.locator("#oafCta");
  await cta.click();                                           // welcome -> who
  await pill(page, "age", "18plus").click();
  await pill(page, "partner", "yes").click();
  await pill(page, "children", "yes").click();
  await cta.click();                                           // who -> services
  await page.evaluate(() => { prefs.sub.clear(); [...SUB_SERVICES].slice(0, 2).forEach(s => prefs.sub.add(s)); });
  await cta.click();                                           // services -> topSvc
  await page.locator("#oafTopSvcOpts .chip").first().click();
  await cta.click();                                           // topSvc -> favourites
  await cta.click();                                           // favourites -> together
  await cta.click();                                           // together -> family
  await cta.click();                                           // family -> people
  await cta.click();                                           // people -> done
  await expect(page.locator("#oafInner .osh")).toHaveText("Your agent is ready.");
  const text = await page.locator("#oafInner").innerText();
  expect(text).toContain("Next: become a member and start watching.");
  expect(text).not.toContain("account is set up");
  expect(await page.locator("#oafInner input").count()).toBe(0);
  expect(await shownKeys(page)).toEqual(["welcome", "who", "services", "topSvc", "favourites", "together", "family", "people", "done"]);
  expect(await page.evaluate(() => [...oafState.where].sort())).toEqual(["cinema", "rent", "stream"]);
  expect(await page.evaluate(() => oafActiveWindows().map(w => w.key).sort())).toEqual(["cinema", "rent", "stream"]);
  // A brand-new signed-out visitor on a configured build sees the email-entry variant: membNeedsEmail() is true.
  // freshApp runs with no Supabase config (CascadeAuth.enabled false), which renders the "Continue" variant instead.
  await page.evaluate(() => { window.CascadeAuth = Object.assign(window.CascadeAuth || {}, { enabled: true, status: "signed-out" }); });
  await cta.click();                                           // Proceed -> membership
  await expect(page.locator("#membScreen.open")).toBeVisible();
  const memb = await page.locator("#membScreen").innerText();
  expect(memb).toContain("Become a Cascade member");
  expect(memb).toContain("Membership");
  await expect(page.locator("#membEmail")).toBeVisible();
  await expect(page.locator(".membcta")).toHaveText("Become a member");
});

test("CAS-1691 AC2: Under 18, partner no, one service — welcome, who, services, favourites, people, done", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  const cta = page.locator("#oafCta");
  await cta.click();
  await pill(page, "age", "under18").click();
  await pill(page, "partner", "no").click();
  await cta.click();
  await page.evaluate(() => { prefs.sub.clear(); prefs.sub.add([...SUB_SERVICES][0]); });
  await cta.click();                                           // services -> favourites
  await cta.click();                                           // favourites -> people
  await cta.click();                                           // people -> done
  expect(await shownKeys(page)).toEqual(["welcome", "who", "services", "favourites", "people", "done"]);
});

test("CAS-1691 AC3/AC4/AC5: who step — kids row hides under 18, Continue gates on answers, icons light with the answers", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  await page.locator("#oafCta").click();
  const cta = page.locator("#oafCta");
  await expect(cta).toBeDisabled();
  await expect(page.locator(".whorow")).toHaveCount(2);        // no age yet: kids row hidden until 18+
  await pill(page, "age", "18plus").click();
  await expect(page.locator(".whorow")).toHaveCount(3);
  await expect(page.locator(".whopill.on")).toHaveCount(1);    // nothing preselected on the other rows
  await pill(page, "partner", "no").click();
  await expect(cta).toBeDisabled();                            // kids row still unanswered
  await pill(page, "children", "yes").click();
  await expect(cta).toBeEnabled();
  const lit = () => page.evaluate(() => [...document.querySelectorAll(".whoico")].map(e => e.classList.contains("lit")));
  expect(await lit()).toEqual([true, false, true]);            // You, Partner (no), Family (yes)
  await pill(page, "partner", "yes").click();
  expect(await lit()).toEqual([true, true, true]);
  await pill(page, "age", "under18").click();
  await expect(page.locator(".whorow")).toHaveCount(2);
  expect(await page.evaluate(() => oafState.children)).toBe("no");
  expect(await lit()).toEqual([true, true, false]);
  await pill(page, "age", "18plus").click();
  await expect(page.locator(".whorow")).toHaveCount(3);
  expect(await page.evaluate(() => oafState.children)).toBe(null);
  await expect(cta).toBeDisabled();
});

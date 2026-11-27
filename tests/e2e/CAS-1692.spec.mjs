// CAS-1692: agents have no names. An account whose stored agent name is "Nova" shows "Nova" nowhere (Watch, Lists,
// the list sheet, Taste, Alerts, Settings, the onboarding done screen) and no screen offers a way to set a name.
import { test, expect } from "@playwright/test";
import { guestOnboarded, freshApp } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 } });

const NAME = "Nova";

/** Visible text of the whole page plus every input value / placeholder / aria-label / title — "Nova" must be in none. */
async function expectNoNova(page, where){
  const seen = await page.evaluate(() => {
    const out = [document.body.innerText];
    document.querySelectorAll("input,textarea,button,[aria-label],[title],[placeholder]").forEach(el => {
      const cs = getComputedStyle(el);
      if(cs.display === "none" || cs.visibility === "hidden") return;
      out.push(el.value || "", el.getAttribute("placeholder") || "", el.getAttribute("aria-label") || "", el.getAttribute("title") || "");
    });
    return out.join("\n");
  });
  expect(seen, `"${NAME}" visible on ${where}`).not.toContain(NAME);
}

/** No control on screen is for setting/editing an agent's name. */
async function expectNoNameControl(page, where){
  const n = await page.evaluate(() => [...document.querySelectorAll("input,textarea,button,[role=button]")].filter(el => {
    const cs = getComputedStyle(el);
    if(cs.display === "none" || cs.visibility === "hidden") return false;
    const label = [el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("name"), el.id, el.textContent].join(" ");
    return /(agent|cascade)[\s_-]*name|name your agent|rename (your )?agent|\bname-?chip/i.test(label);
  }).length);
  expect(n, `agent-name control on ${where}`).toBe(0);
}

async function check(page, where){
  await expectNoNova(page, where);
  await expectNoNameControl(page, where);
}

async function closeTop(page){
  await page.evaluate(() => document.querySelectorAll(".uscreen.open .osback").forEach(b => b.click()));
}

test("CAS-1692 AC1/AC2: a stored agent name 'Nova' appears nowhere and no screen sets a name", async ({ page }) => {
  await guestOnboarded(page);
  await page.evaluate(n => {
    window.CascadePersistence.accountActive = () => true;
    cascades.forEach(c => { c.name = n; });
    saveCascades();
    render();
  }, NAME);

  // Watch
  await page.evaluate(() => showAgentsHome());
  await check(page, "Watch");

  // Lists + the list sheet
  await page.evaluate(() => {
    watchMoods = [{ ...oamMoodDefaultFields(), id: "cas1692", name: "Weekend", styles: [], favs: [] }];
    watchMoodSel = "cas1692";
    render();
  });
  await check(page, "Lists");
  await page.evaluate(() => window.openOamMoodSheetFor("cas1692"));
  await expect(page.locator("#watchSheet")).toHaveClass(/open/);
  await check(page, "the list sheet");
  await page.evaluate(() => { closeWatchSheetQuiet(); });

  // Taste
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await check(page, "Taste");
  await closeTop(page);

  // Alerts
  await page.evaluate(() => openMovingScreen());
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  await check(page, "Alerts");
  await closeTop(page);

  // Settings
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Settings" }).click();
  await expect(page.locator("#settingsScreen")).toHaveClass(/open/);
  await check(page, "Settings");
  await closeTop(page);
});

test("CAS-1692 AC1/AC2: the onboarding done screen shows no 'Nova' and has no name field", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  const cta = page.locator("#oafCta");
  await cta.click();                                           // welcome -> who
  await page.locator('.whopill[data-field="age"][data-val="under18"]').click();
  await page.locator('.whopill[data-field="partner"][data-val="no"]').click();
  await cta.click();                                           // who -> services
  await page.evaluate(n => { prefs.sub.clear(); prefs.sub.add([...SUB_SERVICES][0]); oafState.name = n; }, NAME);
  await cta.click();                                           // services -> favourites
  await cta.click();                                           // favourites -> people
  await cta.click();                                           // people -> done
  await expect(page.locator("#oafInner .osh")).toHaveText("Your agent is ready.");
  await check(page, "the onboarding done screen");
});

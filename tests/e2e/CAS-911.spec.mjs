// CAS-911: the v2 onboarding cutover's own end-to-end walk. FLOWS now wires v2_intro..v2_done in for
// real, so this drives the WIRED sequence (not the ?step= previews CAS-909/CAS-910 exercised) start to
// finish — the roster commit at v2_done, and the double-roster reload case CAS-629's old flow needed a
// special guard against (see the "working" step's own firstRun check, retired by this ticket): a single
// commit point makes it structural here, not a special case.
import { test, expect } from "@playwright/test";
import { ctaLocator } from "./helpers.mjs";

async function gotoReset(page){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html?reset");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
}

async function readCascadeNames(page){
  // The account-namespaced "@guest" suffix CAS-957 once gave this key is gone — commitDraft()/render()
  // (app_template.html) read and write a bare "cascade_cascades", no suffix, guest or signed in alike.
  return page.evaluate(() => {
    try{ return JSON.parse(localStorage.getItem("cascade_cascades") || "[]").map(c => c.name); }
    catch(e){ return null; }
  });
}

/** Splash through v2_ages — cinema Yes, rent Yes, two styles, the Studio budget stop, ages left at
 * default — landing on v2_favs with its own Continue not yet pressed. The style-chip picks check
 * their own "on" state first rather than blindly clicking, so this is safe to call a second time after
 * a reload has carried onbFlow.answersV2 forward (CAS-910's own "survives a reload" behaviour) without
 * toggling an already-picked chip back off. */
async function walkToFavs(page){
  await page.locator("#splashCta").click();
  // CAS-1018: scoped to #onbStepInner, not a bare ".obhd" — gotoStep's dual-pane slide leaves the
  // outgoing step's .obhd in the DOM alongside the incoming one for the length of the transition.
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Let's get you set up.");   // v2_about (CAS-953)
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Massive Movies");          // v2_intro
  await ctaLocator(page).click();
  await page.waitForTimeout(120);

  await expect(page.locator("#obCinemaOpts")).toBeVisible();                      // v2_cinema
  await page.locator('#obCinemaOpts .obopt[data-val="yes"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);

  await expect(page.locator("#obRentOpts")).toBeVisible();                        // v2_rent
  await page.locator('#obRentOpts .obopt[data-val="yes"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);

  await ctaLocator(page).click();   // v2_massive — reveal, nothing to answer
  await page.waitForTimeout(120);
  await ctaLocator(page).click();   // v2_handoff — intro, nothing to answer
  await page.waitForTimeout(120);

  const styleChips = page.locator("#obStylesChips .chip.gen");                    // v2_styles
  await expect(styleChips.first()).toBeVisible();
  for(const chip of [styleChips.nth(0), styleChips.nth(1)]){
    if(!(await chip.evaluate(el => el.classList.contains("on")))) await chip.click();
  }
  await ctaLocator(page).click();
  await page.waitForTimeout(120);

  await expect(page.locator(".vsnap")).toHaveCount(5);                            // v2_budget
  await page.locator(".vsnap", { hasText: "Studio" }).click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);

  await ctaLocator(page).click();   // v2_ages, left at default (G, PG's own equivalent for the adult agents)
  await page.waitForTimeout(120);

  expect(await page.evaluate(() => onbStepKey)).toBe("v2_favs");
}

/** From v2_favs (Continue not yet pressed) through to v2_done — partner Yes + same styles, kids Yes
 * with kidAges left at default (G, PG), two services — landing on v2_done with its own Continue not
 * yet pressed. */
async function completeFourAgentRun(page){
  await ctaLocator(page).click();   // v2_favs -> v2_partner
  await page.waitForTimeout(120);
  await expect(page.locator("#obPartnerOpts")).toBeVisible();
  await page.locator('#obPartnerOpts .obopt[data-val="yes"]').click();
  await expect(page.locator("#obPartnerDiffOpts")).toBeVisible();
  await page.locator('#obPartnerDiffOpts .obopt[data-val="no"]').click();   // same styles as mine
  await ctaLocator(page).click();   // v2_partner -> v2_date
  await page.waitForTimeout(120);

  await ctaLocator(page).click();   // v2_date -> v2_kids
  await page.waitForTimeout(120);
  await expect(page.locator("#obKidsOpts")).toBeVisible();
  await page.locator('#obKidsOpts .obopt[data-val="yes"]').click();         // kidAges left at default: G, PG
  await ctaLocator(page).click();   // v2_kids -> v2_family
  await page.waitForTimeout(120);

  await ctaLocator(page).click();   // v2_family -> v2_services
  await page.waitForTimeout(120);
  const rentalChip = page.locator("#obSvcStores .chip.svc").first();
  await expect(rentalChip).toBeVisible();
  await rentalChip.click();
  await page.locator("#obSvcSubs .chip.svc").first().click();
  await ctaLocator(page).click();   // v2_services -> v2_done
  await page.waitForTimeout(120);
}

// gotoReset()'s own guest-mode routing 404s config.js (same route freshApp() uses, helpers.mjs) — the
// browser always reports that as a "Failed to load resource" console error, the harness's own expected
// noise rather than a signal from the walk under test (same noise CAS-910.spec.mjs's console-error test
// hits for the same reason). Filtered by its fixed, generic text, same as there.
const CONFIG_404_TEXT = "Failed to load resource: the server responded with a status of 404 (Not Found)";

test("first run, partner Yes + kids Yes: reaches a 4-agent 'set to work' screen and commits the full roster (CAS-911 AC2/AC4)", async ({ page }) => {
  const errors = [];
  page.on("console", msg => { if(msg.type() === "error" && msg.text() !== CONFIG_404_TEXT) errors.push(msg.text()); });
  page.on("pageerror", e => errors.push(String(e)));

  await gotoReset(page);
  expect(await readCascadeNames(page)).toEqual([]);

  await walkToFavs(page);
  expect(await readCascadeNames(page)).toEqual([]);   // AC7: still nothing committed this late, pre-v2_done

  await completeFourAgentRun(page);
  // CAS-1018: scoped to #onbStepInner — gotoStep's dual-pane slide leaves the outgoing step's .obhd in
  // the DOM alongside the incoming one for the length of the transition.
  await expect(page.locator("#onbStepInner .obhd")).toContainText("4 agents, set to work.");   // AC2

  await ctaLocator(page).click();   // v2_done's own CTA — "Open my lists"
  await expect(page.locator("#membScreen.open")).toBeVisible();

  const names = await readCascadeNames(page);                                    // AC4
  expect(names).toEqual(["Massive Movies", "Personal Favs", "Date Night", "Family Movies"]);
  expect(await page.evaluate(() => localStorage.getItem("cascade_onboarded"))).toBe("1");
  expect(errors).toEqual([]);   // no console error at any screen
});

test("first run, partner No + kids No: reaches a 2-agent 'set to work' screen, v2_date/v2_family never render (CAS-911 AC3)", async ({ page }) => {
  await gotoReset(page);
  await walkToFavs(page);

  await ctaLocator(page).click();   // v2_favs -> v2_partner
  await page.waitForTimeout(120);
  await expect(page.locator("#obPartnerOpts")).toBeVisible();
  await page.locator('#obPartnerOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => onbStepKey)).toBe("v2_kids");      // v2_date skipped straight past

  await expect(page.locator("#obKidsOpts")).toBeVisible();
  await page.locator('#obKidsOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => onbStepKey)).toBe("v2_services");  // v2_family skipped straight past

  await page.locator("#obSvcStores .chip.svc").first().click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);

  await expect(page.locator("#onbStepInner .obhd")).toContainText("2 agents, set to work.");   // AC3
  const names = await readCascadeNames(page);
  expect(names).toEqual(["Massive Movies", "Personal Favs"]);
});

test("reloading mid-flow at v2_favs then completing a fresh run leaves exactly 4 agents, not 8 (CAS-911 AC5)", async ({ page }) => {
  await gotoReset(page);
  await walkToFavs(page);
  expect(await readCascadeNames(page)).toEqual([]);

  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  // Nothing was committed before the reload, so boot's own onboardingSeen() gate shows the splash again.
  await expect(page.locator("#splashCta")).toBeVisible();

  await walkToFavs(page);
  await completeFourAgentRun(page);
  await expect(page.locator("#onbStepInner .obhd")).toContainText("4 agents, set to work.");
  await ctaLocator(page).click();
  await expect(page.locator("#membScreen.open")).toBeVisible();

  const names = await readCascadeNames(page);
  expect(names.length).toBe(4);
  expect(new Set(names).size).toBe(4);
});

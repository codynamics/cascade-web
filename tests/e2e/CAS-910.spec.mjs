// CAS-910: onboarding v2's ten question screens, preview-only, reachable via ?step=<key> only — none of
// this is wired into FLOWS yet (CAS-911). Follows CAS-909's own goto-twice technique since the answers
// these screens read (onbAnswersV2Load(), keyed "cascade_onb_answers_v2") are read at BOOT, synchronously,
// before any test code could reach in and set them post-navigation.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const ANSWERS_V2_KEY = "cascade_onb_answers_v2";

/** A guest, network-free boot landed directly on a v2 question step, with `answers` already seeded under
 * the v2 answers key so the step's own wire() (onbAnswersV2Load()) picks them up on this exact boot. */
async function openStep(page, stepKey, answers = {}){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  const url = `/index.html?step=${stepKey}`;
  await page.goto(url);
  await page.evaluate(a => {
    try{ localStorage.clear(); }catch(e){}
    try{ localStorage.setItem("cascade_onb_answers_v2", JSON.stringify(a)); }catch(e){}
  }, answers);
  await page.goto(url);
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await expect(page.locator("#onbStep")).toHaveClass(/open/);
}

const ALL_STEPS = [
  "v2_intro", "v2_cinema", "v2_rent", "v2_handoff", "v2_styles",
  "v2_budget", "v2_ages", "v2_partner", "v2_kids", "v2_services",
];

test("CAS-910 AC: every one of the ten v2 question screens renders with no console error", async ({ page }) => {
  for(const key of ALL_STEPS){
    const errors = [];
    page.on("console", msg => { if(msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", e => errors.push(String(e)));
    await openStep(page, key);
    expect(errors, `${key} logged a console error`).toEqual([]);
    page.removeAllListeners("console");
    page.removeAllListeners("pageerror");
  }
});

test("CAS-910 AC: v2_cinema's Continue is disabled on load and enabled after picking Yes", async ({ page }) => {
  await openStep(page, "v2_cinema");
  const cta = page.locator("#onbStepCta");
  await expect(cta).toBeDisabled();
  await page.locator('.obopt[data-val="yes"]').click();
  await expect(page.locator("#onbStepCta")).toBeEnabled();
});

// CAS-1047: openStep()'s ?step= preview renders straight through renderOnbStep() with no gotoStep() slide
// involved, so it never exercised the bug — the wired flow's own forward transition leaves the OUTGOING
// pane's #onbStepCta in the DOM (gotoStep only strips the id off the pane container, not its descendants;
// endSlide() removes it 460ms later), so applyStepBlock's own $("onbStepCta") lookup could resolve to that
// stale button instead of the one this paint just drew, leaving the real, freshly-entered step un-gated.
// Scoped to #onbStepInner for the same reason CAS-1018 scoped .obhd this way (see openStep above).
test("CAS-1047 AC: v2_cinema's Continue is disabled on arrival via the wired flow (slide transition), not only via a ?step= preview", async ({ page }) => {
  await freshApp(page);
  await page.locator("#splashCta").click();
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Let's get you set up.");   // v2_about
  await page.locator("#onbStepInner #onbStepCta").click();
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Massive Movies");   // v2_intro
  await page.locator("#onbStepInner #onbStepCta").click();   // slides into v2_cinema
  await expect(page.locator("#obCinemaOpts")).toBeVisible();
  await expect(page.locator("#onbStepInner #onbStepCta")).toBeDisabled();
});

// CAS-1047: flowStart() previously left a prior run's saved answers in place, so a second person onboarding
// on the same device (after sign-out) found every blocked question already answered from the first person's
// run — the opposite of ONB-04's fresh flow.
// CAS-1099: the v2 answers draft moved off localStorage onto onbAnswersV2Mem (memory only, until
// membership completes) — seed/read that directly rather than the retired "cascade_onb_answers_v2" key.
test("CAS-1047 AC: flowStart() resets a previous person's saved v2 answers for a genuinely new run", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => {
    onbAnswersV2Save({
      cinema: "yes", rent: "yes", styles: ["Comedy"], selScale: 15000000, ages: ["M"],
      partner: "yes", partnerDiff: "no", partnerStyles: [], kids: "yes", kidAges: ["G"], services: ["Netflix"],
    });
  });
  await page.locator("#splashCta").click();
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Let's get you set up.");   // v2_about
  const stored = await page.evaluate(() => onbAnswersV2Load());
  expect(stored.cinema).toBeNull();
  expect(stored.partner).toBeNull();
  expect(stored.services).toEqual([]);
});

test("CAS-910 AC: v2_rent's Continue is disabled on load and enabled after picking Yes", async ({ page }) => {
  await openStep(page, "v2_rent");
  await expect(page.locator("#onbStepCta")).toBeDisabled();
  await page.locator('.obopt[data-val="yes"]').click();
  await expect(page.locator("#onbStepCta")).toBeEnabled();
});

test("CAS-910 AC: v2_kids' Continue is disabled on load and enabled after picking Yes", async ({ page }) => {
  await openStep(page, "v2_kids");
  await expect(page.locator("#onbStepCta")).toBeDisabled();
  await page.locator('#obKidsOpts .obopt[data-val="yes"]').click();
  await expect(page.locator("#onbStepCta")).toBeEnabled();
});

test("CAS-910 AC: v2_partner stays blocked through Yes alone, and clears once the follow-up is answered", async ({ page }) => {
  await openStep(page, "v2_partner");
  const cta = page.locator("#onbStepCta");
  await expect(cta).toBeDisabled();
  await page.locator('#obPartnerOpts .obopt[data-val="yes"]').click();
  await expect(page.locator("#onbStepCta")).toBeDisabled();
  await page.locator('#obPartnerDiffOpts .obopt[data-val="no"]').click();
  await expect(page.locator("#onbStepCta")).toBeEnabled();
});

test("CAS-910 AC: v2_budget omits the ALL WINDOWS scope chip and the unbudgeted switch, and carries the app's own ladder labels", async ({ page }) => {
  await openStep(page, "v2_budget");
  await expect(page.locator(".reqscope")).toHaveCount(0);
  await expect(page.getByText(/budget isn't known/i)).toHaveCount(0);
  const snaps = page.locator(".vsnap");
  await expect(snaps).toHaveCount(5);
  const labels = await snaps.evaluateAll(els => els.map(el => el.childNodes[0].textContent.trim()));
  expect(labels).toEqual(["Off", "Indie", "Studio", "Blockbuster", "Mega"]);
  const subs = await snaps.evaluateAll(els => els.map(el => el.querySelector("small")?.textContent || ""));
  expect(subs).toEqual(["", "$1M+", "$15M+", "$100M+", "$250M+"]);
});

test("CAS-910 AC: dragging the budget dial to position 200 reads Studio · $15M+ and writes answersV2.selScale", async ({ page }) => {
  await openStep(page, "v2_budget");
  const dial = page.locator("#onbDial_scale");
  await dial.evaluate(el => { el.value = "200"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await expect(page.locator("#reqBudgetVal")).toHaveText("Studio · $15M+");
  const selScale = await page.evaluate(() => onbFlow.answersV2.selScale);
  expect(selScale).toBe(15000000);
});

// CAS-910 Change 4: the step counter text is gone from the FIXED chrome (a live, wired flow only — these
// v2 screens aren't listed in FLOWS yet). briefing1 is already wired and chromed, so it's what exercises
// paintFlowChrome's own stepLbl line here.
test("CAS-910 AC: paintFlowChrome leaves #stepLbl empty and hidden on a live, chromed step", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => { flowStart(); });
  await expect(page.locator("#onbStep")).toHaveClass(/chromed/);
  const label = page.locator("#stepLbl");
  await expect(label).toHaveText("");
  await expect(label).toHaveCSS("display", "none");
});

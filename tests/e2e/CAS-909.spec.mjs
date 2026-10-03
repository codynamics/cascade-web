// CAS-909: the onboarding v2 agent reveal — the app's own Agents-screen row (renderAgentsScreen's .agrow),
// minus the reorder grip and Edit button, shown for each of the four ONB_AGENTS_V2 recipes. Preview-only,
// reached via ?step=v2_massive/v2_favs/v2_date/v2_family — none of this is wired into FLOWS yet (CAS-911).
// CAS-1099 retired the localStorage draft key this helper used to seed (cascade_onb_answers_v2 is now
// removed on every boot, and onbAnswersV2Load() just returns the in-memory onbAnswersV2Mem) — v2
// onboarding answers live in memory only until membership completes, so this sets onbFlow.answersV2
// directly, post-boot, and re-opens the step to repaint off it, rather than racing boot's own read of a
// key that no longer exists.
import { test, expect } from "@playwright/test";

/** A guest, network-free boot landed on a v2 reveal step, then `answers` is applied directly to the
 * step's in-memory draft and the step is re-opened so body()/afterFoot() repaint against it. */
async function openReveal(page, stepKey, answers){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto(`/index.html?step=${stepKey}`);
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await expect(page.locator("#onbStep")).toHaveClass(/open/);
  await page.evaluate(({ stepKey, answers }) => {
    onbFlow.answersV2 = { ...onbAnswersV2Default(), ...answers };
    openOnbStep(stepKey);
  }, { stepKey, answers });
  return page.locator("#onbStep .agrow");
}

/** The same watchCount() the app itself reads, called fresh against the same recipe the reveal is
 * currently showing — an independent read, not a scrape of what the DOM already printed.
 * Takes `answers` directly rather than reading onbFlow.answersV2 off the page: openReveal's own
 * post-render openOnbStep() call runs the step's wire() synchronously (renderOnbStep draws body()
 * BEFORE calling wire() — see renderOnbStep's own order), and wire() resets onbFlow.answersV2 to
 * onbAnswersV2Load()'s default right after body() has already rendered off the real fixture answers.
 * By the time any test code runs after openReveal() returns, the global has already been reset to
 * defaults — reading it back here recomputed a DIFFERENT agent (cinema null, not "yes") than the one
 * actually on screen, which is the whole reason this read ever disagreed with the DOM. */
async function expectedWatchCount(page, template, answers){
  return page.evaluate(({ t, answers }) => {
    const c = buildOnbAgentsV2({ ...onbAnswersV2Default(), ...answers }).find(a => a.template === t);
    return c ? watchCount(c) : null;
  }, { t: template, answers });
}

const MASSIVE_ANSWERS = { cinema: "yes", rent: "no" };
const FAVS_ANSWERS = { cinema: "yes", styles: ["Thriller", "Drama"], selScale: 15000000, ages: ["M", "MA 15+"] };
const DATE_ANSWERS = { cinema: "yes", partner: "yes", partnerDiff: "no", styles: ["Thriller", "Drama"] };
const FAMILY_ANSWERS = { cinema: "yes", kids: "yes" };

test("CAS-909 AC2: v2_massive renders exactly one .agrow, ranked 1, with no grip and no Edit button", async ({ page }) => {
  const row = await openReveal(page, "v2_massive", MASSIVE_ANSWERS);
  await expect(row).toHaveCount(1);
  await expect(row.locator(".agrank")).toHaveText("1");
  await expect(page.locator(".aggrip")).toHaveCount(0);
  await expect(page.locator(".ag-edit")).toHaveCount(0);
});

// CAS-1123 removed the separate Notify switch (every trailing window the agent watches rings now, no
// extra row needed to say so) — onbAgentRevealHTML never emits a NOTIFY row any more.
// CAS-1113 ("one score per agent, not a stepped ladder") made every window from the BIG window onward
// (onbFavsMarkersV2) share the identical solved score — cinema answered Yes puts the BIG window at
// in_cinema, so SCORE now carries all three trailing windows (cinema, rent, streaming) at that one score,
// not cinema alone.
test("CAS-909 AC3: v2_massive's settings grid is exactly SCORE/AUDIENCE, and SCORE reads the one solved score across cinema, rent and streaming (CAS-1113)", async ({ page }) => {
  const row = await openReveal(page, "v2_massive", MASSIVE_ANSWERS);
  const labels = await row.locator(".agslbl").allInnerTexts();
  expect(labels).toEqual(["SCORE", "AUDIENCE"]);

  // Computed off MASSIVE_ANSWERS directly, not onbFlow.answersV2 — see expectedWatchCount's own comment
  // above for why the global can't be trusted here once openReveal() has returned.
  const score = await page.evaluate(answers =>
    buildOnbAgentsV2({ ...onbAnswersV2Default(), ...answers })
      .find(a => a.template === "onb_massive").watchMarkers.in_cinema, MASSIVE_ANSWERS);
  expect(score).not.toBeNull();

  const scoreVal = row.locator(".agsrow", { has: page.locator(".agslbl", { hasText: "SCORE" }) }).locator(".agsval");
  await expect(scoreVal.locator(".agdot")).toHaveCount(3);
  await expect(scoreVal).toContainText(`${score}+ in cinema · ${score}+ rent · ${score}+ streaming`);
});

test("CAS-909 AC4: v2_favs' settings grid is exactly STYLES/SCORE/BUDGET/AUDIENCE", async ({ page }) => {
  const row = await openReveal(page, "v2_favs", FAVS_ANSWERS);
  const labels = await row.locator(".agslbl").allInnerTexts();
  expect(labels).toEqual(["STYLES", "SCORE", "BUDGET", "AUDIENCE"]);
});

test("CAS-909 AC5: no .agsval reads bare Any or Any style, in any of the four reveals", async ({ page }) => {
  const cases = [
    ["v2_massive", MASSIVE_ANSWERS],
    ["v2_favs", FAVS_ANSWERS],
    ["v2_date", DATE_ANSWERS],
    ["v2_family", FAMILY_ANSWERS],
  ];
  for(const [stepKey, answers] of cases){
    const row = await openReveal(page, stepKey, answers);
    const values = await row.locator(".agsval").allInnerTexts();
    for(const v of values){
      expect(v.trim()).not.toBe("Any");
      expect(v.trim()).not.toBe("Any style");
    }
  }
});

test("CAS-909 AC6: .agmstat.total reads N movies, matching watchCount() computed independently", async ({ page }) => {
  const row = await openReveal(page, "v2_massive", MASSIVE_ANSWERS);
  const totalText = (await row.locator(".agmstat.total").innerText()).trim();
  expect(totalText).toMatch(/^\d+ movies$/);
  const shown = Number(totalText.match(/^(\d+) movies$/)[1]);
  const expected = await expectedWatchCount(page, "onb_massive", MASSIVE_ANSWERS);
  expect(expected).not.toBeNull();
  expect(shown).toBe(expected);
});

test("CAS-909 AC7: with reduced motion emulated, the row's animation is switched off", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const row = await openReveal(page, "v2_massive", MASSIVE_ANSWERS);
  const animationName = await row.evaluate(el => getComputedStyle(el).animationName);
  expect(animationName).toBe("none");
});

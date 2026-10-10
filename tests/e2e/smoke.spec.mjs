// CAS-385: the gate is a smoke test — build + boot + this fixed, small set of critical-path checks. It
// replaces the per-ticket casNNN.spec.mjs specs (each pinned to one commit's exact copy/DOM, so a later
// approved UI change broke the gate for a reason that had nothing to do with a real regression) and the
// older spec-conformance/counts suites (same brittleness, just not filed under one ticket number).
//
// Every check here asserts BEHAVIOUR — a flow completes, a count moves, a control does the thing it says —
// never exact copy, colours or DOM shape, so a future approved UI change cannot turn this gate red. The five
// flows are the ones CAS-385 names as the app's core: app loads, onboarding builds a real agent roster,
// recommendations render, a film's Watched control works, and the my-services filter actually filters.
import { test, expect } from "@playwright/test";
import {
  freshApp, gotoFresh, toShortlist, shortlistCards, finishFlow, toListing, settleListing, ctaLocator, sectionCounts,
  openWhereWhenScreen, closeWhereWhenScreen, openMyServicesScreen, closeMyServicesScreen, openNotifyScreen,
  dumpSignedInDiagnostics, openAgentsScreenFromNav,
} from "./helpers.mjs";

// CAS-1136 decision 2: on a failed or timed-out test, show the in-flight requests and buffered console
// lines helpers.mjs recorded for whichever signed-in boot this test used — a no-op for guest-mode tests
// and for passing ones. Playwright still runs afterEach hooks on a timeout, which is the whole point.
test.afterEach(async ({ page }, testInfo) => {
  dumpSignedInDiagnostics(page, testInfo);
});

// Mirrors cas565.spec.mjs's addSecondAgent — a second agent made from "+ Add" stops at the Briefing hub
// instead of walking the splash flow, so it needs its own exit.
// CAS-815: this used to answer the cinema/streaming question first — that question is gone, so "+ New
// Cascade" now opens straight on the agent picker.
// CAS-897: CAS-874 deleted the card deck (.dcard) this used to reach "+ New Cascade" through — the same
// newCascade() flow now starts from the Agents screen's own "+ Add" button (renderAgentsScreen's .ag-add).
// Reproduces unmodified at c7ee37f, so it is not a regression from any ticket in this ticket's own window.
// CAS-934: there is no Save button on the hub any more — reaching it by picking a card is itself the
// decision (the same as using a preset unedited anywhere else in the app), so Back commits it.
async function addSecondAgent(page){
  await openAgentsScreenFromNav(page);
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await page.locator(".ag-add").click();
  await expect(page.locator(".scard").first()).toBeVisible();
  const cards = await shortlistCards(page);
  const card = page.locator(".scard", { has: page.locator(".sc-name", { hasText: cards[0].name }) }).first();
  await card.click();
  // CAS-1030/CAS-1018: scoped to #onbStepInner, not a bare "#onbStep .osback" — gotoStep's dual-pane
  // slide leaves the outgoing step's .osback in the DOM alongside the incoming one for the length of
  // the transition (intentional, see gotoStep's own comment), and #onbStepInner is the id it moves onto
  // the incoming pane immediately, so this always resolves to exactly one element.
  await expect(page.locator("#onbStepInner .osback")).toBeVisible();
  await page.locator("#onbStepInner .osback").click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
}

test("the app loads and onboarding renders", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#splashCta")).toBeVisible();
  await page.locator("#splashCta").click();
  // CAS-1018: gotoStep's dual-pane slide keeps the outgoing step's .obhd in the DOM alongside the
  // incoming one for the length of the transition, by design — scoping to #onbStepInner (the id
  // gotoStep moves onto the incoming pane the instant it's created) is what makes this locator
  // resolve to exactly one element even mid-slide, instead of racing the 460ms slide against the
  // fixed 120ms wait below.
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Let's get you set up.");   // v2_about (CAS-953)
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Massive Movies");   // v2_intro (CAS-911)
});

// CAS-911: onboarding generates its roster from the v2 sequence's own four-agent generator
// (buildOnbAgentsV2) and commits it on entering v2_done, the flow's last step. This keeps the
// acceptance criterion CAS-629 originally stated (AC1) — a non-empty roster, every id distinct,
// every one a real Cascade — over the v2 roster a partner-no/kids-no run actually produces.
test("onboarding commits a real, de-duplicated agent roster", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  const roster = await page.evaluate(() => cascades.map(c => ({ id: c.id, name: c.name, sort: c.sort })));
  expect(roster.length).toBeGreaterThan(0);
  expect(new Set(roster.map(c => c.id)).size).toBe(roster.length);
  expect(roster.every(c => c.sort === "cascade")).toBe(true);
  expect(roster.map(c => c.name)).toEqual(["Massive Movies", "Personal Favs"]);
});

test("recommendations render as a results list with items", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const rendered = await settleListing(page);
  expect(rendered).toBeGreaterThan(0);
});

// CAS-901: the Watch listing (no screen/modal open, so none of the app's own JS-driven
// body.style.overflow="hidden" toggles are active) could be dragged sideways on iOS/WebKit — html and body
// carried no CSS overflow-x containment at rest, only the --ui-scale zoom, so documentElement.scrollWidth
// ran wider than clientWidth and WebKit let the document rubber-band pan. Fixed with overflow-x:clip on
// both html and body (AC1-3). AC4 covers the fix's own named regression risk: overflow-x:hidden would force
// a paired overflow-y:auto and put sticky descendants' containing block in question — clip does not, but
// assert the header is still sticky so a future change back to hidden would be caught here.
test("Watch listing has no horizontal overflow and the header stays sticky (CAS-901)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const { scrollWidth, clientWidth, overflowX, headerPosition } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    overflowX: getComputedStyle(document.documentElement).overflowX,
    headerPosition: getComputedStyle(document.querySelector("header")).position,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  expect(overflowX).not.toBe("visible");
  expect(headerPosition).toBe("sticky");
});

test("a film card's Watched control lands an answer", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const first = page.locator("#groups .card").first();
  await expect(first).toBeVisible();
  await first.locator(".ctl.watch").click();
  const options = page.locator(".cpop .cseg .cl");
  await expect(options.first()).toBeVisible();
  await options.first().click();
  await expect.poll(() => page.evaluate(() => watched.size), { timeout: 10_000 }).toBeGreaterThan(0);
});

// CAS-1037: toggleFilmOpt used to repaint the chip and leave the panel open — the one place a level pick
// didn't dismiss its menu the way the Watched panel's pickWatch always has.
test("a film card's Watch On control dismisses its panel after picking a level (CAS-1037)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const first = page.locator("#groups .card").first();
  await expect(first).toBeVisible();
  await first.locator(".ctl.notify").click();
  const row = page.locator(".cpop.npop .nopt[data-wk]:not(.spent)").first();
  await expect(row).toBeVisible();
  const key = await row.getAttribute("data-wk");
  await row.click();
  await expect(page.locator(".cpop")).toHaveCount(0);
  const expectedLabel = await page.evaluate(k => WATCH_LEVEL_SHORT_LABEL[k], key);
  await expect(first.locator(".ctl.notify")).toContainText(expectedLabel);
});

// CAS-647: opening Notify, Tags or Watched on a card left the card blank and cut the top of the list. The
// actual mechanism was a scroll drift (Chromium's silent reveal-scroll on focus, same cause as CAS-315's
// keepRowInPlace fix) rather than anything about a specific control's own state, so this checks the
// mechanism directly — scrollY unmoved and the card's own content still visible — across all three
// controls and the first/mid/last card, per the ticket's acceptance criteria.
// CAS-1034: WebKit-only ~238px scroll-anchor drift, four fix attempts (CAS-315, CAS-647, CAS-1028,
// CAS-1030) with no measured effect — quarantined per CAS-1030's 17:05 AEST 18 Sep 2026 decision rather
// than a fifth blind attempt. Do not weaken the assertion; fix or re-enable only under CAS-1034.
test.fixme("opening Notify, Tags or Watched leaves the card rendered and scroll unmoved", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const cards = page.locator("#groups .card");
  const count = await cards.count();
  expect(count).toBeGreaterThan(2);
  const indices = [0, Math.floor(count / 2), count - 1];

  // CAS-897: .card is content-visibility:auto (CAS-129) — a card this run hasn't scrolled past yet is still
  // on its intrinsic-size placeholder height, not its real one, and the FIRST interaction anywhere in that
  // unvisited stretch is what pays the resulting layout jump, not the control being tested. Scrolling the
  // whole list once first settles every card to its real height before any control is touched, so what's
  // asserted below is the click's own effect, not this test's own cold-scroll artifact.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  for(const i of indices){
    const card = cards.nth(i);
    await card.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => scrollY);
    for(const ctl of [".ctl.notify", ".ctl.casc", ".ctl.watch"]){
      await card.locator(ctl).click();
      await expect(card.locator(".titletext")).toBeVisible();
      expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThan(2);
      await page.keyboard.press("Escape");
      await expect(card.locator(".titletext")).toBeVisible();
      expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThan(2);
    }
  }
});

// CAS-1036: scrolling a long Watch list down was smooth, but scrolling back up became jumpy at an
// unpredictable point. content-visibility:auto's contain-intrinsic-size is only ever a GUESS for an
// off-screen row until it's actually laid out for real (CAS-129/CAS-897) — if the guess is wrong, the
// swap from guess to real height is exactly the layout shift CAS-897's own history already names as the
// cause of this kind of drift, and it had gone stale: "CONDENSED CARD, REV 2" (CAS-687 and its own
// follow-ups) re-added a poster-left layout, a Style line, an availability band and a footer action row
// to the collapsed card well after its contain-intrinsic-size was last measured.
//
// Two tests below, not one, because they check different things and only one of them can actually catch
// a regression here:
//
// "the round trip" is the literal shape this ticket's AC2 describes — scroll to the bottom of a long list
// and back, assert the position lands close to where it started. Kept because it is still a legitimate
// coarse regression guard (a badly broken windowing change could still blow the scrollable height out
// entirely), but by itself it is NOT what actually proves this ticket's fix: every variant tried here —
// a discrete window.scrollTo walk, a small-step window.scrollBy walk, both with and without the fix
// applied — measured a 0px correction either way in this Playwright/WebKit harness. That is the same dead
// end CAS-1034's own quarantined test (test.fixme above) hit chasing a related WebKit scroll-anchor bug:
// this harness does not reproduce the on-device drift from a script-driven scroll the way a real touch/
// momentum gesture does. Forcing the round trip to fail on the old, broken CSS to "prove" it wasn't
// possible without either flailing at gesture simulation this repo has already spent four tickets on
// elsewhere, or asserting a tolerance so tight it would be flaky for reasons that have nothing to do with
// this fix. So it stays as a coarse sanity check, not the real assertion.
//
// "the placeholder match" is what actually discriminates. Measured directly against this exact harness:
// with the pre-fix 108px/46px estimates, an off-screen collapsed card's placeholder height was up to 96px
// off its real height (a scale-badge-and-Oscar-mark row wrapping to two lines made the gap worse still);
// with this ticket's measured values it is under a pixel. That is the actual mechanism a real scroll-back
// -up drift is made of, checked without needing the drift itself to show up in a script-driven scroll.
test("Watch listing scroll position survives a long scroll to the bottom and back (CAS-1036)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  // A freshly onboarded roster only matches a handful of films — not long enough to scroll meaningfully.
  // Broadening with a few more real presets, the same "+ Add" flow a person uses from the Agents screen,
  // gives an actually-scrollable list.
  for(const name of ["Date Night", "Family Movies", "Totally Custom"]){
    await openAgentsScreenFromNav(page);
    await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
    await page.locator(".ag-add").click();
    await expect(page.locator(".scard").first()).toBeVisible();
    await page.locator(".scard", { has: page.locator(".sc-name", { hasText: name }) }).first().click();
    await expect(page.locator("#onbStepInner .osback")).toBeVisible();
    await page.locator("#onbStepInner .osback").click();
    await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  }
  // The loop above leaves #agentsScreen open (the real "+ Add" flow returns there so a person can add
  // another preset) — it covers the mood chip below, so close it before interacting with Watch top.
  await page.evaluate(() => window.closeAgentsScreen());
  // CAS-1247: the default mood (Top scores) now caps each stage at its best 10 — too short to scroll
  // meaningfully regardless of roster size. Releases carries no such cap, so select it for this scroll test.
  await page.locator('.moodchip[data-mood="releases"]').click();
  const rendered = await settleListing(page);
  expect(rendered).toBeGreaterThan(15);

  const scrollY = () => page.evaluate(() => window.scrollY);
  const startY = await scrollY();
  expect(startY).toBe(0);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(400);
  const bottomY = await scrollY();
  expect(bottomY).toBeGreaterThan(400);   // actually a scrollable list, not one screen

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  const endY = await scrollY();
  expect(Math.abs(endY - startY), `started at ${startY}, ended at ${endY}`).toBeLessThan(3);
});

test("Watch listing rows' off-screen placeholder height matches their real height (CAS-1036)", async ({ page }) => {
  await freshApp(page);   // exercises cardHTML() and the CSS directly, at real catalogue scale — no
                           // onboarding needed for what this checks
  const diffs = await page.evaluate(async () => {
    const round = n => Math.round(n * 100) / 100;
    const container = document.createElement("div");
    container.id = "groups";
    document.body.appendChild(container);
    const sample = MOVIES.filter(m => m && m.tmdb_id).slice(0, 300);
    container.innerHTML = sample.map(m => cardHTML(m)).join("");
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Rows more than two screens below the fold are the ones genuinely still resting on their
    // content-visibility:auto placeholder — the population CAS-897's original bug, and this ticket's
    // regression of it, actually affects.
    const rows = [...container.querySelectorAll(".card:not(.expanded)")]
      .filter(el => el.getBoundingClientRect().top > window.innerHeight * 2);
    const sampled = rows.filter((_, i) => i % 15 === 0).slice(0, 12);
    const out = [];
    for(const el of sampled){
      const before = round(el.getBoundingClientRect().height);
      el.scrollIntoView({ block: "center" });
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      out.push(round(Math.abs(el.getBoundingClientRect().height - before)));
    }
    container.remove();
    return out;
  });
  expect(diffs.length).toBeGreaterThan(5);   // actually sampled off-screen rows, not an empty list
  const maxDiff = Math.max(...diffs);
  expect(maxDiff, `placeholder→real height mismatches sampled: ${JSON.stringify(diffs)}`).toBeLessThan(10);
});

// CAS-1214: the test above only samples every 15th off-screen row, so it caught today's one real offender
// (a cinfo card whose r-cinfo row carries a badge, Budget AND Gross — see denseCinfo in cardHTML) only by
// the luck of which index landed in the sample. This test covers every cinfo row (every film for which
// condensedShowsScores(m) is false), not a sample, and adds a synthetic film with long badge/Budget/Gross
// values so the check never again depends on the day's catalogue happening to contain that combination.
test("Collapsed cinfo cards' off-screen placeholder height matches their real height, badge+Budget+Gross included (CAS-1214)", async ({ page }) => {
  await freshApp(page);
  const diffs = await page.evaluate(async () => {
    const round = n => Math.round(n * 100) / 100;
    // Same shape real catalogue records use (see cardHTML's own field reads) — budget, gross and
    // popularity pushed to the hundreds-of-millions/top-of-the-ladder range so this film always gets a
    // badge and a Gross cell, regardless of what today's real catalogue happens to contain.
    const synthetic = {
      tmdb_id: 900000001, title: "CAS-1214 Synthetic Blockbuster", year: "2026", genres: ["Action"],
      cinema_date: "2026-12-25", age_rating: "M", worldwide_gross: 950000000, budget: 300000000,
      popularity: 999999, synopsis: "CAS-1214 fixture film — not a real catalogue title.",
      language: "en", culture: "Western", poster: null, trailers: [], director: "Test Director", cast: [],
      award: null, award_text: "", offers: [], status: ["in_cinema"],
      window_dates: { in_cinema: "2026-12-25" }, availability_confidence: "estimated", cinema_release: true,
      release_dates: [], wm_user_rating: null, wm_critic_score: null, wm_popularity_percentile: 99.99,
      outcome: "scored", jw_link: null,
    };
    const cinfoSample = MOVIES.filter(m => m && m.tmdb_id && !condensedShowsScores(m));
    const sample = [...cinfoSample, synthetic];
    const container = document.createElement("div");
    container.id = "groups";
    document.body.appendChild(container);
    container.innerHTML = sample.map(m => cardHTML(m)).join("");
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const rows = [...container.querySelectorAll(".card.cinfo:not(.expanded)")]
      .filter(el => el.getBoundingClientRect().top > window.innerHeight * 2);
    // One pass, not one scrollIntoView per row (CAS-1214 amendment: a 90-ish-row scroll loop measured
    // at ~1s/row and timed out qa #957 at the 90s default). Snapshot every placeholder height, then flip
    // every row to its real layout together and snapshot again — same measurement, one reflow instead of
    // ~90 of them.
    const before = rows.map(el => round(el.getBoundingClientRect().height));
    rows.forEach(el => { el.style.contentVisibility = "visible"; });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = rows.map((el, i) => round(Math.abs(el.getBoundingClientRect().height - before[i])));
    container.remove();
    return out;
  });
  expect(diffs.length).toBeGreaterThan(5);   // actually sampled off-screen cinfo rows, not an empty list
  const maxDiff = Math.max(...diffs);
  expect(maxDiff, `placeholder→real height mismatches, every cinfo row: ${JSON.stringify(diffs)}`).toBeLessThan(10);
});

// CAS-933 reverses CAS-644: a cold load lands on Watch, never Moving. Moving stays reachable from its own
// chip, so the CAS-649 regression this test also covers (Moving rendered at inset:0, z-index:84, covering
// the header — a screen with no navigation and no way out) is now checked there instead of on cold load.
test("a cold load with onboarding seen shows the header, not Moving", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.reload();
  await expect(page.locator("#movingScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#groups .card").first()).toBeVisible();
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator("#navMenuBtn")).toBeVisible();
  await expect(page.locator("#moviesBtn")).toBeVisible();
  await expect(page.locator("#movingBtn")).toBeVisible();

  await page.locator("#movingBtn").click();
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator("#navMenuBtn")).toBeVisible();

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#movingScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#groups .card").first()).toBeVisible();

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
});

// CAS-725: the Watch screen's tab strip is derived from which windows are switched on in Where & when, not
// a fixed three — this walks that path directly (enable Premium, place a film there, disable it again)
// rather than asserting the derivation's internals.
test("the Watch screen's tab strip follows the enabled watch windows", async ({ page }) => {
  // Lee's decision, 2026-10-02: quarantine this spec's signed-in run only — the Premium listing renders
  // empty signed in ([ios]/WebKit, CAS-1133's open diagnostic), but the same spec passes signed out.
  // CASCADE_E2E_SUPABASE_URL is the flag scripts/test-e2e.mjs's signed-in step already sets (see
  // helpers.mjs's signedInEnv), so this stays a no-op the moment a signed-out run exercises this spec again.
  test.fixme(!!process.env.CASCADE_E2E_SUPABASE_URL, "CAS-1133: Premium listing empty when signed in — quarantined by Lee's decision 2026-10-02");
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  // CAS-1223: the old header tab strip (#watchTabs .wtabbtn) is gone — the stage line in #watchTop (one
  // .stagestop per enabled window, same derivation off watchTabsNow()) replaced it.
  await expect(page.locator(".stagestop", { hasText: "Premium" })).toHaveCount(0);

  await openWhereWhenScreen(page);
  await expect(page.locator(".osh", { hasText: "Service tracking" })).toBeVisible();
  const premiumLane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: "Premium" }) });
  await premiumLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(premiumLane).toHaveClass(/on/);
  await closeWhereWhenScreen(page);

  const premiumTab = page.locator(".stagestop", { hasText: "Premium" });
  await expect(premiumTab).toBeVisible();

  // CAS-1028: same live-catalogue coincidence as CAS-723's test below — today's whole catalogue carries only
  // a couple of Premium-window titles, and whether one clears this roster's own score floor (let alone Massive
  // Movies' own age/language/3-year-recency gates, and — since real offers now trip the account-wide "only
  // show on my services" default CAS-915 arms the moment onboarding reaches the services screen — the my-
  // services gate too) is not what CAS-725 claims (that the tab strip and its contents follow the enabled
  // window). Boost a REAL, showable Premium-status film's score/age/language/date in place — not a cloned
  // stand-in — so recomputeFound()'s real admission pass has something guaranteed to pick up and start
  // tracking, the same "mutate, don't fabricate an untracked stand-in" reasoning CAS-897's comment below
  // already gives for not placing a synthetic film here; an estimated placeholder with no real offers (some of
  // today's few Premium-window titles are exactly that) is never showable, so it must be excluded from the
  // pick. prefs.on off is the account-wide twin of the per-tab mineOnly switch already turned off just below —
  // both are "a different feature's default doing its job, not this test's own concern", the same reasoning
  // CAS-897's own comment already gives for the per-tab one.
  // CAS-1133 (release-chat decision, 2026-10-02): temporary diagnostic — the [ios]/WebKit-only
  // failure below is a deterministic 0-match, not a timing flake, and there's no way to see real
  // WebKit console/DOM state from a CC session. This pins down which of the two live hypotheses
  // (no admissible donor found vs. a genuine WebKit render bug) is actually happening before any
  // fix is attempted. Remove once the next qa run's [ios] log line has been read.
  const cas1133Diag = await page.evaluate(() => {
    const donor = MOVIES.find(m => primaryStatus(m) === "pvod" && showable(m));
    if(donor){
      Object.assign(donor, { wm_user_rating: 10, wm_critic_score: 100, language: "en", age_rating: "M", cinema_date: TODAY });
      prefs.on = false;
      recomputeFound();
      render();
    }
    const entry = donor ? notify[donor.tmdb_id] : null;
    return {
      donorId: donor ? donor.tmdb_id : null,
      status: donor ? primaryStatus(donor) : null,
      showable: donor ? showable(donor) : null,
      admitted: donor ? !!(entry && entry.cascadeIds && entry.cascadeIds.length > 0) : null,
      cards: document.querySelectorAll("#groups .card").length,
      premiumTab: Array.from(document.querySelectorAll(".stagestop")).some(el => el.textContent.includes("Premium")),
    };
  });
  console.log(`CAS-1133 donor=${cas1133Diag.donorId ?? "NONE"} status=${cas1133Diag.status} showable=${cas1133Diag.showable} admitted=${cas1133Diag.admitted} cards=${cas1133Diag.cards} premiumTab=${cas1133Diag.premiumTab}`);

  await premiumTab.click();
  // CAS-897: "Show only available on my services" (CAS-753) defaults ON per tab, and this guest session
  // never picks any — leaving it on empties the Premium tab regardless of what's actually available there,
  // which is a different feature's default doing its job, not this test's own concern. Reproduces unmodified
  // at c7ee37f, so it is not a regression from any ticket in this ticket's own window.
  // CAS-1247: mineOnly is now a mood field, not a standalone Filters-sheet switch — flip it the same direct
  // way disableMineOnlyOnCurrentTab() (below in this file) does, rather than through the mood sheet's UI.
  await page.evaluate(() => { setWatchMineOnly(false); render(); });
  // CAS-897: the Premium tab's own real availability data decides which film lands in it — the .ctl.notify
  // "tell me when this reaches a level" control is a notification preference, not placement, so ticking it
  // on an arbitrary upcoming film (the previous approach here) never actually put that film in this tab.
  // Whatever the catalogue's own data already qualifies for Premium is what this checks disappears from
  // Streaming, which is the behaviour CAS-725 names: the tab strip and its contents follow the enabled window.
  const premiumCard = page.locator('#groups .card').first();
  try{
    await expect(premiumCard).toBeVisible();
  }catch(e){
    // CAS-1133 diagnostic (see above): the step 1 decision asks for #groups' innerHTML on failure too.
    const groupsHtml = await page.evaluate(() => (document.querySelector("#groups") || {}).innerHTML || "");
    console.log(`CAS-1133 #groups innerHTML (first 500 chars): ${groupsHtml.slice(0, 500)}`);
    throw e;
  }
  const cardId = await premiumCard.getAttribute("id");
  await page.locator(".stagestop", { hasText: "Streaming" }).click();
  await expect(page.locator(`#${cardId}`)).toHaveCount(0);

  await openWhereWhenScreen(page);
  await premiumLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(premiumLane).not.toHaveClass(/on/);
  await closeWhereWhenScreen(page);
  await expect(page.locator(".stagestop", { hasText: "Premium" })).toHaveCount(0);
});

// CAS-723: c.kind retires — every agent now watches every window enabled in Where & when, with no cinema/
// stream narrowing, so a "cinema" preset's listing carries a film's whole journey rather than losing it the
// moment it leaves cinemas. Premium is the only window off by default, so enabling it (the same path CAS-725's
// test above already drives) is what "every window enabled" means here.
test("an agent created with every window enabled lists films at rental or streaming too (CAS-723)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await openWhereWhenScreen(page);
  await expect(page.locator(".osh", { hasText: "Service tracking" })).toBeVisible();
  const premiumLane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: "Premium" }) });
  await premiumLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(premiumLane).toHaveClass(/on/);
  await closeWhereWhenScreen(page);

  // CAS-897: this used to read the rendered Watch listing (settleListing + sectionCounts), but that listing
  // is gated by CAS-713/823's per-tab Watch On tracking (filmMatchesWatchTab requires a film's own notify
  // key to equal the active tab, plus the tab's own standing) — a feature that arrived well after CAS-723 and
  // is orthogonal to it: no card for an untracked film ever appears on the Rent/Stream tabs regardless of
  // this agent's own windows. Reproduces unmodified at c7ee37f, so it is not a regression from any ticket in
  // this ticket's own window. What CAS-723 actually widened is listedBy's own window gate, so read that
  // directly — the same predicate the listing itself filters by, one layer before the per-tab tracking gate.
  await settleListing(page);
  // CAS-1028: whether a real rental/streaming film clears this roster's own score floor is a live-catalogue
  // coincidence, not what CAS-723 actually claims (that the WINDOW GATE admits rental/streaming once every
  // window is enabled, not just cinema/upcoming) — the floor demotion has left runs where nothing at either
  // window clears today's cohort. Clone a real, already-admissible rental film and max its score fields so
  // the window gate is what this assertion is actually exercising, same "mutate MOVIES, real donor, only the
  // field under test overridden" shape tests/js/invariants.test.mjs's CAS-724/CAS-748 fixtures use.
  // CAS-1028: the first rental-status film in MOVIES' own order is not a stable pick — whichever real title
  // it happens to be also carries its OWN age_rating/language/cinema_date/offers, and Massive Movies' onboarding
  // recipe applies a language gate (passesTasteBase), an age gate (age_rating must be M/MA15+/R18+ or
  // absent), a 3-year releasedSince cutoff (onbMassiveCritV2's yearsBack:3) and — once the donor carries any
  // real offer at all — the account-wide "only show on my services" default (CAS-915 arms it the instant
  // onboarding reaches the services screen, and this guest session never picks one) on top of the score floor.
  // All exactly the class of bug this same commit's moving-owner.test.mjs fix and this file's Premium tab-strip
  // fix already named (a donor's own incidental field, or a different feature's own default, tripping a gate
  // unrelated to what the test checks). Overriding only the score fields left this assertion at the mercy of
  // whichever donor MOVIES.find() happens to return and whatever offers it happens to carry that day (an
  // earlier version of this fix passed only because that day's real pick had none); pin every gate the recipe
  // actually applies, and turn the services default off, so the donor's identity cannot matter.
  const listedWindows = await page.evaluate(() => {
    const donor = MOVIES.find(m => primaryStatus(m) === "rental");
    if(donor){
      MOVIES.push({
        ...donor, tmdb_id: -723001, wm_user_rating: 10, wm_critic_score: 100,
        language: "en", age_rating: "M", cinema_date: TODAY,
      });
      prefs.on = false;
    }
    return [...new Set(MOVIES.filter(m => cascades.some(c => listedBy(m, c))).map(m => primaryStatus(m)))];
  });
  expect(listedWindows.some(w => w === "rental" || w === "included_streaming"),
    `no rental/included_streaming among this agent's listed windows: ${JSON.stringify(listedWindows)}`).toBe(true);
});

// CAS-729/CAS-897: the Mission screen was retired by CAS-816 (well before this ticket's own regression
// window) — the score track it carried is now one card on the single-page "Edit Agent" screen
// (briefing.body's msnScoreCardHTML), not behind a separate door, so there is no longer a "Mission" header
// or an .eacard.msn to click through to it. Reaches the SAME track the same way a real edit does: Agents
// screen -> Edit, on the FIRST agent onboarding's own roster already created (no extra "new agent" detour
// needed for a screen that only reads/edits an existing one).
async function openFirstAgentMission(page){
  await openAgentsScreenFromNav(page);
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await page.locator(".ag-edit").first().click();
  await expect(page.locator(".msntrackwrap")).toBeVisible();
}

test("Mission screen: one score track, exactly one handle; a newly account-enabled window starts as an OFF pill, not auto-armed (CAS-1128)", async ({ page }) => {
  // CAS-1143: "stream" here, not "cinema" — onbMassiveCritV2 now marks the BIG window and every LATER
  // window in ladder order (in_cinema, premium, rent, stream), same shape onbFavsMarkersV2 already used,
  // so the Watch -> Streaming empty bug this ticket fixes can't recur. With cinema="yes" BIG is in_cinema,
  // the ladder's own first rung, so Premium would already be a later window and get marked at creation —
  // this test would never see an OFF pill at all. With rent="yes"/cinema="no" (toShortlist's own "stream"
  // kind) BIG is "rent", and Premium sits EARLIER on the ladder, so onbMassiveCritV2 leaves it null —
  // genuinely untouched by onboarding, same as before CAS-1143 — which is what lets this test exercise a
  // window that only becomes followed once a person switches it on for the account, never auto-armed.
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);

  await openFirstAgentMission(page);
  await expect(page.locator(".msntrackwrap")).toHaveCount(1);
  // CAS-1128: one score for the whole agent — exactly one handle, whatever windows it lists.
  await expect(page.locator(".msnmark")).toHaveCount(1);

  // Back out (nothing was actually changed on this visit), then switch Premium on for real through the
  // actual Where & when screen — the same mechanism the CAS-725 tab-strip test above already drives.
  // CAS-897: CAS-816 collapsed the Mission door and the Briefing hub into the one "Edit Agent" screen this
  // helper now opens directly (see openFirstAgentMission above) — one osback closes it, not two.
  // CAS-934: Edit Agent's Back now commits the draft on its way out (there is no separate Save any more),
  // so this only stays a no-op because nothing on the page was touched before backing out.
  await page.locator("#onbStep .osback").click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);

  await openWhereWhenScreen(page);
  const premiumLane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: "Premium" }) });
  await premiumLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(premiumLane).toHaveClass(/on/);
  await closeWhereWhenScreen(page);

  await openFirstAgentMission(page);
  // CAS-1128: windows are independent per-agent toggles now (the CAS-917 start-window-forward model this
  // retires would have auto-armed Premium at the agent's existing score) — enabling Premium for the account
  // adds its pill, but it starts OFF/unticked, never a second handle.
  await expect(page.locator(".msnmark")).toHaveCount(1);
  const premiumPill = page.locator(".msnpill", { hasText: "Premium" });
  await expect(premiumPill).toBeVisible();
  await expect(premiumPill).toHaveClass(/off/);
});

test("Mission screen: dragging the single handle moves every listed window's score together, never independently (CAS-1113)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFirstAgentMission(page);

  // Arrange a known starting point — Cinema, Rent and Stream all listed at the same real score, through the
  // real mutator (setAgentScore) rather than poking watchMarkers by hand. The Massive Movies agent this
  // onboarding path creates starts with only its BIG window (in_cinema) armed and the rest null by design
  // (onbMassiveCritV2) — setAgentScore's own "ticked set unchanged" rule (CAS-1128) means calling it once
  // from that state would only move in_cinema. Dropping to Off first makes every account-enabled window
  // null, so the next call lands on the "Off to a score" rule instead, which arms all of them. msnRebuild()
  // re-renders #msnTrackArea and rewires it, the same way a real pill tap does whenever the ON set or its
  // score changes.
  await page.evaluate(() => {
    const c = onbFlow.draft;
    setAgentScore(c, 0);
    setAgentScore(c, 90);
    msnRebuild();
  });
  const before = await page.evaluate(() => ({ ...onbFlow.draft.watchMarkers }));
  expect(before.in_cinema).toBe(before.rent);
  expect(before.rent).toBe(before.stream);

  // CAS-897: CAS-816 put this track partway down the single-page "Edit Agent" screen, behind the occasions
  // and styles cards above it. Left off the page, boundingBox() still returns real coordinates but they
  // land outside the viewport, so document.elementFromPoint (what a real mouse click hit-tests against)
  // finds nothing there and the whole drag silently no-ops.
  await page.locator(".msntrackwrap").scrollIntoViewIfNeeded();
  const trackBox = await page.locator(".msntrackwrap").boundingBox();
  const handle = page.locator(".msnhandle");
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(trackBox.x + 2, handleBox.y + handleBox.height / 2, { steps: 8 });
  await page.mouse.up();

  const after = await page.evaluate(() => ({ ...onbFlow.draft.watchMarkers }));
  expect(after.in_cinema, JSON.stringify({ before, after })).toBeLessThan(before.in_cinema);
  // CAS-1113/CAS-1128: one score for the whole agent — every ON window must move together, never
  // independently (the old MARKER_MIN_GAP push/never-cross/never-stack guarantees retired by CAS-1113).
  expect(after.rent).toBe(after.in_cinema);
  expect(after.stream).toBe(after.in_cinema);
  await expect(page.locator(".msnmark")).toHaveCount(1);
});

test("Mission screen: the score can be dragged UP again even with a stale marker on a window off in Service tracking (CAS-1184)", async ({ page }) => {
  // CAS-1184: Premium is off in Service tracking by default for every new account, and never visited by
  // this onboarding path (toShortlist never opens Where & when) — so this agent's own Premium marker is
  // exactly the "off-window but still carrying a marker" shape the ticket's observation describes.
  // onbMassiveCritV2 ladder-marks BIG and every later window — with "cinema" as BIG (the ladder's own
  // first rung), Premium (a later rung) gets marked too, at the same starting score as the rest.
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  const agentId = await page.evaluate(() => cascades[0].id);

  await openFirstAgentMission(page);
  const premiumStale = await page.evaluate(() => !windowEnabled("premium") && onbFlow.draft.watchMarkers.premium != null);
  expect(premiumStale, "fixture assumption: Premium must carry a marker while off in Service tracking").toBe(true);

  const before = Number(await page.locator(".msnval").textContent());

  await page.locator(".msntrackwrap").scrollIntoViewIfNeeded();
  const trackBox = await page.locator(".msntrackwrap").boundingBox();
  const handle = page.locator(".msnhandle");
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(trackBox.x + trackBox.width - 2, handleBox.y + handleBox.height / 2, { steps: 8 });
  const dragged = Number(await page.locator(".msnval").textContent());
  expect(dragged, "dragging right must move the score UP, not get stuck at the stale Premium floor").toBeGreaterThan(before);

  await page.mouse.up();
  const released = Number(await page.locator(".msnval").textContent());
  expect(released).toBe(dragged);

  await page.locator("#onbStep .osback").click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  const saved = await page.evaluate(id => cascades.find(c => c.id === id).watchMarkers.in_cinema, agentId);
  expect(saved, "the higher score must still be the saved score after Back, not ratcheted back down").toBe(dragged);
});

test("Mission/hub: no Watch On door, marker values in the Mission card, requirement scope chips, no overflow (CAS-729 AC4/AC5/AC6)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFirstAgentMission(page);

  // AC5: the three requirement cards' scope chips, in order.
  const chips = await page.locator(".reqcard .reqscope").allTextContents();
  expect(chips).toEqual(["ALL WINDOWS", "ONCE RELEASED", "ONCE RELEASED"]);

  // AC6: the screen renders without horizontal overflow — this suite's own "ios" project is already the
  // 390-wide iPhone 13 viewport (playwright.config.js), so no extra sizing is needed here. CAS-897:
  // documentElement.scrollWidth isn't the right gauge — it reports the phone frame's natural (pre-clip)
  // content width regardless of body's own overflow:hidden, which every screen-open path in this app sets
  // as its actual clipping mechanism (document.body.style.overflow="hidden"). Reproduces unmodified at
  // c7ee37f — traced to #cascbar's rail-mode content wanting ~21px more than its box — so it is not a
  // regression from any ticket in this ticket's own window, and nothing pokes past the viewport for real:
  // walk the DOM for an element whose own box is both past the viewport edge AND not clipped by any
  // ancestor (CSS overflow or this app's own body.style.overflow convention).
  const overflowing = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const clips = new Set(["auto", "hidden", "scroll", "clip"]);   // CAS-916: lockBodyScroll's own progressive pair
    return [...document.querySelectorAll("*")].filter(el => {
      if(el.getBoundingClientRect().right <= vw + 1) return false;
      for(let p = el.parentElement; p; p = p.parentElement)
        if(clips.has(getComputedStyle(p).overflowX)) return false;
      return true;
    }).map(el => el.className || el.tagName);
  });
  expect(overflowing, `visibly overflowing: ${JSON.stringify(overflowing)}`).toEqual([]);

  // AC4 (part 2): the Mission card's summary text names each enabled window's marker value. CAS-897:
  // CAS-816 folded the Mission door (.eacard.msn) into the score track's own summary line on the single
  // "Edit Agent" page (msnScoreCardHTML/msnValueLine) — that line is the current equivalent.
  const marks = await page.evaluate(() => {
    const c = onbFlow.draft;
    return WATCH_LEVEL_KEYS.filter(k => windowUsable(c, k)).map(k => c.watchMarkers[k]);
  });
  expect(marks.length).toBeGreaterThan(0);
  const cardText = await page.locator("#onbStep .msnscore").innerText();
  for(const v of marks) expect(cardText, cardText).toContain(String(v));

  // AC4 (part 1): CAS-816 retired the hub of doors entirely (Mission and Style are cards on this one page,
  // not doors to other screens), so there is no "Watch On" door to confirm absent among doors that no
  // longer exist — confirm instead that no separate "Watch On" heading survives anywhere on the page; the
  // windows live only on the score track now.
  await expect(page.locator("#onbStep", { hasText: "Watch On" })).toHaveCount(0);
});

// "Mission screen: dragging repaints segment colours to match their windows; ties break stream-first
// (CAS-732 AC2/AC3)" deleted, CAS-1113: the bug class this pinned (a segment keeping a stale PER-WINDOW
// colour after a drag re-sorted which window it belonged to) cannot recur — there is only ever one handle
// and one neutral fill colour (#c9ced8) now, never multiple simultaneously-coloured segments to mis-sort.
// A window's own colour survives only on its 7px dot in the label stack under the handle, which is keyed
// off the listed-windows array directly on every repaint (paintMsnTrack does not touch it at all — the
// dots are static per render, not part of the in-place drag repaint this bug was in).

test("'Only show films on my services' changes what a new agent finds", async ({ page }) => {
  // Every window a streaming agent lists (Premium/Rent/Streaming) is service-scoped, so switching the
  // filter on with no services named must drop the count — this exercises the real mechanism the switch
  // controls, not just its own visible state.
  // CAS-480: CAS-475 moved this switch out of the per-agent editor into one account-level spoke (top menu
  // -> My services), which only ever writes the global prefs.on. An open agent's OWN service scope is
  // fixed at the moment it was last saved (CAS-199) and does not follow prefs.on afterwards, so flipping
  // the switch while that agent's own listing is on screen has no visible effect.
  // CAS-566: this used to jump to the All view to read the switch's live effect — All is retired, and R3
  // means the only state that ever read prefs.on live (activeCascade() null) is now the zero-agent state,
  // which lists nothing. What the switch actually does is seed a NEW streaming agent's own scope at the
  // moment it's created (line ~10373), so this creates two otherwise-identical stream agents, one before
  // flipping the switch and one after, and compares what each one finds.
  // CAS-897: "what each one finds" used to be read off the rendered Watch listing (settleListing), but that
  // listing's default Cinema tab only ever carries the undecided upcoming/in_cinema bucket (filmMatchesWatchTab)
  // — a streaming agent's own matches sit at rental/included_streaming/pvod, invisible on that tab with no
  // per-film Watch On pick made, the same CAS-713/823 gap CAS-723's test above hits. Reproduces unmodified at
  // c7ee37f, so it is not a regression from any ticket in this ticket's own window. Reads each agent's own
  // listedBy count directly instead — the predicate the listing itself filters by, one layer before the
  // per-tab tracking gate, and a truer match for "what each one finds" than a shared, tab-gated render anyway.
  // CAS-1030: the two-otherwise-identical-agents design above (CAS-566) stopped working once CAS-72's own
  // duplicate-template guard shipped in commitDraft — a second addSecondAgent() pick with the exact same
  // criteria no longer creates a new agent at all, it reopens the FIRST one (the twin match), so
  // newestAgentId found nothing new the second time and the comparison silently read whatever cascade
  // happened to satisfy `id === undefined`. Confirmed against CI: the Agents screen carries only one
  // "Blockbusters" entry after both picks, not two. CAS-853 already made prefs.on a live read inside
  // matchesCriteria for every existing agent's whole life (no per-agent copy to go stale), so a second
  // agent was never actually required to prove the switch's effect — one agent's own listedBy count is
  // read before and after the switch instead.
  // CAS-1030: CAS-915 arms prefs.on=true the instant onboarding's v2_services step is entered — no
  // service has to be picked — and toShortlist above already walks through that step, so by the time
  // this test used to take its "before" reading the switch was already ON, not off as it assumed. The
  // nav-menu click further down then turned it OFF, which only WIDENS the match set (CI showed
  // before=6 after=103, the inverse of what toBeLessThan expects). The old `.toHaveClass(/on/)` check
  // never caught this: "svconly", the toggle's own base class, contains the literal substring "on", so
  // an unanchored /on/ regex matches whether the switch is on or off and proves nothing either way.
  // Fixed by reading prefs.on directly (unambiguous) to force a known OFF baseline before "before" is
  // read, and by anchoring the later class check to the standalone "on" token.
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  const listedCountFor = id => page.evaluate(id => {
    const c = cascades.find(x => x.id === id);
    return c ? MOVIES.filter(m => listedBy(m, c)).length : null;
  }, id);

  const idsSeed = await page.evaluate(() => cascades.map(c => c.id));
  await addSecondAgent(page);
  const agentId = await page.evaluate(ids => cascades.map(c => c.id).find(id => !ids.includes(id)), idsSeed);

  await openMyServicesScreen(page);
  await expect(page.locator(".osh", { hasText: "My services" })).toBeVisible();

  if(await page.evaluate(() => prefs.on)) await page.locator("#onbSvcOnly").click();
  await expect.poll(() => page.evaluate(() => prefs.on)).toBe(false);

  const before = await listedCountFor(agentId);
  expect(before).toBeGreaterThan(0);

  await page.locator("#onbSvcOnly").click();
  await expect(page.locator("#onbSvcOnly")).toHaveClass(/\bon\b/);
  await closeMyServicesScreen(page);   // CAS-934: no Done button any more — back to the listing

  const after = await listedCountFor(agentId);
  expect(after, `before=${before} after=${after}`).toBeLessThan(before);
});

// CAS-1178 AC1: the switch's own tick/aria-pressed flip is synchronous, so it must be visible in the same
// task as the tap — regardless of how long the deferred onbRefresh()/render() behind it takes on a
// populated listing. Measured inside the page (class read, click, class read again, same task) rather than
// through Playwright's own round-trip timing, which would add its own noise on top of whatever this is
// trying to measure.
test("CAS-1178: the My services toggle's tick flips synchronously on a tap", async ({ page }) => {
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  await openMyServicesScreen(page);

  const flipped = await page.evaluate(() => {
    const tog = document.querySelector("#onbSvcOnly");
    const wasOn = tog.classList.contains("on");
    tog.click();
    return tog.classList.contains("on") !== wasOn;
  });
  expect(flipped).toBe(true);
});

// CAS-1178 AC2: five taps fired 250ms apart (comfortably past the double-rAF the fix defers the heavy
// repaint behind) must land on the opposite state from where they started, with prefs.on — the saved value
// — equal to what the control itself shows. An odd number of taps means "never lost, never double-applied"
// is exactly "ends up flipped".
test("CAS-1178 AC2: five taps on the My services toggle, 250ms apart, land on the opposite state", async ({ page }) => {
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  await openMyServicesScreen(page);

  const startOn = await page.evaluate(() => prefs.on);
  for(let i = 0; i < 5; i++){
    await page.locator("#onbSvcOnly").click();
    await page.waitForTimeout(250);
  }
  const finalOn = await page.evaluate(() => prefs.on);
  const controlOn = await page.locator("#onbSvcOnly").evaluate(el => el.classList.contains("on"));
  expect(finalOn, `started ${startOn}, ended ${finalOn} after 5 taps`).toBe(!startOn);
  expect(controlOn).toBe(finalOn);
});

// CAS-740 AC4: a signed-in user's account is the authority on whether they've onboarded, not whatever
// screen this device happened to have open when the account answered. Mirrors the fake-config/fake-
// supabase-js technique the retired cas317.spec.mjs used (CAS-317/CAS-385) — freshApp()/every other test
// here blocks config.js and stays network-free, so this opts back in with its own routes, registered
// before freshApp's block could apply, exactly like that file did.
//
// The classic boot script decides whether to show the splash before the (deferred, async) auth module has
// had any chance to answer "is this device signed in" — that part is unavoidable and not what this tests.
// What CAS-740 fixes is afterSignIn() leaving the wizard running when the account's answer lands AFTER the
// splash's own "Sign up" tap already opened it. The fake's own getSession() deliberately doesn't resolve
// until the test calls window.__cas740ResolveSession() explicitly, so the test can reproduce that exact
// ordering deterministically instead of racing a fixed timer against however long a real page load takes.
//
// CAS-765: the real supabase-js.js is now a plain vendored <script> (window.supabase.createClient), not an
// esm.sh `import()` — so the fake below is a global-assigning classic script too, routed at the local
// bundle's own path instead of the retired esm.sh URL. A vendored ~200KB classic script blocking parse in
// <head> also lengthened page-load time enough that a FIXED delay (the original 600ms) sometimes resolved
// during gotoFresh()'s own navigation, before the test ever got to race it — hence the explicit trigger.
// CAS-1109/CAS-1142: acctLoad() now pages with .select().order().range(), not .select().order() alone — the
// "cascades" mock below must return its row from .range(), not .order(), or acctLoad's own .range() call
// throws on a resolved value with no such method and the account's agent never loads.
const CAS740_FAKE_SUPABASE_GLOBAL = `
  const SEEDED_CASCADE = { id: "740aaaa1-0000-4000-8000-000000000001", user_id: "cas740-user",
    name: "Existing agent", criteria: {}, created_at: "2020-01-01T00:00:00.000Z" };
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: () => new Promise(resolve => { window.__cas740ResolveSession = () => resolve({ data: { session: {
          user: { id: "cas740-user", email: "cas740@example.com" }, access_token: "fake" } } }); }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
        signInWithPassword: async () => ({ data: {}, error: null }),
        signUp: async () => ({ data: {}, error: null }),
        signOut: async () => ({ error: null }),
      },
      from: (table) => table === "cascades"
        ? { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: [SEEDED_CASCADE], error: null }) }) }),
            upsert: () => chain(), delete: () => chain() }
        : chain(),
    };
  } };
`;

// CAS-745: the Agents-screen row's summary line dropped its genre restriction back in CAS-643 to stay
// short, which left no way to see that a Style restriction — not just budget/buzz/rating — was why a film
// was passed over. This drives cascades[0] to a known unrestricted state and then a known restricted one
// (some onboarding recipes seed their own genre defaults, so the roster's own starting state can't be
// trusted either way) and checks the row's own text, addressed by that agent's data-id since row order
// follows c.order, not roster array position.
// CAS-897: CAS-814 (comment above agentStylesSum) retired the single clamped `.agsum` summary line this
// test originally drove — the row's settings are now a fixed grid, one line per criterion (Styles/Score/
// Budget/Awards/Audience, agentSettingsSum et al.), so Styles no longer disappears when unrestricted; it
// reads "Any style" instead. Reproduces unmodified at c7ee37f, so it is not a regression from any ticket in
// this ticket's own window. Reads the Styles row's own .agsval, agentStylesSum's exact wording either way.
test("agent card summary names its Style restriction when set, and reads 'Any style' when there is none (CAS-745)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await openAgentsScreenFromNav(page);
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  const targetId = await page.evaluate(() => cascades[0].id);
  const stylesVal = page.locator(`.agrow[data-id="${targetId}"] .agsrow`,
    { has: page.locator(".agslbl", { hasText: "Styles" }) }).locator(".agsval");
  await expect(stylesVal).toBeVisible();

  await page.evaluate(() => { cascades[0].genre = []; renderAgentsScreen(); });
  await expect(stylesVal).toHaveText("Any style");

  const restricted = await page.evaluate(() => {
    const genres = ALL_GENRES.slice(0, 7);
    cascades[0].genre = genres;
    renderAgentsScreen();
    return genres;
  });
  await expect(stylesVal).toHaveText(`${restricted.slice(0, 3).join(", ")} and ${restricted.length - 3} more`);
});

// CAS-747 AC5: the Budget requirement's opt-in for a film selScaleMatch cannot place at all (no real
// figure, no inference either — see the invariants for that split). With no floor set, selScaleMatch is a
// no-op and the switch has nothing to move, so the floor is pinned to the lowest real stop ($1M, "Indie")
// first — low enough that it only screens off the wholly-unscaled class the switch governs, not a film
// carrying a real figure or an inference (both comfortably clear $1M), so a count change is attributable to
// the switch itself.
test("CAS-747 AC5: the Movie Budget card renders the includeUnbudgeted switch, and toggling it moves the live match count", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFirstAgentMission(page);

  const sw = page.locator("#onbIncludeUnbudgeted");
  await expect(sw).toBeVisible();
  await expect(sw).not.toHaveClass(/on/);   // default stays off (item 3 of the ticket)

  await page.locator('.vsnap[data-snap="1000000"]').click();
  const before = await page.locator("#onbStepCount").innerText();

  await sw.click();
  await expect(sw).toHaveClass(/on/);
  const after = await page.locator("#onbStepCount").innerText();
  expect(after, `before=${before} after=${after}`).not.toBe(before);
});

// CAS-897: the Streaming tab has no default bucket (filmMatchesWatchTab) — an untouched agent shows nothing
// there at all, so the CAS-750 order checks below need at least one film explicitly tracked at a window
// matching its own real standing first. Reproduces unmodified at c7ee37f, so it is not a regression from any
// ticket in this ticket's own window. Calls the same toggleFilmOpt a Watch On pick ends up firing, on a
// specific already-streaming film found by evaluate since no such film has a rendered card to click before
// the tab shows anything.
// CAS-1030: whether a real included_streaming film clears this roster's own admission gates (language,
// age rating, release-recency, the account-wide "only show on my services" default) is a live-catalogue
// coincidence, not what this helper needs — same "clone a real donor, only the gates under test overridden"
// shape as CAS-723/CAS-725's fix above. Finds a real donor already carrying the included_streaming window
// (so the window itself is genuine, untouched), then pins the fields Massive Movies' onboarding recipe
// gates on so the donor's own identity can't matter.
// CAS-1189: CAS-1179 turned on cinemaReleaseOnly in the Massive Movies recipe, so the clone also pins
// cinema_release: true — a streaming donor's own value is false and matchesCriteria rejects it otherwise.
async function trackAStreamingFilm(page){
  await page.evaluate(() => {
    let film = MOVIES.find(m => primaryStatus(m) === "included_streaming" && cascades.some(c => listedBy(m, c)));
    if(!film){
      const donor = MOVIES.find(m => primaryStatus(m) === "included_streaming");
      if(donor){
        film = {
          ...donor, tmdb_id: -750001, wm_user_rating: 10, wm_critic_score: 100,
          language: "en", age_rating: "M", cinema_date: TODAY, cinema_release: true,
        };
        MOVIES.push(film);
        prefs.on = false;
      }
    }
    if(!film || !cascades.some(c => listedBy(film, c))) throw new Error("no included_streaming film listed by this agent");
    toggleFilmOpt(film.tmdb_id, "stream");
    render();
  });
}
// CAS-753: "Show only available on my services" defaults ON per tab, and this guest session never picks
// any — call this once the Streaming tab is active, or it filters trackAStreamingFilm's own film straight
// back out of the home-window section it just tracked it into. watchMineOnly is keyed by the CURRENT tab.
async function disableMineOnlyOnCurrentTab(page){
  await page.evaluate(() => { setWatchMineOnly(false); render(); });
}

// CAS-750: order is a property of the Watch TAB now, not of an agent's retired `kind` — the Cinema tab
// (the default tab a fresh listing lands on) leads with Upcoming, reading the same journey order as CASCADE;
// every other tab is unchanged and still ends with Upcoming.
test("Watch Cinema tab leads with Upcoming; the Streaming tab does not (CAS-750)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const cinemaFirst = await page.locator("#groups .group").first().getAttribute("data-g");
  expect(cinemaFirst).toBe("upcoming");

  await trackAStreamingFilm(page);
  // CAS-1223: the old header tab strip (#watchTabs .wtabbtn) is gone — "Streaming" is still its own single
  // stop in the new stage line (#watchTop .stagestop).
  await page.locator(".stagestop", { hasText: "Streaming" }).click();
  // CAS-753: "my services" defaults ON per tab, and this guest session never picks any — without turning it
  // off here, trackAStreamingFilm's own film is filtered straight back out and the tab never carries anything
  // to read a first group off (see disableMineOnlyOnCurrentTab's own comment above).
  await disableMineOnlyOnCurrentTab(page);
  await settleListing(page);
  const streamFirst = await page.locator("#groups .group").first().getAttribute("data-g");
  expect(streamFirst).not.toBe("upcoming");
});

// CAS-750 AC3's jump bar (#jumpBar/.nowstop) was the subject of a dedicated order-following test here. CAS-
// 1223 removed the Now line from the Watch screen entirely (replaced by the stage line, which narrows the
// list rather than jumping to a spot in it) — there is nothing left for that test to check, so it went with
// the feature rather than being left to assert an empty locator.

// CAS-1180: setOpinion() clears every Watch On rung the moment a verdict is given, so a watched film's
// filmNotifyState(id).key is always empty — filmMatchesWatchTab used to key off that same (now-empty)
// value, so a verdict film could never again pass a non-Cinema tab's scope test, however its own Watched
// chip was set. AC4-6 (the search box widening past tab/window and clearing restoring the prior rows)
// tested Watch's own search box, which CAS-1247 removed from Watch entirely (Find is where search lives
// now) — gone with it, per that ticket's own instruction, rather than left pointed at a dead control.
test("CAS-1180: a watched film shows as a stub when its own chip is on (AC1, AC3)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await trackAStreamingFilm(page);
  await page.locator(".stagestop", { hasText: "Streaming" }).click();
  await disableMineOnlyOnCurrentTab(page);
  await settleListing(page);

  const filmId = await page.evaluate(() => {
    const film = MOVIES.find(m => primaryStatus(m) === "included_streaming" && cascades.some(c => listedBy(m, c)));
    setOpinion(film.tmdb_id, "enjoyed");
    watchHeldOpen[watchTab].clear();   // AC1: the held-this-visit hold is cleared — not what keeps it visible
    render();
    return film.tmdb_id;
  });

  // AC1: no Watched chip on -> not on screen at all. CAS-1229/CAS-1236's decision 3 keeps a person-made
  // change's card in place, showing its new state, until the next navigation (explicitly replacing this
  // test's old immediate-removal expectation — see those tickets' "do not re-raise" note) — switch stage
  // away and back first, the same idiom CAS-1236's own AC4 test (settled-watch-list.spec.mjs) uses to force
  // the rebuild that actually drops the film.
  await page.locator(".stagestop", { hasText: "Upcoming" }).click();
  await settleListing(page);
  await page.locator(".stagestop", { hasText: "Streaming" }).click();
  await settleListing(page);
  await expect(page.locator(`#card-${filmId}`)).toHaveCount(0);

  // Switch the Enjoyed chip on for this tab — CAS-1247: Watched is now a mood-sheet-draft field, not a
  // standalone Filters-sheet chip; drive the live state directly, the same idiom this test already uses
  // for watchGenreOff a few lines below, rather than opening/saving a mood over it.
  await page.evaluate(() => { watchWatchedSel[watchTab].add("enjoyed"); render(); });
  await settleListing(page);

  // AC3: it renders as the existing stub, in the sort's own place.
  const stub = page.locator(`#card-${filmId}`);
  await expect(stub).toBeVisible();
  await expect(stub).toHaveClass(/stub/);
  const order = await page.evaluate((id) => {
    const rendered = [...document.querySelectorAll("#groups .card, #groups .stub")].map(el => el.id.replace("card-", ""));
    const rows = watchScopeRows().filter(m => filmMatchesWatchedFilter(m) || watchHeldOpen[watchTab].has(m.tmdb_id));
    const expected = listingGroups(rows, activeCascade()).flatMap(s => s.items.map(m => String(m.tmdb_id)));
    return { renderedIdx: rendered.indexOf(String(id)), expectedIdx: expected.indexOf(String(id)) };
  }, filmId);
  expect(order.renderedIdx).toBeGreaterThanOrEqual(0);
  expect(order.renderedIdx).toBe(order.expectedIdx);

  // Switch the chip back off — same direct idiom as switching it on above — and confirm the film drops out
  // of the list again, the mirror of AC1/AC3's "on" case.
  await page.evaluate(() => { watchWatchedSel[watchTab].delete("enjoyed"); render(); });
  await settleListing(page);
  await expect(page.locator(`#card-${filmId}`)).toHaveCount(0);
});

test("CAS-740 AC4: a signed-in user whose account already holds agents is never left in the onboarding flow", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS740_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  // The module has imported supabase-js and created its client, whose getSession() is now pending on this
  // test's own explicit trigger (see CAS740_FAKE_SUPABASE_GLOBAL above) — not on a timer.
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);

  await expect(page.locator("#splashCta")).toBeVisible();
  await page.locator("#splashCta").click();
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Let's get you set up.");   // v2_about (CAS-953)
  expect(await page.evaluate(() => flowOn)).toBe(true);   // genuinely inside the wizard before the race resolves
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Massive Movies");   // v2_intro (CAS-911) — proves the wizard actually opened

  // Now let the session restore resolve to an account that already holds an agent.
  await page.evaluate(() => window.__cas740ResolveSession());
  // CAS-1044: was 5000ms, well under this suite's own 15s expect timeout — under WebKit CI contention that
  // budget was tight enough to intermittently time out even though the status flip itself is synchronous
  // (setSignedIn runs in the same microtask __cas740ResolveSession's resolve() unblocks); matched to the
  // suite's standard headroom instead.
  await page.waitForFunction(() => window.CascadeAuth.status === "signed-in", null, { timeout: 15_000 });
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  const state = await page.evaluate(() => ({ flowOn, names: cascades.map(c => c.name) }));
  expect(state.flowOn, "the wizard must be exited once the account is known to already have agents").toBe(false);
  expect(state.names, "the account's own roster must be shown, not a second one built by the wizard")
    .toEqual(["Existing agent"]);
});

// CAS-765 AC5: the auth client must never depend on a third-party CDN being reachable — supabase-js is
// vendored locally (supabase-js.js) instead of fetched from esm.sh at runtime. Blocks every request to any
// host other than the app's own origin and the (fake) Supabase project host, and still expects a stored
// session to resolve to signed-in, proving no third-party fetch is required to construct the client.
test("CAS-765 AC5: reaches signed-in state for a stored session with every non-app, non-Supabase host blocked", async ({ page }) => {
  const ALLOWED_HOSTS = new Set(["127.0.0.1", "fake-project.supabase.test"]);
  await page.route("**/*", route => {
    const reqUrl = new URL(route.request().url());
    return ALLOWED_HOSTS.has(reqUrl.hostname) ? route.continue() : route.abort();
  });
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS740_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);
  await page.evaluate(() => window.__cas740ResolveSession());
  // CAS-1044: see the same wait in CAS-740 AC4 above — matched to the suite's standard 15s headroom.
  await page.waitForFunction(() => window.CascadeAuth.status === "signed-in", null, { timeout: 15_000 });
  expect(await page.evaluate(() => window.CascadeAuth.user && window.CascadeAuth.user.email)).toBe("cas740@example.com");
});

// CAS-913: signing out from the Account screen must return the device to the splash, not trap it back on
// the signed-out panel — reverses CAS-733 Change 3's mandatory gate (see app_template.html's setSignedOut).
// Needs a REAL (fake) Supabase config from page load, not freshApp's guest-mode 404: with no config,
// `configured` is false and the whole auth module returns early after setGuest(), so #authSignOut's click
// listener is never even wired — CAS-883's direct window.CascadeAuth mutation can't stand in for that.
// Can't reuse helpers.mjs's toShortlist either, for the same reason gotoFresh's own comment gives for
// cas317.spec.mjs: a route registered later always wins, so toShortlist's inner freshApp() would silently
// overwrite this test's own config.js/supabase-js.js fakes with the guest-mode 404. So the walk to
// v2_services is duplicated here, same technique CAS-911.spec.mjs's own walkToFavs uses for its
// config-reset variant. Signs in AFTER completing first run rather than before, as the ticket's scenario
// narrates it — the header (and so the Account screen) isn't reachable until onboarding finishes, and the
// bug's own code path (setSignedOut() on a device with onboardingSeen()===true) doesn't care which order
// those two happened in, only that both are true by the time sign-out fires.
const CAS913_FAKE_SUPABASE_GLOBAL = `
  const SESSION_KEY = "cas913-fake-session";
  const readSession = () => {
    try{ const raw = localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
  };
  const writeSession = session => {
    try{ session ? localStorage.setItem(SESSION_KEY, JSON.stringify(session)) : localStorage.removeItem(SESSION_KEY); }catch(e){}
  };
  let listeners = [];
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  // CAS-1109/CAS-1142: this test's own onboarding walk creates an agent in guest mode, then signs in —
  // syncCascadesToAccount() uploads that agent via an acctOp "insert" (c.from("cascades").upsert(fields,
  // {onConflict:"id", ignoreDuplicates:true})), and toListing()'s settleListing() wait needs that same agent
  // back from acctLoad's own .select().order().range() round trip before #groups ever has anything to show.
  // The old catch-all chain() resolved every call (including .range()) to a static empty array, so the
  // upload vanished into the void and settleListing() timed out with no agent to build a group from — this
  // tracks whatever was actually "inserted" instead, the same fixture-vs-acctLoad gap CAS740's fixture hit.
  let cascadeRows = [];
  function cascadesTable(){
    return {
      select: () => ({ order: () => ({ range: () => Promise.resolve({ data: cascadeRows.slice(), error: null }) }) }),
      upsert: (fields) => {
        const row = Array.isArray(fields) ? fields[0] : fields;
        const i = cascadeRows.findIndex(r => r.id === row.id);
        if(i >= 0) Object.assign(cascadeRows[i], row); else cascadeRows.push(Object.assign({}, row));
        return { then: (resolve) => resolve({ data: [row], error: null }) };
      },
      delete: () => chain(),
    };
  }
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: async () => ({ data: { session: readSession() } }),
        onAuthStateChange: (cb) => {
          listeners.push(cb);
          return { data: { subscription: { unsubscribe(){ listeners = listeners.filter(f => f !== cb); } } } };
        },
        // CAS-1056: email OTP replaces the derived-password scheme — signInWithOtp only "sends" a code
        // (there is nothing to actually deliver here), and verifyOtp is what lands the session, same as
        // the real client's contract.
        signInWithOtp: async () => ({ data: {}, error: null }),
        verifyOtp: async ({ email }) => {
          const session = { user: { id: "cas913-user", email }, access_token: "fake" };
          writeSession(session);
          listeners.forEach(cb => cb("SIGNED_IN", session));
          return { data: { session }, error: null };
        },
        signOut: async () => {
          writeSession(null);
          listeners.forEach(cb => cb("SIGNED_OUT", null));
          return { error: null };
        },
      },
      from: (table) => table === "cascades" ? cascadesTable() : chain(),
      // CAS-1099: membStart() now calls rpc("email_has_account") before requesting a code, and
      // rpc("complete_membership") once the code verifies — neither existed when this fixture was written,
      // so an un-stubbed client.rpc(...) threw synchronously (client.rpc is not a function) the instant the
      // membership button was pressed, hanging every caller of toListing() against this fixture. This test
      // only exercises the ordinary brand-new-signup path, so both resolve as a fresh success: no existing
      // account, membership created.
      // CAS-1109: complete_membership is the ONLY place this test's onboarding-built agent ever reaches the
      // server (membCompleteNewMembership sends it as p.agents) — acctLoad's subsequent round trip is now
      // the sole way it comes back (CAS-1109 removed loadAccount's old local-only merge), so the mock must
      // actually create it here, the same as a real complete_membership would, or settleListing() never
      // sees a group.
      rpc: async (fn, params) => {
        if(fn === "email_has_account") return { data: false, error: null };
        if(fn === "complete_membership"){
          // CAS-1176 AC7: recorded so a test can inspect what membCompleteNewMembership actually sent,
          // without this fixture needing its own notify_prefs table (every other table here falls through
          // to chain()'s empty-array default, which is exactly what drives loadNotifyPrefs' own
          // genuinely-missing-row bootstrap branch instead).
          window.__cas1176CompleteMembershipNotify = params && params.p && params.p.notify;
          const agents = (params && params.p && params.p.agents) || [];
          agents.forEach(a => {
            const row = Object.assign({ user_id: "cas913-user", created_at: new Date().toISOString() }, a);
            const i = cascadeRows.findIndex(r => r.id === row.id);
            if(i >= 0) Object.assign(cascadeRows[i], row); else cascadeRows.push(row);
          });
        }
        return { data: "created", error: null };
      },
    };
  } };
`;

async function cas913GotoConfigured(page){
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS913_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);
}

// Mirrors helpers.mjs's toShortlist body exactly (see this test's own comment above for why it can't just
// call toShortlist).
async function cas913WalkToShortlist(page){
  await expect(page.locator("#splashCta")).toBeVisible();
  await page.locator("#splashCta").click();
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Let's get you set up.");   // v2_about (CAS-953)
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Massive Movies");            // v2_intro
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
  for(const marker of ["v2_massive", "v2_handoff", "v2_styles", "v2_budget", "v2_ages", "v2_favs"]){
    await ctaLocator(page).click();
    await page.waitForTimeout(120);
  }
  await expect(page.locator("#obPartnerOpts")).toBeVisible();                     // v2_partner
  await page.locator('#obPartnerOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#obKidsOpts")).toBeVisible();                        // v2_kids — v2_date skipped
  await page.locator('#obKidsOpts .obopt[data-val="no"]').click();
  await page.evaluate(() => { prefs.touched = true; prefs.on = false; });         // CAS-1167 AC4: must arm anyway
  await ctaLocator(page).click();
  await page.waitForTimeout(120);                                                 // v2_family skipped
  await expect(page.locator("#obSvcStores")).toBeVisible();                       // v2_services
  await expect(page.locator("#obSvcOnly")).toHaveCount(0);                        // CAS-1167: toggle removed
  for(const boxId of ["obSvcStores", "obSvcSubs"]){
    const { chipWidth, boxWidth } = await page.evaluate(id => {
      const box = document.getElementById(id);
      const chip = box.querySelector(".chip.svcmore");
      return { chipWidth: chip.getBoundingClientRect().width, boxWidth: box.getBoundingClientRect().width };
    }, boxId);
    expect(Math.abs(chipWidth - boxWidth)).toBeLessThanOrEqual(2);
  }
  expect(await page.evaluate(() => prefs.on)).toBe(true);                         // CAS-1167: armed regardless of touched
}

test("CAS-913: signing out from the Account screen returns to the splash and survives a reload", async ({ page }) => {
  await cas913GotoConfigured(page);
  await cas913WalkToShortlist(page);
  await finishFlow(page);
  // CAS-1030: CAS-387's membNeedsEmail() gate means a configured, signed-out device (this test's whole
  // premise) must supply an email to finish onboarding at all — toListing()'s own #membEmail fill (added
  // for this exact scenario, since every other spec here runs guest-mode) drives that. CAS-1056:
  // toListing() now also confirms the code on the account modal's own #authVerify step (the fake client's
  // verifyOtp always succeeds), so the account is "Signed in" by the time the listing paints. There is no
  // signed-out account state left to demonstrate a manual sign-in from, so that step (this test used to
  // walk it via the Account screen's "Not signed in" row) is gone — only the sign-out this test is
  // actually about remains.
  await toListing(page);

  // Sign out, from the Account screen's own "Signed in" row.
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Account" }).click();
  await expect(page.locator("#accountScreen")).toHaveClass(/open/);
  await page.locator(".urow", { has: page.locator(".ut", { hasText: "Signed in" }) }).click();
  await expect(page.locator("#authModal")).toHaveClass(/open/);
  await page.locator("#authSignOut").click();

  await expect(page.locator("#splash")).toHaveClass(/open/);
  await expect(page.locator("#authModal")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => localStorage.getItem("cascade_onboarded"))).toBeNull();

  // This is the exact symptom reported: a refresh must not re-trap the device behind the signed-out panel.
  await page.reload();
  await expect(page.locator("#splash")).toHaveClass(/open/);
  await expect(page.locator("#authModal")).not.toHaveClass(/open/);

  // The splash's own front door must still work, and be dismissible — no new mandatory gate in its place.
  await page.locator("#splashLogin").click();
  await expect(page.locator("#authModal")).toHaveClass(/open/);
  await page.locator("#authDone").click();
  await expect(page.locator("#authModal")).not.toHaveClass(/open/);
});

// CAS-913 AC6: a device that onboarded and never signed in keeps its flag and its app — only a REAL
// sign-out clears cascade_onboarded (see setSignedOut's own wasSignedIn guard), so a plain cold boot with
// no session must not be sent to the splash just because Supabase happens to be configured.
test("CAS-913: a device that has onboarded but never signed in boots into the app, not the splash", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html");
  await page.evaluate(() => { try{ localStorage.clear(); localStorage.setItem("cascade_onboarded", "1"); }catch(e){} });
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await expect(page.locator("#splash")).not.toHaveClass(/open/);
  await expect(page.locator("#authModal")).not.toHaveClass(/open/);
});

// CAS-1176 AC7: a new account must start with both in-app and email alerts on — membCompleteNewMembership's
// own RPC argument is the direct check; notifyPrefs.inApp/emailOn being true straight after is the in-memory
// one, read back through this fixture's loadNotifyPrefs bootstrap-insert branch (see that mock's own
// comment above — there is no notify_prefs table here to seed a different answer from).
test("CAS-1176 AC7: a new account's complete_membership call and in-memory notifyPrefs both start with in-app and email alerts on", async ({ page }) => {
  await cas913GotoConfigured(page);
  await cas913WalkToShortlist(page);
  await finishFlow(page);
  await toListing(page);

  const notify = await page.evaluate(() => window.__cas1176CompleteMembershipNotify);
  expect(notify.in_app).toBe(true);
  expect(notify.email_on).toBe(true);

  const prefs = await page.evaluate(() => ({ inApp: notifyPrefs.inApp, emailOn: notifyPrefs.emailOn }));
  expect(prefs.inApp).toBe(true);
  expect(prefs.emailOn).toBe(true);
});

// ---- CAS-1169: membership sign-up enters its code on #membScreen itself, never on #authModal -----------
// Same "configured-but-signed-out" technique as CAS-913 above (cas913GotoConfigured/cas913WalkToShortlist),
// but its own fake Supabase client, since CAS913_FAKE_SUPABASE_GLOBAL's verifyOtp accepts any code —
// AC4 needs one that actually rejects a wrong one.
const CAS1169_GOOD_CODE = "123456";
const CAS1169_FAKE_SUPABASE_GLOBAL = `
  const SESSION_KEY = "cas1169-fake-session";
  const readSession = () => {
    try{ const raw = localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
  };
  const writeSession = session => {
    try{ session ? localStorage.setItem(SESSION_KEY, JSON.stringify(session)) : localStorage.removeItem(SESSION_KEY); }catch(e){}
  };
  let listeners = [];
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  // Same fixture-vs-acctLoad gap CAS913_FAKE_SUPABASE_GLOBAL's own comment explains above.
  let cascadeRows = [];
  function cascadesTable(){
    return {
      select: () => ({ order: () => ({ range: () => Promise.resolve({ data: cascadeRows.slice(), error: null }) }) }),
      upsert: (fields) => {
        const row = Array.isArray(fields) ? fields[0] : fields;
        const i = cascadeRows.findIndex(r => r.id === row.id);
        if(i >= 0) Object.assign(cascadeRows[i], row); else cascadeRows.push(Object.assign({}, row));
        return { then: (resolve) => resolve({ data: [row], error: null }) };
      },
      delete: () => chain(),
    };
  }
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: async () => ({ data: { session: readSession() } }),
        onAuthStateChange: (cb) => {
          listeners.push(cb);
          return { data: { subscription: { unsubscribe(){ listeners = listeners.filter(f => f !== cb); } } } };
        },
        signInWithOtp: async () => ({ data: {}, error: null }),
        // Unlike CAS913_FAKE_SUPABASE_GLOBAL's always-succeeds stub, this one actually checks the code —
        // AC4 needs a wrong one to stay wrong.
        verifyOtp: async ({ email, token }) => {
          if(token !== "${CAS1169_GOOD_CODE}") return { data: {}, error: { message: "Token has expired or is invalid" } };
          const session = { user: { id: "cas1169-user", email }, access_token: "fake" };
          writeSession(session);
          listeners.forEach(cb => cb("SIGNED_IN", session));
          return { data: { session }, error: null };
        },
        signOut: async () => { writeSession(null); return { error: null }; },
      },
      from: (table) => table === "cascades" ? cascadesTable() : chain(),
      rpc: async (fn, params) => {
        if(fn === "email_has_account") return { data: false, error: null };
        if(fn === "complete_membership"){
          const agents = (params && params.p && params.p.agents) || [];
          agents.forEach(a => {
            const row = Object.assign({ user_id: "cas1169-user", created_at: new Date().toISOString() }, a);
            const i = cascadeRows.findIndex(r => r.id === row.id);
            if(i >= 0) Object.assign(cascadeRows[i], row); else cascadeRows.push(row);
          });
        }
        return { data: "created", error: null };
      },
    };
  } };
`;
async function cas1169GotoConfigured(page){
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS1169_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);
}

test("CAS-1169 AC3: a valid new email moves straight to the code step on #membScreen, never opening #authModal", async ({ page }) => {
  await cas1169GotoConfigured(page);
  await cas913WalkToShortlist(page);
  await finishFlow(page);

  await page.locator("#membEmail").fill("cas1169-ac3@example.com");
  await page.locator(".membcta").click();

  await expect(page.locator("#membCode")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#authModal")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe("membCode");
  expect(await page.locator("#membEmail").evaluate(el => el.readOnly)).toBe(true);

  // CAS-1216: #membCode becomes visible synchronously, but membShowCodeState's own scrollIntoView
  // (app_template.html, B6) is deferred two requestAnimationFrame callbacks to let the code block's
  // reflow settle first. A single boundingBox() read right after the visibility wait can land inside
  // that two-frame window and measure .membcta before the scroll has landed — poll until the scroll
  // is actually done before taking the single measurement the assertions below check.
  const viewport = page.viewportSize();
  await expect.poll(async () => {
    const box = await page.locator(".membcta").boundingBox();
    return box.y + box.height;
  }).toBeLessThanOrEqual(viewport.height);

  const box = await page.locator(".membcta").boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
});

test("CAS-1169 AC4: a wrong code stays in State B with an error; Change email returns to State A; a correct code lands on the listing", async ({ page }) => {
  await cas1169GotoConfigured(page);
  await cas913WalkToShortlist(page);
  await finishFlow(page);
  const email = "cas1169-ac4@example.com";

  await page.locator("#membEmail").fill(email);
  await page.locator(".membcta").click();
  await expect(page.locator("#membCode")).toBeVisible({ timeout: 30_000 });

  await page.locator("#membCode").fill("000000");
  await page.locator(".membcta").click();
  await expect(page.locator("#membCodeErr")).toContainText("Wrong or expired code");
  await expect(page.locator("#membScreen.open")).toBeVisible();
  await expect(page.locator("#membCode")).toBeVisible();

  await page.locator("#membChangeEmail").click();
  await expect(page.locator("#membCode")).toBeHidden();
  expect(await page.locator("#membEmail").evaluate(el => el.readOnly)).toBe(false);

  await page.locator("#membEmail").fill(email);
  await page.locator(".membcta").click();
  await expect(page.locator("#membCode")).toBeVisible({ timeout: 30_000 });
  await page.locator("#membCode").fill(CAS1169_GOOD_CODE);
  await page.locator(".membcta").click();
  await expect(page.locator("#membScreen.open")).toBeHidden({ timeout: 30_000 });
});

test("CAS-1169 AC5: an invalid email's error clears on correction without pressing the button; the resend throttle starts at 0:59", async ({ page }) => {
  await cas1169GotoConfigured(page);
  await cas913WalkToShortlist(page);
  await finishFlow(page);

  await page.locator("#membEmail").fill("not-an-email");
  await page.locator(".membcta").click();
  await expect(page.locator("#membEmailErr")).toBeVisible();

  await page.locator("#membEmail").fill("cas1169-ac5@example.com");
  await expect(page.locator("#membEmailErr")).toBeHidden();

  await page.locator(".membcta").click();
  await expect(page.locator("#membResend")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#membResend")).toBeDisabled();
  await expect(page.locator("#membResend")).toHaveText(/^Resend code in 0:\d\d$/);
});

// CAS-1076: v1.0.0 ships free (Lee, 24-26 Sep 2026) — paid membership returns after launch via In-App
// Purchase (CAS-970/971/972). Every price/free-month/subscription-management/cancellation mention is
// gated behind the one MEMBERSHIP_ENABLED flag (app_template.html) rather than deleted outright, so it can
// come back by flipping it. Checks both screens the production QA run found still carrying it: Account
// (the Plan row and the "Manage or cancel" row) and the keepfinding onboarding step (?step=keepfinding
// preview, CAS-226's own $4.99/cancel-any-time copy).
const CAS1076_BANNED_PHRASES = ["$4.99", "free month", "manage or cancel", "cancel any time"];
function expectNoCas1076MembershipCopy(text){
  const lower = (text || "").toLowerCase();
  for(const phrase of CAS1076_BANNED_PHRASES) expect(lower, text).not.toContain(phrase);
}

test("Account and the keepfinding onboarding step carry no paid-membership copy, and Delete account still shows (CAS-1076)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Account" }).click();
  await expect(page.locator("#accountScreen")).toHaveClass(/open/);
  expectNoCas1076MembershipCopy(await page.locator("#accountScreen").innerText());
  await expect(page.locator("#accountScreen .ut", { hasText: "Delete account" })).toBeVisible();

  await page.goto("/index.html?step=keepfinding");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await expect(page.locator("#onbStep")).toHaveClass(/open/);
  expectNoCas1076MembershipCopy(await page.locator("#onbStep").innerText());
});

// CAS-1077: #deleteAcct is a .modal (z-index:50) and #accountScreen is a .uscreen (z-index:84), so the
// confirmation was in the DOM (class "open", display block) but painted underneath the Account screen —
// elementFromPoint at its centre hit the screen behind it, not the modal, so the account could never
// actually be deleted from the app. Fixed by giving #deleteAcct.open the same z-index:91 already used for
// #contact/#feedback, the other sheets that open from an open .uscreen.
// Needs accountWho().in true for renderAccount() to render the row as the clickable acctRow rather than
// acctSoon's disabled "Not built yet" placeholder — set directly on window.CascadeAuth (guest mode still
// creates the object, just with status:"guest") rather than a real (fake) Supabase sign-in, since nothing
// here needs a session that survives a reload: only the flag renderAccount() itself reads.
test("Delete account opens above the Account screen, not behind it (CAS-1077)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.evaluate(() => {
    window.CascadeAuth.status = "signed-in";
    window.CascadeAuth.user = { email: "cas1077@example.com" };
  });

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Account" }).click();
  await expect(page.locator("#accountScreen")).toHaveClass(/open/);

  await page.locator("#accountScreen .urow", { hasText: "Delete account" }).click();
  await expect(page.locator("#deleteAcct")).toHaveClass(/open/);

  // The real hit-test a tap goes through, not just DOM presence — the bug left the modal open in the DOM
  // the whole time, so a class/visibility check alone would never have caught it.
  const modalIsOnTop = await page.evaluate(() => {
    const box = document.getElementById("deleteAcct").getBoundingClientRect();
    const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!(el && el.closest("#deleteAcct"));
  });
  expect(modalIsOnTop, "the confirmation modal must be the top element at its own centre, not the Account screen underneath it").toBe(true);

  await expect(page.locator("#deleteAcctGo")).toBeVisible();
  await expect(page.locator("#deleteAcctGo")).toHaveText("Delete my account");
  // AC4: the gating stays — the button is disabled until the confirm word is typed. Never clicked here.
  await expect(page.locator("#deleteAcctGo")).toBeDisabled();
});

// CAS-1176 AC3-AC6: "How you're told" left the onboarding step frame for its own plain Settings screen —
// no progress bar, LAST ONE or Continue/Skip; email alerts go straight to the signed-in address, with no
// second email field; a browser's in-app toggle is a plain on/off with no OS permission round-trip; the
// back arrow returns to Settings. Starts both toggles off itself (page.evaluate, no re-render needed since
// openNotifyScreen renders fresh off the live notifyPrefs) rather than relying on CAS-1176's own signed-up-
// account defaults, so this test demonstrates the turning-ON behaviour the AC text describes either way.
test("CAS-1176 AC3-AC6: Settings' How you're told has no onboarding chrome, email goes to the signed-in address, in-app is a plain toggle in the browser, and back returns to Settings", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const email = await page.evaluate(() => window.CascadeAuth.user && window.CascadeAuth.user.email);
  await page.evaluate(() => {
    notifyPrefs.emailOn = false; notifyPrefs.email = ""; notifyPrefs.inApp = false;
    saveNotifyPrefs();
  });

  await openNotifyScreen(page);
  await expect(page.locator("#notifyScreen")).toHaveClass(/open/);

  // AC3: the title, and none of the onboarding step frame's chrome.
  await expect(page.locator("#notifyScreen .osh")).toHaveText("How you're told");
  await expect(page.locator("#notifyScreen .oslast")).toHaveCount(0);
  await expect(page.locator("#notifyScreen .osskip")).toHaveCount(0);
  await expect(page.locator("#notifyScreen button", { hasText: "Continue" })).toHaveCount(0);

  // AC4: turning email alerts on, from off, sets the signed-in account's own address — never a typed one.
  await page.locator("#notifyScreen .bigtoggle", { hasText: "Send me alerts by email" }).click();
  expect(await page.evaluate(() => notifyPrefs.emailOn)).toBe(true);
  expect(await page.evaluate(() => notifyPrefs.email)).toBe(email);
  const sentTo = page.locator("#notifyScreen .ossub", { hasText: "Sent to" });
  await expect(sentTo).toBeVisible();
  await expect(sentTo).toContainText(email);

  // AC5: in the browser, turning in-app notifications on never touches the OS permission prompt.
  await page.locator("#notifyScreen .bigtoggle", { hasText: "Allow in-app notifications" }).click();
  expect(await page.evaluate(() => notifyPrefs.inApp)).toBe(true);
  await expect(page.locator("#onbInAppDenied")).not.toBeVisible();

  // AC6: back closes this screen and returns to Settings, open underneath it.
  await page.locator("#notifyScreen .osback").click();
  await expect(page.locator("#notifyScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#settingsScreen")).toHaveClass(/open/);
  await page.locator("#settingsScreen .osback").click();
  await expect(page.locator("#settingsScreen")).not.toHaveClass(/open/);
});

// CAS-1035 AC3: a Watch On tick made just before the tab closes must survive a reload even though it never
// reached the account — the observed bug (Lee, iPhone: two Stream ticks reverted after a swipe-close and
// reopen). Same session-persists-across-a-real-reload technique as CAS913_FAKE_SUPABASE_GLOBAL above (a
// fresh window.supabase per navigation, backed by one real localStorage session key), but film_watch's own
// upsert ALWAYS fails here — the push this device makes never reaches the account, on this reload or the
// next, so the only thing that can be keeping the tick alive across the reload below is acctOp's own
// persisted queue (CAS-1096: film_watch moved onto acctOp — persistQueue() writes it to localStorage
// synchronously, before this reload; CascadePersistence's acctOpPendingOverlay is what loadFilmWatches
// applies it back through, ahead of clearAccountNotify's wipe).
const CAS1035_FAKE_SUPABASE_GLOBAL = `
  const SESSION_KEY = "cas1035-fake-session";
  const readSession = () => {
    try{ const raw = localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
  };
  const writeSession = session => {
    try{ session ? localStorage.setItem(SESSION_KEY, JSON.stringify(session)) : localStorage.removeItem(SESSION_KEY); }catch(e){}
  };
  let listeners = [];
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  function filmWatchTable(){
    return {
      select: () => chain(),   // CAS-1096: acctLoad chains .select().order().range() before its own .then()
      upsert: () => ({ then: (resolve) => resolve({ data: null, error: { message: "network down" } }) }),
      delete: () => chain(),
    };
  }
  // CAS-1109/CAS-1142: same gap as CAS913_FAKE_SUPABASE_GLOBAL above — this test's onboarding walk creates
  // an agent in guest mode, then signs in, and toListing()'s settleListing() wait needs that agent back from
  // acctLoad's own .select().order().range() round trip (via the acctOp "insert" upload) before #groups has
  // anything to build a group from. The catch-all chain() below resolves .range() to a static empty array,
  // so the upload vanished and settleListing() timed out before this test ever reached the Watch On tick it
  // is actually about.
  let cascadeRows = [];
  function cascadesTable(){
    return {
      select: () => ({ order: () => ({ range: () => Promise.resolve({ data: cascadeRows.slice(), error: null }) }) }),
      upsert: (fields) => {
        const row = Array.isArray(fields) ? fields[0] : fields;
        const i = cascadeRows.findIndex(r => r.id === row.id);
        if(i >= 0) Object.assign(cascadeRows[i], row); else cascadeRows.push(Object.assign({}, row));
        return { then: (resolve) => resolve({ data: [row], error: null }) };
      },
      delete: () => chain(),
    };
  }
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: async () => ({ data: { session: readSession() } }),
        onAuthStateChange: (cb) => {
          listeners.push(cb);
          return { data: { subscription: { unsubscribe(){ listeners = listeners.filter(f => f !== cb); } } } };
        },
        // CAS-1056: email OTP replaces the derived-password scheme (see CAS913_FAKE_SUPABASE_GLOBAL above).
        signInWithOtp: async () => ({ data: {}, error: null }),
        verifyOtp: async ({ email }) => {
          const session = { user: { id: "cas1035-user", email }, access_token: "fake" };
          writeSession(session);
          listeners.forEach(cb => cb("SIGNED_IN", session));
          return { data: { session }, error: null };
        },
        signOut: async () => { writeSession(null); return { error: null }; },
      },
      from: (table) => table === "film_watch" ? filmWatchTable() : table === "cascades" ? cascadesTable() : chain(),
      // CAS-1099: see CAS913_FAKE_SUPABASE_GLOBAL's identical stub above — this test also walks finishFlow
      // + toListing() through membStart(), which now needs both RPCs to resolve rather than throw.
      // CAS-1109: see CAS913_FAKE_SUPABASE_GLOBAL's identical complete_membership handling above — this
      // test's onboarding-built agent only exists once this mock creates it from p.agents.
      rpc: async (fn, params) => {
        if(fn === "email_has_account") return { data: false, error: null };
        if(fn === "complete_membership"){
          const agents = (params && params.p && params.p.agents) || [];
          agents.forEach(a => {
            const row = Object.assign({ user_id: "cas1035-user", created_at: new Date().toISOString() }, a);
            const i = cascadeRows.findIndex(r => r.id === row.id);
            if(i >= 0) Object.assign(cascadeRows[i], row); else cascadeRows.push(row);
          });
        }
        return { data: "created", error: null };
      },
    };
  } };
`;
test("CAS-1035 AC3: a Watch On tick survives being closed and reopened before it ever reaches the account", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS1035_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);

  // CAS-913's own walk (duplicated there, not imported from helpers.mjs, for the same reason: toShortlist's
  // inner freshApp() would overwrite this test's own config.js/supabase-js.js routes with guest-mode's 404).
  await cas913WalkToShortlist(page);
  await finishFlow(page);
  await toListing(page);   // CAS-1030/CAS-1056: fills #membEmail, confirms the code — signs in via the fake, landing on the real listing
  await page.waitForFunction(() => window.CascadeAuth.status === "signed-in", null, { timeout: 5000 });

  // Tick a Watch On level the same way CAS-897's trackAStreamingFilm does — via the real toggleFilmOpt, on a
  // film found by evaluate rather than a card on screen, which this roster isn't guaranteed to have.
  const movieId = await page.evaluate(() => {
    const film = MOVIES.find(m => watchLevelsFor(m.tmdb_id).some(l => l.key === "stream" && !l.spent));
    if(!film) throw new Error("no fixture film has an available Stream level");
    toggleFilmOpt(film.tmdb_id, "stream");
    return film.tmdb_id;
  });
  expect(await page.evaluate(id => notify[id] && notify[id].wins && notify[id].wins.stream, movieId)).toBe(true);

  // Reload now — inside the 500ms debounce, never having let the (deliberately always-failing) push land.
  // A real navigation fires pagehide on the old document itself; nothing here needs to dispatch it by hand.
  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.waitForFunction(() => window.CascadeAuth.status === "signed-in", null, { timeout: 5000 });

  await expect.poll(() => page.evaluate(id => notify[id] && notify[id].wins && notify[id].wins.stream, movieId), {
    timeout: 10_000,
  }).toBe(true);
});

// CAS-919: Watchmode is now the Cascade score, and the card is back to one score row — People
// (wm_user_rating) and Critics (wm_critic_score). There is no separate Watchmode comparison row any more
// (CAS-831/CAS-895/CAS-900 are retired). Values are pushed onto a live MOVIES entry and the card
// re-rendered via fastPatchFindRow, the same targeted re-render the app's own opinion/notify flows already
// use. This suite's own "ios" project is already the 390x844 reference frame (playwright.config.mjs).
test("CAS-919: the score row reads Watchmode fields as People/Critics, a missing one is a muted en-dash, and there is no separate Watchmode row", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  // CAS-1191: cascadeScore now blends ratings into an upcoming film's score too, so writing
  // wm_user_rating/wm_critic_score below can move this card's score across the onboarded agent's own
  // marker and make filmInWatchRows silently drop the patch (CAS-750/CAS-823's "film left the list"
  // no-op). Force every window's marker to Off first so the floor can never react to the scores this
  // test is about to set.
  await page.evaluate(() => { WATCH_LEVEL_KEYS.forEach(k => { cascades[0].watchMarkers[k] = 0; }); });

  const cards = page.locator("#groups .card");
  const card = cards.first();
  await expect(card).toBeVisible();
  const id = await card.evaluate(el => Number(el.id.replace("card-", "")));

  await page.evaluate((filmId) => {
    const m = MOVIES.find(x => x.tmdb_id === filmId);
    m.wm_user_rating = 7.6; m.wm_critic_score = 91;
    fastPatchFindRow(filmId);
  }, id);

  await expect(page.locator(`#card-${id} .r-wmscores`)).toHaveCount(0);

  const scoresRow = page.locator(`#card-${id} .mrow.r-scores`);
  await expect(scoresRow).toBeVisible();
  const peopleCell = scoresRow.locator(".m", { hasText: "People" });
  const criticsCell = scoresRow.locator(".m", { hasText: "Critics" });
  await expect(peopleCell.locator(".dot")).toHaveClass(/imdb/);
  await expect(criticsCell.locator(".dot")).toHaveClass(/meta/);
  await expect(peopleCell).toContainText("7.6");
  await expect(criticsCell).toContainText("91");

  await page.evaluate((filmId) => {
    const m = MOVIES.find(x => x.tmdb_id === filmId);
    m.wm_critic_score = null;
    fastPatchFindRow(filmId);
  }, id);
  await expect(criticsCell).toHaveClass(/muted/);
  await expect(criticsCell).toContainText("–");
  await expect(peopleCell).toContainText("7.6");     // the other cell is unaffected
});

// CAS-919: cascadeScore now reads the Watchmode chain directly (AC4: cascadeScore(m) === wmCascadeScore(m)
// for every film), so there is nothing left to compare between two lines — the in-row Cascade cell is gone
// and the score lives only in the title badge. Pop is removed, not relabelled (there was no popularity cell
// before Watchmode).
test("CAS-919: a collapsed card's score row has no Cascade cell and no Pop cell, only People/Critics", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  // CAS-1191: see the sibling People/Critics test above — blending ratings into an upcoming film's score
  // means the patch below can itself push this card across the onboarded agent's marker, so force every
  // window's marker to Off first.
  await page.evaluate(() => { WATCH_LEVEL_KEYS.forEach(k => { cascades[0].watchMarkers[k] = 0; }); });
  // CAS-1247: zeroing every marker above (so the floor can never react to the low scores this test sets)
  // also lifts the agent's own score gate, which widens Upcoming's scope from a handful of high-buzz films
  // to nearly all of them. The default mood (Top scores) caps each stage at its best 10 — against this
  // widened scope, patching the first card's score down to 4.0/40 can drop it far enough to fall out of
  // that cap, silently no-oping fastPatchFindRow (same "film left the list" shape CAS-750/CAS-823 named
  // above, just via the cap rather than m.status). Releases carries no cap, so select it first.
  await page.locator('.moodchip[data-mood="releases"]').click();

  const cards = page.locator("#groups .card");
  const card = cards.first();
  await expect(card).toBeVisible();
  const id = await card.evaluate(el => Number(el.id.replace("card-", "")));

  // CAS-750/CAS-823: fastPatchFindRow bails out silently (no DOM write at all — "film left the list, let
  // render() handle it") once filmInWatchRows(m) says the film no longer matches the CURRENT tab's own
  // scope. This test never switches tabs off the default Cinema one, so forcing m.status to a home-window
  // value here (the row's own gate needs no such thing — condensedShowsScores/scoresRowHTML read only
  // wm_user_rating/wm_critic_score) silently no-oped the patch and left the assertions below reading a
  // stale, unpatched card. Leave status alone, the same way the sibling People/Critics test above does.
  await page.evaluate((filmId) => {
    const m = MOVIES.find(x => x.tmdb_id === filmId);
    m.wm_user_rating = 4.0; m.wm_critic_score = 40;
    fastPatchFindRow(filmId);
  }, id);

  const card2 = page.locator(`#card-${id}`);
  await expect(card2).not.toHaveClass(/expanded/);

  const scoresRow = card2.locator(".mrow.r-scores");
  await expect(scoresRow).toBeVisible();
  await expect(card2.locator(".mrow.r-wmscores")).toHaveCount(0);
  await expect(scoresRow.locator(".m", { hasText: "Cascade" })).toHaveCount(0);
  await expect(scoresRow.locator(".m", { hasText: "Pop" })).toHaveCount(0);
  await expect(scoresRow.locator(".m", { hasText: "People" })).toBeVisible();
  await expect(scoresRow.locator(".m", { hasText: "Critics" })).toBeVisible();
});

// CAS-900 (kept, re-targeted for CAS-919): the collapsed-card score row is 12px cells/values and 11px
// labels, now over the single People/Critics row rather than two rows.
test("CAS-900: collapsed-card score row is 12px/11px type with People/Critics labels", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  // CAS-1191: see the sibling "no Cascade cell and no Pop cell" test above — force every window's
  // marker to Off so blending ratings into an upcoming film's score can't itself move this card across
  // the onboarded agent's own marker.
  await page.evaluate(() => { WATCH_LEVEL_KEYS.forEach(k => { cascades[0].watchMarkers[k] = 0; }); });
  // CAS-1247: see the sibling "no Cascade cell and no Pop cell" test above — zeroing every marker widens
  // Upcoming's scope enough that patching this card's score down to 4.0/40 can drop it out of the default
  // mood's top-10-per-stage cap, silently no-oping fastPatchFindRow. Releases carries no cap.
  await page.locator('.moodchip[data-mood="releases"]').click();

  const cards = page.locator("#groups .card");
  const card = cards.first();
  await expect(card).toBeVisible();
  const id = await card.evaluate(el => Number(el.id.replace("card-", "")));

  // CAS-750/CAS-823: see the sibling "no Cascade cell and no Pop cell" test above — forcing m.status here
  // pulls the film out of the current (Cinema) tab's own scope, so fastPatchFindRow's filmInWatchRows gate
  // silently no-ops the patch instead of writing the new scores. Not needed anyway: the row's own type only
  // depends on wm_user_rating/wm_critic_score being present.
  await page.evaluate((filmId) => {
    const m = MOVIES.find(x => x.tmdb_id === filmId);
    m.wm_user_rating = 4.0; m.wm_critic_score = 40;
    fastPatchFindRow(filmId);
  }, id);

  const cardEl = page.locator(`#card-${id}`);
  await expect(cardEl).not.toHaveClass(/expanded/);

  const scoresRow = cardEl.locator(".mrow.r-scores");
  await expect(scoresRow).toBeVisible();

  expect(await scoresRow.locator(".m").first().evaluate(el => getComputedStyle(el).fontSize)).toBe("12px");
  expect(await scoresRow.locator(".lab").first().evaluate(el => getComputedStyle(el).fontSize)).toBe("11px");

  const rowText = await scoresRow.innerText();
  expect(rowText).toContain("People");
  expect(rowText).toContain("Critics");
  expect(rowText).not.toContain("Pop");
  expect(rowText).not.toContain("WM");
});

// CAS-765 AC7: the silent guest-mode drop is gone. If the vendored client library ever fails to define
// window.supabase.createClient — forced here by serving a broken bundle in place of the real one — the
// failure must be visible on screen, not just a console.warn no user will ever read.
test("CAS-765 AC7: a forced client-construction failure shows a visible banner, not a silent guest-mode drop", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "/* CAS-765 test double: deliberately does not define window.supabase */",
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.status === "guest");
  const banner = page.locator("#acctBanner");
  await expect(banner).toBeVisible();
  await expect(banner).not.toHaveText("");
});

// CAS-1063 AC2: the old "Not yet saved to your account" banner line reflowed the listing underneath the
// header on every ordinary save (renderAcctBanner's own syncHeaderHeight() call). #savingDot replaces it
// with a fixed-size dot that only ever toggles CSS visibility, never display, so the listing's top offset
// must stay put through the whole lifecycle — before a save starts, while it's outstanding (dot hidden,
// still under the 2s delay), once the dot is actually shown, and after the save drains. Drives the real
// CascadePersistence seam (acctTablePending, the CAS-691 write-pending map acctSavePending() itself reads —
// CAS-1100 retired the CAS-1035 outbox this test used to drive directly) rather than standing up a full
// signed-in account — the concern here is the header's own layout math, which is real regardless of
// whether the row ever actually reaches a live account.
test("CAS-1063 AC2: the saving indicator never moves the listing, before, during or after a save", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const groups = page.locator("#groups");
  const topBefore = (await groups.boundingBox()).y;

  await page.evaluate(() => {
    window.CascadePersistence.SAVING_INDICATOR_DELAY_MS = 30;
    window.CascadePersistence.acctTablePending.cascades = true;
    window.CascadePersistence.renderAcctBanner();
  });
  expect((await groups.boundingBox()).y).toBe(topBefore);   // outstanding, but still under the delay

  await page.waitForFunction(() => document.getElementById("savingDot").classList.contains("show"), null, { timeout: 2000 });
  expect((await groups.boundingBox()).y).toBe(topBefore);   // dot now visible

  await page.evaluate(() => {
    window.CascadePersistence.acctTablePending.cascades = false;
    window.CascadePersistence.renderAcctBanner();
  });
  await page.waitForFunction(() => !document.getElementById("savingDot").classList.contains("show"));
  expect((await groups.boundingBox()).y).toBe(topBefore);   // drained
});

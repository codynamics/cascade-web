// CAS-752: a verdict given on the Watch listing folds the card to its one-line stub IN PLACE, instead of the
// full render() that used to remove the row outright and jump the list several films — the same deferred-
// removal feel a Watch On change already gets; the film is actually gone only once the listing rebuilds.
//
// The ticket's own Hypothesis pointed at fastPatchFindRow's single-row bail check, and reading it at HEAD
// confirmed the mechanism but not the exact cause: that check tested the tapped film against activeCascade()
// — a single-agent idea CAS-718/725 already retired from this aggregated listing — so on a real multi-agent
// roster it bailed to a full render() almost every time, not only once a verdict newly failed the tab's own
// Watched filter. The fix replaces that check with filmInWatchRows(), which mirrors render()'s own per-tab
// filter chain, plus a per-tab session-only hold (watchHeldOpen) so a freshly-verdicted film stays a row
// despite its own new verdict failing the Watched filter.
//
// Two synthetic films, pinned to the same real onboarded agent (so listedBy() admits them without depending
// on catalogue-derived taste matching, same technique cas753.spec.mjs uses) and armed on the same Watch On
// level by hand (winsSource "manual", same technique cas751.spec.mjs uses) — contiguous, same-owner rows, so
// there is no per-agent divider between them to confound the position math in the AC2 checks below.
//
// CAS-1161: every test below was reported failing in e2e-full run #6, which ran against main at 0b31f36 —
// before CAS-1180 (commit ad7e1da) landed. filmMatchesWatchTab's non-cinema branch used to key off the
// film's own Watch On rung (filmNotifyState().key), which setOpinion() unconditionally clears the instant a
// verdict is given — so the verdicted film failed filmMatchesWatchTab, dropped out of watchScopeRows()
// entirely, and never reached stubHTML() at all (not folded, just gone). CAS-1180 switched that branch to
// read a taggedOut film's tab off primaryStatus instead, which is exactly what these tests already assumed.
// Verified by diffing filmMatchesWatchTab across ad7e1da~1 and HEAD: no assertion below needed to change.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

const FILM_A = 900752001;
const FILM_B = 900752002;

async function toWatchScreen(page){
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  return page.evaluate(() => cascades[0].id);
}

async function seedFilms(page, cascadeId){
  await page.evaluate(({ cascadeId, a, b }) => {
    // CAS-788 (post-dates this spec): a verdict now clears wins/winsSource outright and leaves recomputeFound's
    // own auto re-arm to put them back — which needs a real score to clear the owning agent's watchMarkers
    // (CAS-752's AC1 dislikes FILM_A, so this isn't optional here the way it is for cas760's own copy of this
    // fixture, which never calls setOpinion). rt_critic is the least-fussy path to a qualifying cascadeScore.
    MOVIES.push({ tmdb_id: a, title: "CAS-752 — A", status: ["included_streaming"], offers: [], rt_critic: 85 });
    MOVIES.push({ tmdb_id: b, title: "CAS-752 — B", status: ["included_streaming"], offers: [], rt_critic: 85 });
    [a, b].forEach(id => {
      const e = entryFor(id);
      e.pinnedTo = [cascadeId];
      e.wins = { stream: true };
      e.winsSource = { stream: "manual" };
    });
  }, { cascadeId, a: FILM_A, b: FILM_B });
}

async function toStreamTab(page){
  await page.evaluate(() => { setWatchTab("stream"); setWatchMineOnly(false); render(); });
  await settleListing(page);
}

test.afterEach(async ({ page }) => {
  await page.evaluate(ids => {
    ids.forEach(id => {
      const i = MOVIES.findIndex(m => m.tmdb_id === id);
      if(i >= 0) MOVIES.splice(i, 1);
      delete notify[id];
    });
  }, [FILM_A, FILM_B]);
});

test("CAS-752 AC1: a verdict leaves a .stub in the listing (not removed), and the section count drops", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilms(page, cascadeId);
  await toStreamTab(page);

  const group = page.locator('#groups .group[data-g="included_streaming"]');
  const before = Number(await group.locator(".gcount").textContent());

  await page.evaluate(id => setOpinion(id, "disliked"), FILM_A);
  await page.waitForTimeout(400);

  const row = page.locator(`#card-${FILM_A}`);
  await expect(row).toHaveClass(/\bstub\b/);
  await expect(row).toBeVisible();
  const after = Number(await group.locator(".gcount").textContent());
  expect(after).toBe(before - 1);
});

test("CAS-752 AC2: the fold moves only the answered row and its followers — no unrelated jump", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilms(page, cascadeId);
  await toStreamTab(page);

  const rowA = page.locator(`#card-${FILM_A}`);
  const rowB = page.locator(`#card-${FILM_B}`);
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();
  // Contiguous, same-owner rows (both pinned to the one agent) — no per-agent divider between them.
  await expect(page.evaluate(id => document.getElementById(`card-${id}`).nextElementSibling?.id, FILM_A))
    .resolves.toBe(`card-${FILM_B}`);

  const wasTop = await rowA.evaluate(el => el.getBoundingClientRect().top);
  const wasH = await rowA.evaluate(el => el.offsetHeight);
  const bBefore = await rowB.evaluate(el => el.getBoundingClientRect().top);

  await page.evaluate(id => setOpinion(id, "disliked"), FILM_A);
  await page.waitForTimeout(500); // the fold's own .26s transition, settled

  // The answered row folds to its stub AT THE SAME TOP — no jump for anything above or at it.
  const stubTop = await rowA.evaluate(el => el.getBoundingClientRect().top);
  expect(Math.abs(stubTop - wasTop)).toBeLessThan(2);

  // What follows it moves up by (about) the fold's own height delta — the natural, smooth-fold consequence —
  // not a much larger, unrelated jump. The old full-render() fallback dropped the row outright, which would
  // have moved B by the row's full former height rather than by just the height it lost.
  const stubH = await rowA.evaluate(el => el.offsetHeight);
  const bAfter = await rowB.evaluate(el => el.getBoundingClientRect().top);
  const expectedShift = wasH - stubH;
  const actualShift = bBefore - bAfter;
  expect(Math.abs(actualShift - expectedShift)).toBeLessThan(10);
});

test("CAS-752 AC2 (reduced motion): the fold is instant, still no jump", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const cascadeId = await toWatchScreen(page);
  await seedFilms(page, cascadeId);
  await toStreamTab(page);

  await page.evaluate(id => setOpinion(id, "disliked"), FILM_A);
  await page.waitForTimeout(100); // no transition to wait out
  await expect(page.locator(`#card-${FILM_A}`)).toHaveClass(/\bstub\b/);
});

test("CAS-752 AC3: tapping the stub's control to clear the verdict restores the full card in place", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilms(page, cascadeId);
  await toStreamTab(page);

  await page.evaluate(id => setOpinion(id, "disliked"), FILM_A);
  await page.waitForTimeout(400);
  const stub = page.locator(`#card-${FILM_A}`);
  await expect(stub).toHaveClass(/\bstub\b/);

  await stub.locator(".stubbtn").click();
  const litSeg = page.locator(".cpop .cseg.on");
  await expect(litSeg).toBeVisible();
  await litSeg.click();
  await page.waitForTimeout(400);

  const row = page.locator(`#card-${FILM_A}`);
  await expect(row).toHaveClass(/\bcard\b/);
  await expect(row).not.toHaveClass(/\bstub\b/);
});

test("CAS-752 AC4: leaving the Watch listing and returning rebuilds it without the film", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilms(page, cascadeId);
  await toStreamTab(page);

  await page.evaluate(id => setOpinion(id, "disliked"), FILM_A);
  await page.waitForTimeout(400);
  await expect(page.locator(`#card-${FILM_A}`)).toBeVisible();

  await page.evaluate(() => { openAgentsScreen(); closeAgentsScreen(); });
  await settleListing(page);

  await expect(page.locator(`#card-${FILM_A}`)).toHaveCount(0);
  await expect(page.locator(`#card-${FILM_B}`)).toBeVisible();
});

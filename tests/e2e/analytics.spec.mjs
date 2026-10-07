// CAS-940: unique session id, one app_open per load, and first-touch acquisition capture.
// CAS-941: card expansion and Watch-tab switches, the app's own single entry points
// (window.toggleExpand / window.setWatchTab) log exactly once per real user action.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

// A local, param-carrying equivalent of helpers.mjs's freshApp/gotoFresh: those two always land the
// SECOND (real) navigation on a bare /index.html, which would itself mint CLIENT_KEY and fire the first
// app_open before this spec's own "first load" ever happens. Same route-block + clear-then-load shape,
// just with the query string threaded through to the load that's actually under test.
async function freshLoad(page, qs){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto(`/index.html${qs || ""}`);
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
}

const readAcq = page => page.evaluate(() => {
  const v = localStorage.getItem("cascade_acq");
  return v == null ? null : JSON.parse(v);
});
const readLog = page => page.evaluate(() => JSON.parse(localStorage.getItem("cascade_log") || "[]"));

test("CAS-940: first-touch acquisition capture, utm stripping, and one app_open per load", async ({ page }) => {
  // AC3a/b: first load with a full utm set.
  await freshLoad(page, "?utm_source=test&utm_medium=cpc&utm_campaign=spring");

  const acq1 = await readAcq(page);
  expect(acq1.src).toBe("test");
  expect(acq1.med).toBe("cpc");
  expect(acq1.cmp).toBe("spring");
  expect(await page.evaluate(() => location.href)).not.toContain("utm_");

  let log = await readLog(page);
  let opens = log.filter(e => e.type === "app_open");
  expect(opens.length).toBe(1);
  expect(opens[0].plat).toBe("web");
  expect(opens[0].ver).not.toBeNull();
  expect(opens[0].ret).toBe(false);
  const firstSession = opens[0].s;

  // AC3c/d/e: reloading with a different utm_source must not overwrite first touch, but still fires
  // exactly one more app_open, this time returning, under a different session.
  await page.goto("/index.html?utm_source=second");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  const acq2 = await readAcq(page);
  expect(acq2.src).toBe("test");
  expect(await page.evaluate(() => location.href)).not.toContain("utm_");

  log = await readLog(page);
  opens = log.filter(e => e.type === "app_open");
  expect(opens.length).toBe(2);
  expect(opens[1].ret).toBe(true);
  expect(opens[1].s).not.toBe(firstSession);
});

// CAS-753/CAS-1113: a "stream"-kind roster's two onboarding agents carry watchMarkers on rent/stream
// only — a HOME_KEYS tab gated by "Show only available on my services" (default ON), which a fresh
// guest/test account never picks. Worse, since CAS-1113 shares one solved score across every window
// from the BIG window onward, the agents' real catalogue matches here skew to still-upcoming/in-cinema
// titles, so even disabling that switch can land on a tab with nothing released into it yet — not a
// mineOnly gap alone. "cinema" kind lands on the Cinema tab instead, whose own standing (upcoming/
// opening_week/in_cinema) is never gated by "my services" and is exactly what Massive Movies always
// has plenty of (confirmed via CAS-909's own watchCount checks) — the same reliably-populated tab
// smoke.spec.mjs's own Cinema-tab assertions lean on, with no extra toggle needed.
test("CAS-941: expanding and collapsing a card on the Watch listing logs card_expand", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();

  await card.locator(".titletext").first().click();
  await expect(card).toHaveClass(/\bexpanded\b/);

  let log = await readLog(page);
  let expands = log.filter(e => e.type === "card_expand");
  expect(expands.length).toBe(1);
  expect(expands[0].on).toBe(true);
  expect(expands[0].scr).toBe("watch");
  expect(expands[0].tab).toBeTruthy();

  await card.locator(".titletext").first().click();
  await expect(card).not.toHaveClass(/\bexpanded\b/);

  log = await readLog(page);
  expands = log.filter(e => e.type === "card_expand");
  expect(expands.length).toBe(2);
  expect(expands[1].on).toBe(false);
});

test("CAS-941: switching Watch tab logs watch_tab; re-tapping the active tab logs nothing", async ({ page }) => {
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);

  const fromTab = await page.evaluate(() => watchTab);
  // CAS-1223: the old header tab strip (#watchTabs .wtabbtn) is gone — the stage line in #watchTop replaced
  // it; "Streaming" is still its own single stop there (only the Cinema tab split into Upcoming/In Cinema).
  const streamBtn = page.locator("#watchTop .stagestop", { hasText: "Streaming" });
  await expect(streamBtn).toBeVisible();

  await streamBtn.click();
  await expect(streamBtn).toHaveClass(/\bon\b/);

  let log = await readLog(page);
  let tabs = log.filter(e => e.type === "watch_tab");
  expect(tabs.length).toBe(1);
  expect(tabs[0].tab).toBe("stream");
  expect(tabs[0].from).toBe(fromTab);

  // AC4d: tapping the already-active tab is a no-op — the setWatchTab early-out fires first.
  await streamBtn.click();
  log = await readLog(page);
  tabs = log.filter(e => e.type === "watch_tab");
  expect(tabs.length).toBe(1);
});

test("CAS-955: every onboarding step fires onbstep_shown once per entry, ahead of its own continue", async ({ page }) => {
  await toShortlist(page, "stream");
  await finishFlow(page);

  const log = await readLog(page);
  const shown = log.filter(e => e.type === "onbstep_shown");
  const continues = log.filter(e => e.type === "onbstep_continue");

  // AC(b): the flow's first step shows before any continue exists in the log at all.
  // CAS-953 inserted v2_about ahead of v2_intro as the first-run entry step (see gotoStep's own
  // comment), so that — not v2_intro — is the first step this log should ever show.
  const firstRelevant = log.find(e => e.type === "onbstep_shown" || e.type === "onbstep_continue");
  expect(firstRelevant.type).toBe("onbstep_shown");
  expect(firstRelevant.step).toBe("v2_about");

  // AC(a): every step that produced a continue also produced a shown with the identical step value.
  const shownSteps = new Set(shown.map(e => e.step));
  for(const c of continues) expect(shownSteps.has(c.step)).toBe(true);

  // AC(c): a straight run through never re-enters a step, so no step key shows more than once.
  const counts = {};
  shown.forEach(e => { counts[e.step] = (counts[e.step] || 0) + 1; });
  for(const step of Object.keys(counts)) expect(counts[step]).toBe(1);
});


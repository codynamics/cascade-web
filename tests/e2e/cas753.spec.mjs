// CAS-753: Watch list gets a "Show only available on my services" filter, default ON — the Streaming
// section stops listing films only available on a service the viewer hasn't picked.
//
// The real catalogue carries no title with a guaranteed-known, guaranteed-picked-or-not service on it at
// test-authoring time (see tests/js/data-integrity.test.mjs), so this seeds synthetic films straight past
// deriveStatus, same technique cas342.spec.mjs used for the same reason — passes()/primaryStatus()/
// matchesServices() only ever read status/offers off whatever they're given. Each film is PINNED to a real
// onboarded agent (CAS-709's pinnedTo) so listedBy() admits it without depending on catalogue-derived taste
// matching, and its Watch On level is armed by hand with winsSource "manual" (the same technique
// cas751.spec.mjs uses) so recomputeFound() never re-derives it out from under the test.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

const FILM_ON = 900753001;       // offer on a service the viewer picks
const FILM_OFF = 900753002;      // offer on a service the viewer does NOT pick
const FILM_UPCOMING = 900753003; // no offers at all — cinema/upcoming, untouched by this filter

async function toWatchScreen(page, kind){
  await toShortlist(page, kind);
  await finishFlow(page);
  await toListing(page);
  return page.evaluate(() => cascades[0].id);
}

async function seedStreamFilms(page, cascadeId){
  await page.evaluate(({ cascadeId, onId, offId }) => {
    MOVIES.push({ tmdb_id: onId, title: "CAS-753 — On My Service", status: ["included_streaming"],
      offers: [{ type: "sub", service: "Stan", price: null }] });
    MOVIES.push({ tmdb_id: offId, title: "CAS-753 — Not My Service", status: ["included_streaming"],
      offers: [{ type: "sub", service: "Mubi", price: null }] });
    [onId, offId].forEach(id => {
      const e = entryFor(id);
      e.pinnedTo = [cascadeId];
      e.wins = { stream: true };
      e.winsSource = { stream: "manual" };
    });
  }, { cascadeId, onId: FILM_ON, offId: FILM_OFF });
}

async function setMyServices(page, subs){
  await page.evaluate(subs => {
    prefs.sub.clear(); subs.forEach(s => prefs.sub.add(s));
    prefs.store.clear();
    prefs.on = true; savePrefs();
  }, subs);
}

async function toStreamTab(page){
  await page.evaluate(() => setWatchTab("stream"));
  await settleListing(page);
}

test.afterEach(async ({ page }) => {
  await page.evaluate(ids => {
    ids.forEach(id => {
      const i = MOVIES.findIndex(m => m.tmdb_id === id);
      if(i >= 0) MOVIES.splice(i, 1);
      delete notify[id];
    });
  }, [FILM_ON, FILM_OFF, FILM_UPCOMING]);
});

test("CAS-753 AC1/AC2: default on hides a film only on an unpicked service; the Filters toggle restores it", async ({ page }) => {
  const cascadeId = await toWatchScreen(page, "stream");
  await seedStreamFilms(page, cascadeId);
  await setMyServices(page, ["Stan"]);
  await page.evaluate(() => render());
  await toStreamTab(page);

  await expect(page.locator(`#card-${FILM_ON}`)).toBeVisible();
  await expect(page.locator(`#card-${FILM_OFF}`)).toHaveCount(0);
  const before = Number(await page.locator('#groups .group[data-g="included_streaming"] .gcount').textContent());

  // AC2: the Filters dialog's own toggle (styled like the sheet's other rows) restores the hidden film,
  // and the section count moves to match.
  await page.locator("#watchFilterBtn").click();
  const sw = page.locator("#watchMineOnlySwitch");
  await expect(sw).toHaveClass(/\bon\b/);
  await sw.click();
  await expect(sw).not.toHaveClass(/\bon\b/);
  await page.locator(".wsheetclose").click();

  await expect(page.locator(`#card-${FILM_OFF}`)).toBeVisible();
  const after = Number(await page.locator('#groups .group[data-g="included_streaming"] .gcount').textContent());
  expect(after).toBeGreaterThan(before);
});

test("CAS-753 AC3: the toggle persists across a reload; a brand new list still starts on", async ({ page }) => {
  await toWatchScreen(page, "stream");
  // CAS-1150 requeue: pin to "stream" explicitly rather than reading watchMineOnly[watchTab] — watchTab
  // itself is never persisted (pickLandingWatchTab re-derives it from the catalogue on every boot,
  // app_template.html ~18271/19300), so a reload can land on a different tab than whichever one was active
  // when the toggle was set, and this test isn't about which tab happens to land, only whether the toggle
  // itself survives a reload.
  await page.evaluate(() => { setWatchTab("stream"); setWatchMineOnly(false); });
  await expect.poll(() => page.evaluate(() => watchMineOnly.stream)).toBe(false);

  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  expect(await page.evaluate(() => watchMineOnly.stream)).toBe(false);

  // A record this device has never seen before (nothing stored yet) takes the default — on.
  await page.evaluate(() => localStorage.removeItem("cascade_watch_mineonly"));
  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  expect(await page.evaluate(() => watchMineOnly.stream)).toBe(true);
});

test("CAS-753 AC4: on with no services picked shows the honest dead end, not a silent empty list", async ({ page }) => {
  const cascadeId = await toWatchScreen(page, "stream");
  await seedStreamFilms(page, cascadeId);
  await page.evaluate(() => { prefs.sub.clear(); prefs.store.clear(); prefs.on = false; savePrefs(); });
  await toStreamTab(page);

  const empty = page.locator("#groups .empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText(/services/i);
  await expect(empty.locator(".ctabtn")).toBeVisible();
});

test("CAS-753 AC5: a cinema/upcoming film (no offers) is unaffected by the toggle either way", async ({ page }) => {
  const cascadeId = await toWatchScreen(page, "cinema");
  await page.evaluate(({ cascadeId, id }) => {
    MOVIES.push({ tmdb_id: id, title: "CAS-753 — Upcoming Untouched", status: ["upcoming"], offers: [] });
    entryFor(id).pinnedTo = [cascadeId];
  }, { cascadeId, id: FILM_UPCOMING });
  await page.evaluate(() => { prefs.sub.clear(); prefs.store.clear(); render(); });
  await settleListing(page);
  await expect(page.locator(`#card-${FILM_UPCOMING}`)).toBeVisible();

  await page.evaluate(() => setWatchMineOnly(false));
  await settleListing(page);
  await expect(page.locator(`#card-${FILM_UPCOMING}`)).toBeVisible();
});

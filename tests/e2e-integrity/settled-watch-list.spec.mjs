// CAS-1236 (redo of CAS-1229, reverted by CAS-1231): the Watch list used to re-pull every account table on
// every return to the tab (focus and visibilitychange both fire, plus a 3-minute heartbeat) and redraw the
// WHOLE list even when nothing had changed — a card's poster cleared and refetched, the list jumped, and the
// current stage's own count swung, all while the person just sat there. Drives the real app against the
// local Supabase stack, same convention as reconcile-on-return.spec.mjs.
//
// CAS-1231's own failure (a render that ran before the account had finished loading recorded a settled-list
// nav key against an empty list; the account then arrived at the SAME nav key, and the old code only ever
// patched that still-empty list, so it never filled) is covered by AC-LOAD below.
import { test, expect } from "@playwright/test";
import {
  admin, createTestUser, seedCascades, testEmail,
  gotoIntegrityFresh, signInFromSplash, recordRestRequests, seedUserPrefs,
} from "./helpers.mjs";
import { settleListing } from "../e2e/helpers.mjs";

async function waitForAccountLoads(page){
  await page.waitForFunction(() => {
    const cp = window.CascadePersistence;
    return cp && cp.userPrefsReady && cp.notifyPrefsReady && cp.filmWatchReady && cp.agentFilmsReady;
  }, { timeout: 30_000 });
}

// A single agent with no restrictive criteria lists the whole catalogue (CAS-1136's own "wide-open agent"
// reasoning) — enough real films for every test below to find an already-shown card to work with.
async function seedWideOpenAgent(userId){
  const [agent] = await seedCascades(userId, [{ name: "Settled list agent" }]);
  return agent;
}

test("AC1: ten focus and ten visibilitychange events within 30s cause at most one GET to user_films", async ({ page }) => {
  const email = testEmail("cas1236-ac1");
  const user = await createTestUser(email);
  await seedWideOpenAgent(user.id);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  const requests = recordRestRequests(page);
  await page.evaluate(() => {
    for(let i = 0; i < 10; i++){
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  await page.waitForTimeout(1500);

  const userFilmsGets = requests.filter(r => r.table === "user_films" && r.method === "GET");
  expect(userFilmsGets.length, `user_films GETs from the burst: ${JSON.stringify(userFilmsGets)}`)
    .toBeLessThanOrEqual(1);
});

test("AC2: a reconcile that changes nothing on the server calls render() zero times and keeps the same first card", async ({ page }) => {
  const email = testEmail("cas1236-ac2");
  const user = await createTestUser(email);
  await seedWideOpenAgent(user.id);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  // Warm-up pass: establishes every table's own baseline signature (cascades is never pulled during boot
  // itself — only reconcileOnReturn ever calls reconcileCascadesOnReturn), so the SECOND call below is the
  // one actually measuring "nothing changed".
  await page.evaluate(() => window.CascadePersistence.reconcileOnReturn());
  // CAS-1243 (F3): this warm-up reconcile's own first-ever pollCatalogue() fetch (this device holds no
  // catalogue hash yet) can still be in flight when the counter below resets — its landing render() then
  // falls inside the measured pass, reading as a false positive. Wait for that poll to actually settle
  // first; render()/pollCatalogue() themselves are unchanged.
  await page.waitForFunction(() => typeof catalogueHash === "string" && catalogueHash.length > 0, { timeout: 30_000 });
  await page.waitForTimeout(500);

  const firstCardId = await page.evaluate(() => document.querySelector("#groups [id^='card-']")?.id);
  expect(firstCardId, "the seeded wide-open agent must list at least one film").toBeTruthy();

  await page.evaluate(() => { window.CascadePersistence.renderCallCount = 0; });
  await page.evaluate(() => window.CascadePersistence.reconcileOnReturn());
  await page.waitForTimeout(800);

  expect(await page.evaluate(() => window.CascadePersistence.renderCallCount),
    "a reconcile pass that changed nothing on the server must call render() zero times").toBe(0);
  expect(await page.evaluate(() => document.querySelector("#groups [id^='card-']")?.id),
    "the first card must still be the same DOM node's id after a no-op reconcile").toBe(firstCardId);
});

// AC3: a film that newly joins the current stage (here, simulated the same deterministic way cas1226/
// cas1146's own tests inject a synthetic film — pushing a cloned real film into the live MOVIES array and
// wiring its Watch On directly, rather than depending on a real catalogue title's status crossing a window
// boundary at some unpredictable moment a CI run can't control) must not appear, move anything, or change
// any count until the next real navigation — render()'s own settled-list patch (reconcilePatchSettledList)
// only ever updates a card that is already on screen. A direct render() call here stands in for the repaint
// any reconcile pass would trigger: the mechanism under test lives in render() itself, not in how a caller
// got there.
test("AC3: a film that newly belongs on Streaming never appears, moves a card, or changes a count until the next navigation", async ({ page }) => {
  const email = testEmail("cas1236-ac3");
  const user = await createTestUser(email);
  const agent = await seedWideOpenAgent(user.id);
  // CAS-1241 (B3): Streaming is mine-only by default (watchMineOnly) — a seeded account with no services
  // picked lists nothing there regardless of what the wide-open agent matches, which is a test setup gap,
  // not the settled-list mechanism this test is actually about.
  await seedUserPrefs(user.id, { sub_services: ["Netflix"] });

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  await page.evaluate(() => { setWatchTab("stream"); render(); });
  await settleListing(page);

  const before = await page.evaluate(() => ({
    ids: [...document.querySelectorAll("#groups [id^='card-']")].map(el => el.id.slice(5)),
    stageCount: document.querySelector('.stagestop[data-stage="stream"] .stagecount')?.textContent,
  }));
  expect(before.ids.length, "the wide-open agent must list at least 20 real films on Streaming for this test to mean anything")
    .toBeGreaterThanOrEqual(20);

  const card20Id = before.ids[19];
  const card20Top = await page.evaluate((id) => {
    document.getElementById(`card-${id}`).scrollIntoView({ block: "start" });
    return document.getElementById(`card-${id}`).getBoundingClientRect().top;
  }, card20Id);

  const newFilmId = await page.evaluate(({ cascadeId, donorId }) => {
    // CAS-1243 (F4): the clone must itself match Streaming's own scope (mine-only, Netflix-only per this
    // test's seeded services) — cloning an arbitrary catalogue title can land on one whose offers never
    // include stream at all, which fails matchesServices() regardless of the Watch On override set below.
    // Cloning a film the list is already showing guarantees it does.
    const donor = MOVIES.find(m => m.tmdb_id === donorId);
    const id = -1236100001;
    MOVIES.push({ ...donor, tmdb_id: id, status: ["included_streaming"], cinema_date: null });
    notify[id] = { source: "auto", cascadeIds: [cascadeId], pinnedTo: [cascadeId], notIn: [],
      wins: { in_cinema: false, premium: false, rent: false, stream: true }, winsSource: { stream: "manual" } };
    render();
    return id;
  }, { cascadeId: agent.id, donorId: Number(before.ids[0]) });

  const after = await page.evaluate((id20) => ({
    count: document.querySelectorAll("#groups [id^='card-']").length,
    stageCount: document.querySelector('.stagestop[data-stage="stream"] .stagecount')?.textContent,
    card20Top: document.getElementById(`card-${id20}`)?.getBoundingClientRect().top,
  }), card20Id);

  expect(after.count, "the reconcile pass must not change the card count").toBe(before.ids.length);
  expect(after.stageCount, "the reconcile pass must not change the Streaming stage count").toBe(before.stageCount);
  expect(Math.abs(after.card20Top - card20Top), "card 20 must stay at the same viewport y (±2px)").toBeLessThanOrEqual(2);
  expect(await page.evaluate((id) => !!document.getElementById(`card-${id}`), newFilmId),
    "the new film must not appear until the next navigation").toBe(false);

  // Switching stage away and back is a real navigation — the new film must now be listed and counted.
  await page.evaluate(() => { setWatchTab("in_cinema"); render(); setWatchTab("stream"); render(); });
  await settleListing(page);

  expect(await page.evaluate((id) => !!document.getElementById(`card-${id}`), newFilmId),
    "the new film must be listed after the next navigation").toBe(true);
  const afterNav = await page.evaluate(() => document.querySelector('.stagestop[data-stage="stream"] .stagecount')?.textContent);
  expect(afterNav, "the Streaming count must now include the new film").not.toBe(before.stageCount);
});

// AC4: a Watch On change that would move a film OFF the stage currently on screen leaves its card in place,
// showing the new state, until the next navigation — the same decision-3 rule AC3 exercises for a film
// joining, applied to a film leaving.
test("AC4: changing a listed film's Watch On leaves its card on the current stage until the next navigation", async ({ page }) => {
  const email = testEmail("cas1236-ac4");
  const user = await createTestUser(email);
  await seedWideOpenAgent(user.id);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  await page.evaluate(() => { setWatchTab("in_cinema"); render(); });
  await settleListing(page);

  const filmId = await page.evaluate(() => document.querySelector("#groups [id^='card-']")?.id.slice(5));
  expect(filmId, "the seeded wide-open agent must list at least one film on Upcoming").toBeTruthy();

  // CAS-1241 (B1): Watch On is single-select (CAS-716) — ticking Streaming by hand clears Cinema too, the
  // way a real tap on the Watch On picker does. Poking notify[id].wins.stream directly (as this used to)
  // left Cinema still true, so filmNotifyState(id).key read back "in_cinema", not "stream" — a test bug,
  // not an app bug. window.toggleFilmOpt is the real chokepoint the picker itself calls.
  await page.evaluate((id) => {
    window.toggleFilmOpt(Number(id), "stream");
    render();
  }, filmId);

  expect(await page.evaluate((id) => !!document.getElementById(`card-${id}`), filmId),
    "the film's card must still be on the Upcoming screen right after the change").toBe(true);
  expect(await page.evaluate((id) => filmNotifyState(Number(id)).key, filmId),
    "the film's Watch On must already read Streaming").toBe("stream");

  // Switching stage away and back is a real navigation — the film must now be gone from Upcoming.
  await page.evaluate(() => { setWatchTab("stream"); render(); setWatchTab("in_cinema"); render(); });
  await settleListing(page);

  expect(await page.evaluate((id) => !!document.getElementById(`card-${id}`), filmId),
    "the film must have left the Upcoming screen at the next navigation").toBe(false);
});

test("AC5: pinning a film to an agent that doesn't list it on the current stage leaves its card in place", async ({ page }) => {
  const email = testEmail("cas1236-ac5");
  const user = await createTestUser(email);
  await seedWideOpenAgent(user.id);
  const [agentB] = await seedCascades(user.id, [{ name: "Other agent" }]);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  const filmId = await page.evaluate(() => document.querySelector("#groups [id^='card-']").id.slice(5));

  // Switch the Watch screen to agent A only, off agent B — agent A still lists the film (both are
  // wide-open), so the card stays visible, then pin the film onto agent B instead. Under the OLD full
  // render(), a pin that would move a film to an agent not currently included could drop its card entirely;
  // decision 3/AC5 say it must stay, showing its new state, until the next stage switch.
  await page.evaluate((id) => window.toggleWatchAgent(id), agentB.id);
  await expect.poll(() => page.evaluate((id) => !!document.querySelector(`#groups [id="card-${id}"]`), filmId))
    .toBe(true);

  await page.evaluate(([id, cid]) => window.pinFilmToCascadeAndRepaint(Number(id), cid), [filmId, agentB.id]);

  await expect.poll(async () => {
    const { data } = await admin.from("film_picks").select("pinned_to")
      .eq("user_id", user.id).eq("movie_id", String(filmId)).maybeSingle();
    return data && data.pinned_to;
  }, { timeout: 15_000 }).toEqual([agentB.id]);

  expect(await page.evaluate((id) => !!document.querySelector(`#groups [id="card-${id}"]`), filmId),
    "the pinned film's card must still be on screen, not removed, until the next stage switch").toBe(true);
});

test("AC6: a reconcile that changes something elsewhere never clears an already-loaded poster", async ({ page }) => {
  const email = testEmail("cas1236-ac6");
  const user = await createTestUser(email);
  await seedWideOpenAgent(user.id);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  const firstId = await page.evaluate(() => document.querySelector("#groups [id^='card-']").id.slice(5));
  // Force the lazy poster to resolve now rather than waiting on real scroll/IntersectionObserver timing.
  await page.evaluate((id) => {
    const el = document.querySelector(`#groups [id="card-${id}"] .poster`);
    if(el && el.dataset.lazybg){ el.style.backgroundImage = `url(${el.dataset.lazybg})`; delete el.dataset.lazybg; }
  }, firstId);
  const before = await page.evaluate((id) =>
    document.querySelector(`#groups [id="card-${id}"] .poster`).style.backgroundImage, firstId);
  expect(before, "setup must have actually loaded a poster").toContain("url(");

  // A verdict on a DIFFERENT film triggers render() while sitting on the same, unnavigated screen.
  const otherId = await page.evaluate((skipId) =>
    [...document.querySelectorAll("#groups [id^='card-']")]
      .map(el => el.id.slice(5)).find(x => x !== skipId), firstId);
  if(otherId) await page.evaluate((id) => window.setOpinion(Number(id), "liked"), otherId);

  const after = await page.evaluate((id) =>
    document.querySelector(`#groups [id="card-${id}"] .poster`)?.style.backgroundImage, firstId);
  expect(after, "an unrelated card's loaded poster must survive a repaint caused elsewhere").toBe(before);
});

// AC-LOAD: CAS-1231's own regression — a device must boot all the way to a filled Watch list (real cards,
// non-zero counts) rather than hanging on "Loading your account…" forever, even though nothing here forces
// the exact premature-render timing the production race depended on (see CAS-1231 comment 14954 and this
// ticket's own engine-level AC-LOAD test for the harness-reachable reproduction of that mechanism).
test("AC-LOAD: a signed-in account boots to Watch and shows its cards and non-zero stage counts", async ({ page }) => {
  const email = testEmail("cas1236-ac-load");
  const user = await createTestUser(email);
  await seedWideOpenAgent(user.id);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  const cardCount = await page.evaluate(() => document.querySelectorAll("#groups [id^='card-']").length);
  expect(cardCount, "the Watch list must actually fill with cards, not hang on the loading placeholder").toBeGreaterThan(0);

  const stageCountTotal = await page.evaluate(() =>
    [...document.querySelectorAll(".stagestop .stagecount")]
      .reduce((n, el) => n + (parseInt(el.textContent, 10) || 0), 0));
  expect(stageCountTotal, "at least one stage count must be non-zero — CAS-1231 showed every stage stuck at 0").toBeGreaterThan(0);
});

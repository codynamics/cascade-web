// CAS-1229: the Watch list used to re-pull every account table on every return to the tab (focus and
// visibilitychange both fire, plus a 3-minute heartbeat) and redraw the WHOLE list even when nothing had
// changed — a card's poster cleared and refetched, the list jumped, and the current stage's own count
// swung, all while the person just sat there. Drives the real app against the local Supabase stack, same
// convention as reconcile-on-return.spec.mjs.
import { test, expect } from "@playwright/test";
import {
  admin, createTestUser, seedCascades, testEmail,
  gotoIntegrityFresh, signInFromSplash, recordRestRequests,
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
  const email = testEmail("cas1229-ac1");
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
  const email = testEmail("cas1229-ac2");
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

test("AC5: pinning a film to an agent that doesn't list it on the current stage leaves its card in place", async ({ page }) => {
  const email = testEmail("cas1229-ac5");
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
  const email = testEmail("cas1229-ac6");
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

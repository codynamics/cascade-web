// CAS-1222: per-account view state (selected agent(s), per-tab my-services-only, tutorial seen, and
// friends) moves off localStorage and onto the account (user_prefs.view), written through
// merge_user_prefs_view (migration 0009) so two devices changing different fields at the same moment both
// land, rather than whichever push reaches the account second clobbering the first. Drives the real app
// against the local Supabase stack, same convention as server-first.spec.mjs/device-storage.spec.mjs.
// window.setActive/markTutorialSeen are driven directly as test-convenience chokepoints, the same style
// server-first.spec.mjs/device-storage.spec.mjs already use for window.setOpinion(...) — there is no
// dedicated UI control under test here, just the account round trip.
// CAS-1247: view.mineOnly is retired — window.toggleWatchMineOnly() is now a live, session-only flip that
// persists nothing on its own. AC1/AC4 below drive mineOnly's actual persisted path instead: saving the
// selected mood with mineOnly off (openMoodSheetFor/toggleMoodDraftMineOnly/saveMoodFromSheet), the same
// save a person tapping "Save mood" in the sheet triggers.
import { test, expect } from "@playwright/test";
import {
  admin, createTestUser, seedCascades, testEmail,
  gotoIntegrityFresh, signInFromSplash,
} from "./helpers.mjs";
import { settleListing } from "../e2e/helpers.mjs";

// CAS-1222's own retired keys — a device signed in before this build shipped still carries them; AC5 asks
// that the first boot of this build deletes every one.
const RETIRED_KEYS = ["cascade_active", "cascade_active_multi", "cascade_watch_occasion",
  "cascade_watch_mineonly", "cascade_seen_found", "cascade_first_found", "cascade_admit_drift",
  "cascade_tutorial_seen", "cascade_review_sessions", "cascade_review_asked_ver", "cascade_agent",
  "cascade_watchwins", "cascade_probe", "cascade_visits"];

async function waitForAccountLoads(page){
  await page.waitForFunction(() => {
    const cp = window.CascadePersistence;
    return cp && cp.userPrefsReady && cp.notifyPrefsReady && cp.filmWatchReady && cp.agentFilmsReady;
  }, { timeout: 30_000 });
}
async function viewRow(userId){
  const { data, error } = await admin.from("user_prefs").select("view").eq("user_id", userId).maybeSingle();
  if(error) throw new Error(`viewRow(${userId}) failed: ${error.message}`);
  return (data && data.view) || {};
}

test("AC1: A selects an agent and sets Streaming mine-only off; B reconciles and shows both", async ({ browser }) => {
  const email = testEmail("cas1222-ac1");
  const user = await createTestUser(email);
  const [, agentB] = await seedCascades(user.id, [{ name: "AC1 agent A" }, { name: "AC1 agent B" }]);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try{
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await gotoIntegrityFresh(pageA);
    await gotoIntegrityFresh(pageB);
    await Promise.all([signInFromSplash(pageA, email), signInFromSplash(pageB, email)]);
    await Promise.all([settleListing(pageA), settleListing(pageB)]);
    await Promise.all([waitForAccountLoads(pageA), waitForAccountLoads(pageB)]);

    await pageA.evaluate((id) => window.setActive(id), agentB.id);
    await pageA.evaluate(() => {
      window.setWatchTab("stream");
      window.openMoodSheetFor(watchMoodSel);
      window.toggleMoodDraftMineOnly();
      window.saveMoodFromSheet();
    });
    await pageA.evaluate(() => window.CascadeAccountStore.sendQueue());
    await expect.poll(() => pageA.evaluate(() => window.CascadeAccountStore.queue.length), { timeout: 15_000 }).toBe(0);

    await pageB.evaluate(() => window.CascadePersistence.reconcileOnReturn());
    await expect.poll(() => pageB.evaluate(() => activeId), { timeout: 15_000 }).toBe(agentB.id);
    const mineOnlyOnB = await pageB.evaluate(() => { window.setWatchTab("stream"); return watchMineOnlyOn(); });
    expect(mineOnlyOnB).toBe(false);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("AC2: A dismisses the tutorial; B, booted afterwards, does not show it", async ({ browser }) => {
  const email = testEmail("cas1222-ac2");
  const user = await createTestUser(email);
  await seedCascades(user.id, [{ name: "AC2 agent" }]);

  const ctxA = await browser.newContext();
  try{
    const pageA = await ctxA.newPage();
    await gotoIntegrityFresh(pageA);
    await signInFromSplash(pageA, email);
    await settleListing(pageA);
    await waitForAccountLoads(pageA);

    await pageA.evaluate(() => window.markTutorialSeen());
    await pageA.evaluate(() => window.CascadeAccountStore.sendQueue());
    await expect.poll(() => pageA.evaluate(() => window.CascadeAccountStore.queue.length), { timeout: 15_000 }).toBe(0);
  } finally {
    await ctxA.close();
  }

  const ctxB = await browser.newContext();
  try{
    const pageB = await ctxB.newPage();
    await gotoIntegrityFresh(pageB);
    await signInFromSplash(pageB, email);
    await settleListing(pageB);
    await waitForAccountLoads(pageB);

    const seenOnB = await pageB.evaluate(() => tutorialSeen());
    expect(seenOnB, "a fresh device signing into this account must already see the tutorial as seen").toBe(true);
  } finally {
    await ctxB.close();
  }
});

test("AC4: A changes the selected agent while B changes Streaming mine-only at the same moment — the server holds both", async ({ browser }) => {
  const email = testEmail("cas1222-ac4");
  const user = await createTestUser(email);
  const [, agentB] = await seedCascades(user.id, [{ name: "AC4 agent A" }, { name: "AC4 agent B" }]);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try{
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await gotoIntegrityFresh(pageA);
    await gotoIntegrityFresh(pageB);
    await Promise.all([signInFromSplash(pageA, email), signInFromSplash(pageB, email)]);
    await Promise.all([settleListing(pageA), settleListing(pageB)]);
    await Promise.all([waitForAccountLoads(pageA), waitForAccountLoads(pageB)]);

    await Promise.all([
      pageA.evaluate((id) => window.setActive(id), agentB.id),
      pageB.evaluate(() => {
        window.setWatchTab("stream");
        window.openMoodSheetFor(watchMoodSel);
        window.toggleMoodDraftMineOnly();
        window.saveMoodFromSheet();
      }),
    ]);
    await Promise.all([
      pageA.evaluate(() => window.CascadeAccountStore.sendQueue()),
      pageB.evaluate(() => window.CascadeAccountStore.sendQueue()),
    ]);
    await expect.poll(() => pageA.evaluate(() => window.CascadeAccountStore.queue.length), { timeout: 15_000 }).toBe(0);
    await expect.poll(() => pageB.evaluate(() => window.CascadeAccountStore.queue.length), { timeout: 15_000 }).toBe(0);

    await expect.poll(async () => {
      // The edited mood was already the selected one, so saving it pushes only "moods", never "mood" (C4) —
      // this fresh account never had any mood saved before this test, so "some saved mood has mineOnly off"
      // is an unambiguous signal of the save having landed, without depending on v.mood being set at all.
      const v = await viewRow(user.id);
      return v.active === agentB.id && Array.isArray(v.moods) && v.moods.some(m => m.mineOnly === false);
    }, { timeout: 15_000 }).toBe(true);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("AC5: localStorage pre-seeded with every CAS-1222 retired key is wiped on the next boot", async ({ page }) => {
  const email = testEmail("cas1222-ac5");
  const user = await createTestUser(email);
  await seedCascades(user.id, [{ name: "AC5 agent" }]);

  await gotoIntegrityFresh(page);
  await page.evaluate((keys) => {
    keys.forEach(k => { try{ localStorage.setItem(k, "1"); }catch(e){} });
  }, RETIRED_KEYS);

  // The doctoring above happened after this page's own boot already ran once — reload so the one-time
  // sweep (purgeNonAllowlistedCascadeKeys) gets a fresh boot to run against.
  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await signInFromSplash(page, email);
  await settleListing(page);

  const keys = await page.evaluate(() => Object.keys(localStorage));
  const stillPresent = keys.filter(k => RETIRED_KEYS.includes(k));
  expect(stillPresent, `every retired key must be gone after this boot; found: ${JSON.stringify(stillPresent)}`).toEqual([]);
});

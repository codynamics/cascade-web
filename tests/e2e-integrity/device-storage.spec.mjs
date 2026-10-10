// CAS-1221: the device holds the film catalogue, the sign-in session and unsent actions — nothing else.
// Every other kind of account data (agents, verdicts, Watch On, services, taste, settings...) is held in
// memory only and drawn from the server; app_template.html's DEVICE_KEY_ALLOWLIST is the single source of
// truth for every key still allowed on disk (tests/lint/device-key-allowlist.mjs is the static half of this
// same rule — AC2). These scenarios drive the real app against the local Supabase stack, same convention
// as account-integrity.spec.mjs/server-first.spec.mjs.
import { test, expect } from "@playwright/test";
import {
  admin, createTestUser, seedCascades, liveCascades, testEmail,
  gotoIntegrityFresh, signInFromSplash,
} from "./helpers.mjs";
import { settleListing, openAgentsScreenFromNav } from "../e2e/helpers.mjs";

const OBSERVATION_KEYS = ["cascade_cascades", "cascade_watched", "cascade_disliked", "cascade_blocked",
  "cascade_indifferent", "cascade_wow", "cascade_enjoyed", "cascade_notify", "cascade_watch_known",
  "cascade_notifyprefs", "cascade_prefs", "cascade_ux", "cascade_taste_base", "cascade_watch_prefs",
  "cascade_moving_seen", "cascade_occasions", "cascade_onb_answers"];

async function waitForAccountLoads(page){
  await page.waitForFunction(() => {
    const cp = window.CascadePersistence;
    return cp && cp.userPrefsReady && cp.notifyPrefsReady && cp.filmWatchReady && cp.agentFilmsReady;
  }, { timeout: 30_000 });
}

/** Every localStorage/sessionStorage key on the page right now, and which of them DEVICE_KEY_ALLOWLIST
 * does not cover (a prefix entry, like "cascade_ops@", matches by prefix; everything else is exact). */
async function diskKeysOutsideAllowlist(page){
  return page.evaluate(() => {
    const allowed = Object.keys(DEVICE_KEY_ALLOWLIST);
    const isPrefix = a => a.endsWith("@") || a.endsWith("-");
    const check = k => allowed.some(a => isPrefix(a) ? k.indexOf(a) === 0 : k === a);
    const all = [...Object.keys(localStorage), ...Object.keys(sessionStorage)];
    return all.filter(k => !check(k));
  });
}

test("AC1: sign in, edit an agent, mark a film Watched, switch a service, open Alerts, drain the queue — every disk key is allowlisted, no Observation key exists", async ({ page }) => {
  const email = testEmail("cas1221-ac1");
  const user = await createTestUser(email);
  const [agent] = await seedCascades(user.id, [{ name: "AC1 agent" }]);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  // Edit an agent through the real Agents-screen rename flow (CAS-934: closing the hub is what commits).
  await openAgentsScreenFromNav(page);
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await page.locator(`.agrow[data-id="${agent.id}"] .ag-edit`).click();
  await page.locator(".eapenc").click();
  await page.locator("#onbStepName").fill("AC1 agent (edited)");
  await page.locator("#onbStepInner .osback").click();
  await page.locator("#onbStepInner .osback").click();

  // Mark a film Watched, switch a service, same chokepoints every other integrity test in this suite drives.
  const filmId = await page.evaluate(() => MOVIES[0].tmdb_id);
  await page.evaluate((id) => window.setOpinion(id, "liked"), filmId);
  await page.evaluate(() => { prefs.sub.add("Stan"); savePrefs(); pushPrefsCols(["sub_services"]); });

  // Open Alerts (the Moving screen) — AC2's own "writes user_prefs at most once" chokepoint — then close it.
  await page.evaluate(() => window.openMovingScreen());
  await page.evaluate(() => window.closeMovingScreen());

  // Drain the queue: every acctOp above must actually reach (or finish trying to reach) the account before
  // this test inspects disk state, or a still-queued op's own persisted entry would be mistaken for a leak.
  await page.evaluate(() => window.CascadeAccountStore.sendQueue());
  await expect.poll(
    () => page.evaluate(() => window.CascadeAccountStore.queue.length),
    { timeout: 15_000 },
  ).toBe(0);

  const stray = await diskKeysOutsideAllowlist(page);
  expect(stray, `every on-disk key must be in DEVICE_KEY_ALLOWLIST; found: ${JSON.stringify(stray)}`).toEqual([]);

  const keys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
  const leaked = keys.filter(k => OBSERVATION_KEYS.includes(k));
  expect(leaked, `none of the retired account-data keys may exist; found: ${JSON.stringify(leaked)}`).toEqual([]);
});

test("AC3: localStorage pre-seeded with every Observation key is wiped on the next boot; the server is unchanged and the screen shows the server's values", async ({ page }) => {
  const email = testEmail("cas1221-ac3");
  const user = await createTestUser(email);
  const [agent] = await seedCascades(user.id, [{ name: "AC3 server agent" }]);

  await gotoIntegrityFresh(page);
  await page.evaluate((keys) => {
    const doctoredCascades = [{ id: "doctored-id", name: "DOCTORED STALE AGENT" }];
    keys.forEach(k => {
      try{ localStorage.setItem(k, k === "cascade_cascades" ? JSON.stringify(doctoredCascades) : JSON.stringify({ doctored: true })); }
      catch(e){}
    });
  }, OBSERVATION_KEYS);

  // The doctoring above happened AFTER this page's own boot already ran once — reload so the one-time
  // purge (app_template.html, right after purgeLegacyAccountKeys) gets a fresh boot to run against, the
  // same "first boot of this build" moment AC3 describes.
  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await signInFromSplash(page, email);
  await settleListing(page);

  const keys = await page.evaluate(() => Object.keys(localStorage));
  const stillPresent = keys.filter(k => OBSERVATION_KEYS.includes(k));
  expect(stillPresent, `every doctored Observation key must be gone after this boot; found: ${JSON.stringify(stillPresent)}`)
    .toEqual([]);

  const onScreen = await page.evaluate(() => cascades.map(c => ({ id: c.id, name: c.name })));
  expect(onScreen.map(c => c.name)).toEqual(["AC3 server agent"]);
  expect(onScreen.some(c => c.name === "DOCTORED STALE AGENT"), "the doctored agent must never reach the screen").toBe(false);

  const live = await liveCascades(user.id);
  expect(live.map(r => r.id)).toEqual([agent.id]);
});

test("AC4: with /rest/v1/ unreachable at cold start, no agent/verdict/setting from the device is shown — only the loading/cannot-connect state", async ({ page }) => {
  const email = testEmail("cas1221-ac4");
  const user = await createTestUser(email);
  await seedCascades(user.id, [{ name: "AC4 agent" }]);

  // A clean boot first, so this device is a genuine returning-signed-in device (cascade_had_account=1) —
  // the case AC4 actually targets, not a guest's first-ever load.
  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  // Now every /rest/v1/ request fails outright, and the page reloads cold.
  await page.route("**/rest/v1/**", route => route.abort("failed"));
  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.waitForTimeout(1000);

  const state = await page.evaluate(() => ({
    groups: document.querySelectorAll("#groups .group").length,
    loading: !!document.querySelector("#groups .acctloading"),
    cascadesLen: cascades.length,
  }));
  expect(state.cascadesLen, "no agent from the device may be held in memory while the server is unreachable").toBe(0);
  expect(state.groups, "no group — and so no agent, verdict or setting — may render").toBe(0);
  expect(state.loading, "the loading (or cannot-connect) state must be showing instead").toBe(true);
});

test("AC5: reloading with a slow network, the agents shown after load equal the server's rows", async ({ page }) => {
  const email = testEmail("cas1221-ac5");
  const user = await createTestUser(email);
  const seeded = await seedCascades(user.id, [{ name: "AC5 agent A" }, { name: "AC5 agent B" }]);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  await page.route("**/rest/v1/**", async route => {
    await new Promise(r => setTimeout(r, 1500));
    await route.continue();
  });
  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await settleListing(page);
  await waitForAccountLoads(page);

  const onScreenIds = await page.evaluate(() => cascades.map(c => c.id).sort());
  expect(onScreenIds).toEqual(seeded.map(r => r.id).sort());
});

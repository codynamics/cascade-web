// CAS-1218: server-first — a load, a render, a recompute, a timer or a return to the app must never write
// account data; only the person's own explicit change (a Where & when switch, opening Alerts) may. Drives
// the real app against the local Supabase stack (same convention as account-integrity.spec.mjs) and asserts
// on the REAL network traffic recorded by recordRestRequests, not on app-reported state — a regression that
// only breaks the write count while nothing shows on screen is exactly what this suite exists to catch.
import { test, expect } from "@playwright/test";
import {
  admin, createTestUser, seedCascades, testEmail, testRefCode, countNotifyPrefsRows,
  seedUserPrefs, seedNotifyPrefs, seedAgentFilm, liveAgentFilm, recordRestRequests, restWrites,
  gotoIntegrityFresh, signInFromSplash,
} from "./helpers.mjs";
import { settleListing, openWhereWhenScreen } from "../e2e/helpers.mjs";

const NEVER_WRITE_TABLES = ["cascades", "user_prefs", "notify_prefs", "user_films", "film_watch", "film_picks"];

async function waitForAccountLoads(page){
  await page.waitForFunction(() => {
    const cp = window.CascadePersistence;
    return cp && cp.userPrefsReady && cp.notifyPrefsReady && cp.filmWatchReady && cp.agentFilmsReady;
  }, { timeout: 30_000 });
}

test("AC1: a clean load, five reconciles and opening Watch/Agents/Find/Settings with nothing changed write to nothing", async ({ page }) => {
  const email = testEmail("cas1218-ac1");
  const user = await createTestUser(email);
  await seedCascades(user.id, [{ name: "AC1 agent A" }, { name: "AC1 agent B" }, { name: "AC1 agent C" }]);
  await seedUserPrefs(user.id, {
    ref_code: testRefCode("CAS1218AC1"),
    watch_windows: { upcoming: { list: true }, in_cinema: { list: true }, rent: { list: true }, stream: { list: true } },
  });
  await seedNotifyPrefs(user.id, { in_app: true, email_on: true, email_address: email });

  await gotoIntegrityFresh(page);
  const requests = recordRestRequests(page);
  await signInFromSplash(page, email);
  await settleListing(page);   // Watch — the default listing — already rendered by this point
  await waitForAccountLoads(page);

  for(let i = 0; i < 5; i++) await page.evaluate(() => window.CascadePersistence.reconcileOnReturn());

  await page.evaluate(() => window.openAgentsScreen());
  await page.evaluate(() => window.closeAgentsScreen());
  await page.evaluate(() => window.openFindScreen());
  await page.evaluate(() => window.closeFindScreen());
  await page.evaluate(() => window.openSettings());
  await page.evaluate(() => window.closeSettings());
  await page.waitForTimeout(300);

  for(const table of NEVER_WRITE_TABLES){
    const writes = restWrites(requests, table);
    expect(writes, `${table}: ${JSON.stringify(writes)}`).toEqual([]);
  }
});

test("AC2: opening Alerts writes user_prefs at most once; a poll with Alerts still open and nothing new writes nothing further", async ({ page }) => {
  const email = testEmail("cas1218-ac2");
  const user = await createTestUser(email);
  await seedCascades(user.id, [{ name: "AC2 agent" }]);

  await gotoIntegrityFresh(page);
  const requests = recordRestRequests(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  await page.evaluate(() => window.openMovingScreen());
  await page.waitForTimeout(300);
  const afterOpen = restWrites(requests, "user_prefs").length;
  expect(afterOpen, "opening Alerts must write user_prefs at most once").toBeLessThanOrEqual(1);

  for(let i = 0; i < 5; i++) await page.evaluate(() => window.CascadePersistence.reconcileOnReturn());
  await page.waitForTimeout(300);
  const afterPolls = restWrites(requests, "user_prefs").length;
  expect(afterPolls, "a poll with Alerts still open and no new alert rows must write nothing further").toBe(afterOpen);
});

test("AC3/AC4: a seeded agent_films admission is never overwritten, and no write reaches agent_films before this session's own load returns", async ({ page }) => {
  const email = testEmail("cas1218-ac34");
  const user = await createTestUser(email);
  const [agent] = await seedCascades(user.id, [{ name: "AC3/AC4 agent" }]);

  await gotoIntegrityFresh(page);
  const filmId = await page.evaluate(() => String(MOVIES[0].tmdb_id));
  const seedRow = { admitted_at: "2026-01-01T00:00:00Z", admission_score: 12, admission_status: "stream",
    agent_sig: "cas1218-seed-sig" };
  await seedAgentFilm(user.id, agent.id, filmId, seedRow);

  const requests = recordRestRequests(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  // AC3: three explicit extra render() passes after boot must never move the seeded row.
  await page.evaluate(() => { render(); render(); render(); });
  await page.waitForTimeout(300);

  const agentFilmReqs = requests.filter(r => r.table === "agent_films");
  const firstGet = agentFilmReqs.find(r => r.method === "GET");
  expect(firstGet, "sanity: this session must have fetched agent_films at least once").toBeTruthy();
  const earlyWrites = agentFilmReqs.filter(r => r.method !== "GET" && r.startedAt < firstGet.finishedAt);
  expect(earlyWrites, "no non-GET agent_films request may start before the session's own GET has completed")
    .toEqual([]);

  const row = await liveAgentFilm(agent.id, filmId);
  expect(row, "the seeded row must still exist").toBeTruthy();
  expect(row.admission_score).toBe(12);
  expect(row.admission_status).toBe("stream");
  expect(row.agent_sig).toBe("cas1218-seed-sig");
  expect(new Date(row.admitted_at).toISOString()).toBe(new Date(seedRow.admitted_at).toISOString());
});

test("AC5: two contexts booting at once on a missing notify_prefs row leave exactly one row, neither overwriting the other", async ({ browser }) => {
  const email = testEmail("cas1218-ac5");
  const user = await createTestUser(email);
  await seedCascades(user.id, [{ name: "AC5 agent" }]);
  // Deliberately no notify_prefs row seeded — "nobody has bootstrapped one yet" is the whole scenario.

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

    await expect.poll(() => countNotifyPrefsRows(user.id), { timeout: 15_000 }).toBe(1);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("AC6: changing one Where & when switch still writes exactly one user_prefs update and one cascades update for the agent it moves", async ({ page }) => {
  const email = testEmail("cas1218-ac6");
  const user = await createTestUser(email);
  await seedCascades(user.id, [{ name: "AC6 agent" }]);

  await gotoIntegrityFresh(page);
  const requests = recordRestRequests(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  await openWhereWhenScreen(page);
  await page.locator(".wwlane", { hasText: "Standard Rent" }).locator(".agwt").click();
  await page.waitForTimeout(500);

  expect(restWrites(requests, "user_prefs").length, "exactly one user_prefs write for the switch itself").toBe(1);
  expect(restWrites(requests, "cascades").length,
    "exactly one cascades update, for the one agent whose windows actually changed").toBe(1);
});

// CAS-1219: reconcileOnReturn() used to re-pull only cascades, user_prefs and the alert ledger — verdicts
// (user_films), Watch On and pins (film_watch/film_picks), notify prefs, the admission ledger (agent_films),
// invites and friends were never re-read after boot, so a device left open across a change made on another
// device could show a different account for a whole session (the 7 Oct iPhone-vs-PC report this ticket
// opens with). Drives the real app against the local Supabase stack, same convention as
// account-integrity.spec.mjs/server-first.spec.mjs.
import { test, expect } from "@playwright/test";
import {
  admin, createTestUser, seedCascades, seedUserPrefs, seedNotifyPrefs, testEmail, testRefCode,
  recordRestRequests, restWrites, gotoIntegrityFresh, signInFromSplash,
} from "./helpers.mjs";
import { settleListing } from "../e2e/helpers.mjs";

async function waitForAccountLoads(page){
  await page.waitForFunction(() => {
    const cp = window.CascadePersistence;
    return cp && cp.userPrefsReady && cp.notifyPrefsReady && cp.filmWatchReady && cp.agentFilmsReady;
  }, { timeout: 30_000 });
}

test("AC1: a verdict, Watch On, a pin, the email switch, an occasion rename/delete and a friend add on A all arrive on B via reconcileOnReturn(), which sends zero non-GET requests", async ({ browser }) => {
  const email = testEmail("cas1219-ac1");
  const user = await createTestUser(email);
  const [agent] = await seedCascades(user.id, [{ name: "AC1 agent" }]);
  await seedUserPrefs(user.id, {
    occasions: [{ id: "occ1", name: "Original" }, { id: "occ2", name: "To delete" }],
  });
  await seedNotifyPrefs(user.id, { in_app: true, email_on: false, email_address: email });

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try{
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await gotoIntegrityFresh(pageA);
    await signInFromSplash(pageA, email);
    await settleListing(pageA);
    await waitForAccountLoads(pageA);

    await gotoIntegrityFresh(pageB);
    await signInFromSplash(pageB, email);
    await settleListing(pageB);
    await waitForAccountLoads(pageB);

    const filmId = await pageA.evaluate(() => MOVIES[0].tmdb_id);
    const pinFilmId = await pageA.evaluate(() => MOVIES[1].tmdb_id);

    // 1. a film marked Watched
    await pageA.evaluate((id) => window.setOpinion(id, "liked"), filmId);
    await expect.poll(async () => {
      const { data } = await admin.from("user_films").select("status")
        .eq("user_id", user.id).eq("movie_id", String(filmId)).maybeSingle();
      return data && data.status;
    }, { timeout: 15_000 }).toBe("liked");

    // 2. a manual Watch On choice
    await pageA.evaluate((id) => {
      const e = entryFor(id);
      e.wins = e.wins || {}; e.winsSource = e.winsSource || {};
      e.wins.stream = true; e.winsSource.stream = "manual";
      saveNotify();
      window.CascadePersistence.pushFilmWatch(id);
    }, filmId);
    await expect.poll(async () => {
      const { data } = await admin.from("film_watch").select("windows")
        .eq("user_id", user.id).eq("movie_id", String(filmId)).maybeSingle();
      return data && data.windows;
    }, { timeout: 15_000 }).toEqual(["stream"]);

    // 3. a pin
    await pageA.evaluate(([id, cid]) => {
      const e = entryFor(id);
      e.pinnedTo = [cid];
      window.CascadePersistence.pushFilmPick(id);
    }, [pinFilmId, agent.id]);
    await expect.poll(async () => {
      const { data } = await admin.from("film_picks").select("pinned_to")
        .eq("user_id", user.id).eq("movie_id", String(pinFilmId)).maybeSingle();
      return data && data.pinned_to;
    }, { timeout: 15_000 }).toEqual([agent.id]);

    // 4. the email alerts switch
    await pageA.evaluate(() => { notifyPrefs.emailOn = true; saveNotifyPrefs(); });
    await expect.poll(async () => {
      const { data } = await admin.from("notify_prefs").select("email_on").eq("user_id", user.id).maybeSingle();
      return data && data.email_on;
    }, { timeout: 15_000 }).toBe(true);

    // 5. an occasion renamed
    await pageA.evaluate(() => { renameOccasion("occ1", "Renamed"); });
    await expect.poll(async () => {
      const { data } = await admin.from("user_prefs").select("occasions").eq("user_id", user.id).maybeSingle();
      const row = (data && data.occasions || []).find(o => o.id === "occ1");
      return row && row.name;
    }, { timeout: 15_000 }).toBe("Renamed");

    // 6. an occasion deleted
    await pageA.evaluate(() => { deleteOccasion("occ2"); });
    await expect.poll(async () => {
      const { data } = await admin.from("user_prefs").select("occasions").eq("user_id", user.id).maybeSingle();
      return (data && data.occasions || []).some(o => o.id === "occ2");
    }, { timeout: 15_000 }).toBe(false);

    // 7. a friend added
    const { error: friendErr } = await admin.from("friends")
      .insert({ owner_id: user.id, name: "New Friend", email: "cas1219-friend@integrity.test" });
    if(friendErr) throw new Error(`seeding friend failed: ${friendErr.message}`);

    // B, already open and idle, reconciles once — every change above must arrive, and B must send
    // nothing but GETs to do it.
    const requestsB = recordRestRequests(pageB);
    await pageB.evaluate(() => window.CascadePersistence.reconcileOnReturn());

    await expect.poll(() => pageB.evaluate((id) => opinionOf(id), filmId), { timeout: 15_000 }).toBe("liked");
    await expect.poll(() => pageB.evaluate((id) => {
      const e = notify[id];
      return e && e.wins ? Object.keys(e.wins).filter(k => e.wins[k]).sort() : [];
    }, filmId), { timeout: 15_000 }).toEqual(["stream"]);
    await expect.poll(() => pageB.evaluate((id) => (notify[id] && notify[id].pinnedTo) || [], pinFilmId),
      { timeout: 15_000 }).toEqual([agent.id]);
    await expect.poll(() => pageB.evaluate(() => notifyPrefs.emailOn), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => pageB.evaluate(() => {
      const o = occasionReg.find(x => x.id === "occ1");
      return o && o.name;
    }), { timeout: 15_000 }).toBe("Renamed");
    await expect.poll(() => pageB.evaluate(() => occasionReg.some(o => o.id === "occ2")),
      { timeout: 15_000 }).toBe(false);
    await expect.poll(() => pageB.evaluate(() => friends.some(f => f.name === "New Friend")),
      { timeout: 15_000 }).toBe(true);

    expect(restWrites(requestsB), `B's own reconcile must send zero non-GET requests: ${JSON.stringify(restWrites(requestsB))}`)
      .toEqual([]);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("AC2: an emptied taste object on the server is adopted by reconcileOnReturn(), not read as unanswered", async ({ page }) => {
  const email = testEmail("cas1219-ac2");
  const user = await createTestUser(email);
  await seedCascades(user.id, [{ name: "AC2 agent" }]);
  await seedUserPrefs(user.id, { ref_code: testRefCode("CAS1219AC2"), taste: { langs: ["fr"] } });

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  await expect.poll(() => page.evaluate(() => tasteBase.langs), { timeout: 15_000 }).toEqual(["fr"]);
  const defaultLangs = await page.evaluate(() => baseDefaults().langs);

  const { error } = await admin.from("user_prefs").update({ taste: {} }).eq("user_id", user.id);
  if(error) throw new Error(`clearing taste failed: ${error.message}`);

  await page.evaluate(() => window.CascadePersistence.reconcileOnReturn());

  await expect.poll(() => page.evaluate(() => tasteBase.langs), { timeout: 15_000 }).toEqual(defaultLangs);
});

test("AC3: an unsent user_films write survives reconcileOnReturn() on screen, and sends once the network returns", async ({ page }) => {
  const email = testEmail("cas1219-ac3");
  const user = await createTestUser(email);
  await seedCascades(user.id, [{ name: "AC3 agent" }]);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);

  const filmId = await page.evaluate(() => MOVIES[0].tmdb_id);
  await page.evaluate(() => { window.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [50, 50, 50]; });
  await page.route("**/rest/v1/user_films*", route => route.abort());

  await page.evaluate((id) => window.setOpinion(id, "liked"), filmId);
  await expect.poll(
    () => page.evaluate(() => window.CascadeAccountStore.queue.some(op => op.table === "user_films")),
    { timeout: 10_000 },
  ).toBe(true);

  await page.evaluate(() => window.CascadePersistence.reconcileOnReturn());
  await page.waitForTimeout(500);
  expect(await page.evaluate((id) => opinionOf(id), filmId),
    "reconcileOnReturn() must not undo this device's own unsent verdict").toBe("liked");
  expect(await page.evaluate(() => window.CascadeAccountStore.queue.some(op => op.table === "user_films")),
    "the write must still be queued, unsent").toBe(true);

  await page.unroute("**/rest/v1/user_films*");
  await page.evaluate(() => window.CascadePersistence.syncNow());
  await expect.poll(async () => {
    const { data } = await admin.from("user_films").select("status")
      .eq("user_id", user.id).eq("movie_id", String(filmId)).maybeSingle();
    return data && data.status;
  }, { timeout: 15_000 }).toBe("liked");
});

test("AC4/AC5: a delayed boot shows the loading state (never this device's stale cache) until the fan-out settles, writes nothing early, and ends on the server's own agent and score", async ({ page }) => {
  const email = testEmail("cas1219-ac45");
  const user = await createTestUser(email);
  const [agent] = await seedCascades(user.id, [{ name: "AC45 Distinct Agent",
    criteria: { watchMarkers: { stream: 70 }, status: ["included_streaming"], kind: "stream" } }]);
  await seedUserPrefs(user.id, { ref_code: testRefCode("CAS1219AC45") });
  await seedNotifyPrefs(user.id, { in_app: true, email_on: true, email_address: email });

  // A clean boot first, so the account load genuinely ran once before this device "reboots".
  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);
  await waitForAccountLoads(page);
  expect(await page.evaluate(() => cascades[0].watchMarkers.stream)).toBe(70);

  // CAS-1221: there is no on-device mirror left to doctor (cascade_cascades is never written) — a reload
  // starts this device's own `cascades` at [] unconditionally, which is the thing AC4/AC5 actually need to
  // prove: NOTHING, stale or otherwise, may paint before the fan-out settles.

  // AC5: every /rest/v1/ response delayed 3s at boot.
  await page.route("**/rest/v1/**", async route => {
    await new Promise(r => setTimeout(r, 3000));
    await route.continue();
  });
  const requests = recordRestRequests(page);
  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  // Still well inside the 3s delay: no group (so no film count), the loading state instead.
  await page.waitForTimeout(1200);
  const duringLoad = await page.evaluate(() => ({
    groups: document.querySelectorAll("#groups .group").length,
    loading: !!document.querySelector("#groups .acctloading"),
  }));
  expect(duringLoad.groups, "no group — and so no film count — may render before the fan-out settles").toBe(0);
  expect(duringLoad.loading, "the loading state must be showing instead").toBe(true);
  expect(restWrites(requests), "no non-GET request may start before the fan-out has settled").toEqual([]);

  await settleListing(page);
  await waitForAccountLoads(page);

  const after = await page.evaluate(() => ({ name: cascades[0].name, stream: cascades[0].watchMarkers.stream }));
  expect(after.name).toBe("AC45 Distinct Agent");
  expect(after.stream).toBe(70);

  const live = await admin.from("cascades").select("criteria").eq("id", agent.id).single();
  expect(live.data.criteria.watchMarkers.stream, "the server row must be unchanged by the doctored local cache")
    .toBe(70);
  expect(restWrites(requests), "still nothing non-GET once the fan-out has fully settled").toEqual([]);
});

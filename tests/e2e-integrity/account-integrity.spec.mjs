// CAS-1093: account-integrity suite — the one part of CI that exercises a REAL Supabase (locally, via
// Supabase CLI + Docker; see scripts/test-integrity.mjs and supabase/config.toml). Every other job in
// qa.yml runs the app with no Supabase at all, which is how a sync pass that deleted every agent on
// sign-in (CAS-1090, 2026-09-30) reached production undetected. Each scenario here asserts on database
// rows, not only the screen — a regression that only breaks the screen while quietly leaving the account
// intact is not the class of bug this suite exists to catch.
//
// What must pass now (decision, 2026-10-01 build chat, scoping CAS-1093 AC2): S2, S3, plus S1/S6/S10 added
// by CAS-1099, plus S4/S5 un-fixme'd by CAS-1109 below (agents now move onto the account store). Every
// other scenario stays `test.fixme()`, not deleted — including S7-S9, which have each passed in CI before
// but are fixme'd anyway because their own features/tickets aren't done yet. Later tickets in the
// server-first account-store rework
// (https://codynamics.atlassian.net/wiki/spaces/Cascade/pages/64815105) un-fixme them as the features they
// depend on land, and add scenarios of their own for their own tables.
//   - S7, S8, S9: added by later tickets (CAS-1096, CAS-1095) — theirs to un-fixme.
// S13 (CAS-1102, migration 0003_delete_guard.sql) asserts on that migration's own trigger directly via a
// signed-in supabase-js client, not the browser — see its own comment below.
// CAS-1099: S1 and S6 are un-fixme'd below — onboarding now commits through complete_membership(), the
// migration 0002 RPC. S10 (abandon before membership) is new. AC6's own scenario number (originally "S14")
// is stale — CAS-1137 claimed S14 for an unrelated usage_events fix in the meantime — S6 below proves the
// same email_has_account gate AC6 describes as part of its own "agents intact" story, so no separate
// scenario was added only to claim a fresh number.
// CAS-1100: S11 (a real sign-out leaves no account-data key in localStorage) and S12 (sign out of A, sign in
// as B on the same context — nothing of A visible, A's server rows unchanged) are new, and must pass.
import { test, expect } from "@playwright/test";
import {
  admin, createTestUser, seedCascades, liveCascades, liveNotifyPrefs, testEmail,
  gotoIntegrityFresh, signInFromSplash, signOutFromAccount, signInDirect, fetchOtp, emailHasAccount,
} from "./helpers.mjs";
import { settleListing, finishFlow, walkToServices, openAgentsScreenFromNav } from "../e2e/helpers.mjs";

function idsOf(rows){ return rows.map(r => r.id).slice().sort(); }

test("S2: sign in on a clean browser context shows the account's agents, deletes none", async ({ page }) => {
  const email = testEmail("s2");
  const user = await createTestUser(email);
  const seeded = await seedCascades(user.id, [
    { name: "Loved & Acclaimed" },
    { name: "Date Night" },
  ]);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);

  const onScreen = await page.evaluate(() => cascades.map(c => ({ id: c.id, name: c.name })));
  expect(idsOf(onScreen)).toEqual(idsOf(seeded));

  const live = await liveCascades(user.id);
  expect(idsOf(live), "sign-in on a clean context must delete nothing").toEqual(idsOf(seeded));
});

test("S3: sign out then sign back in on the same context deletes none (the 2026-09-30 incident)", async ({ page }) => {
  const email = testEmail("s3");
  const user = await createTestUser(email);
  const seeded = await seedCascades(user.id, [
    { name: "Everyday Favourites" },
    { name: "Nominees & Awards" },
  ]);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);

  await signOutFromAccount(page);
  await signInFromSplash(page, email);
  await settleListing(page);

  const onScreen = await page.evaluate(() => cascades.map(c => ({ id: c.id, name: c.name })));
  expect(idsOf(onScreen)).toEqual(idsOf(seeded));

  const live = await liveCascades(user.id);
  expect(idsOf(live), "the exact 2026-09-30 incident shape: a sign-out/sign-in cycle must delete nothing")
    .toEqual(idsOf(seeded));
});

// CAS-1100: a real sign-out wipes every key that mirrors account content or account sync state outright
// (wipeAccountLocalState, via the cascade-auth-change listener's signOutReset) — no leftover cache for a
// future sign-in, this device's own or anyone else's, to find or inherit.
const ACCOUNT_DATA_KEY_NAMES = ["cascade_cascades", "cascade_watched", "cascade_disliked", "cascade_blocked",
  "cascade_indifferent", "cascade_wow", "cascade_enjoyed", "cascade_notify", "cascade_watch_known",
  "cascade_notifyprefs", "cascade_prefs", "cascade_ux", "cascade_taste_base", "cascade_watch_prefs",
  "cascade_moving_seen", "cascade_occasions", "cascade_onb_answers", "cascade_tutorial_seen",
  "cascade_review_sessions", "cascade_review_asked_ver"];

test("S11: sign out leaves no account-data key in localStorage", async ({ page }) => {
  const email = testEmail("s11");
  const user = await createTestUser(email);
  await seedCascades(user.id, [{ name: "S11 agent" }]);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);

  await signOutFromAccount(page);

  const keys = await page.evaluate(() => Object.keys(localStorage));
  const accountDataKeys = keys.filter(k => k.indexOf("cascade_ops@")===0 || ACCOUNT_DATA_KEY_NAMES.includes(k));
  expect(accountDataKeys, `no account-data key may survive a sign-out; localStorage held: ${JSON.stringify(keys)}`)
    .toEqual([]);
});

test("S12: sign out of A and sign in as B on the same context shows nothing of A, and A's server rows are unchanged", async ({ page }) => {
  const emailA = testEmail("s12a");
  const userA = await createTestUser(emailA);
  const seededA = await seedCascades(userA.id, [{ name: "A agent" }]);

  const emailB = testEmail("s12b");
  const userB = await createTestUser(emailB);
  const seededB = await seedCascades(userB.id, [{ name: "B agent" }]);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, emailA);
  await settleListing(page);

  await signOutFromAccount(page);
  await signInFromSplash(page, emailB);
  await settleListing(page);

  const onScreen = await page.evaluate(() => cascades.map(c => ({ id: c.id, name: c.name })));
  expect(idsOf(onScreen)).toEqual(idsOf(seededB));
  expect(onScreen.some(c => c.name === "A agent"), "nothing of A may be visible after signing in as B").toBe(false);

  const liveA = await liveCascades(userA.id);
  expect(idsOf(liveA), "A's server rows must be unchanged by B signing in on the same device")
    .toEqual(idsOf(seededA));
});

test("S4 (first half): an edit on context A reaches context B on reload", async ({ browser }) => {
  const email = testEmail("s4");
  const user = await createTestUser(email);
  const [seededAgent] = await seedCascades(user.id, [{ name: "Blockbusters" }]);
  const newName = "Blockbusters (edited)";

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try{
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    // CAS-1132: this job has never captured browser console/page errors — the only evidence of this
    // test's 15s timeout CI has ever produced is the bare "expected X, received Y" line. Forwarded here so
    // a run that still fails after this ticket at least prints whatever syncToAccount's own
    // console.warn("Cascade upsert", error) (or any uncaught exception) actually says, instead of nothing.
    pageA.on("console", msg => console.log(`[S4 pageA console.${msg.type()}] ${msg.text()}`));
    pageA.on("pageerror", err => console.log(`[S4 pageA pageerror] ${err}`));

    await gotoIntegrityFresh(pageA);
    await signInFromSplash(pageA, email);
    await settleListing(pageA);

    await gotoIntegrityFresh(pageB);
    await signInFromSplash(pageB, email);
    await settleListing(pageB);

    // Rename through the real Agents-screen edit flow (Edit → the hub's rename pencil → the name step),
    // then back out twice — closing the hub is what commits (briefClose → briefCommit → commitDraft →
    // saveCascades()), there is no separate Save button (CAS-934).
    await openAgentsScreenFromNav(pageA);
    await expect(pageA.locator("#agentsScreen")).toHaveClass(/open/);
    await pageA.locator(`.agrow[data-id="${seededAgent.id}"] .ag-edit`).click();
    await pageA.locator(".eapenc").click();
    await pageA.locator("#onbStepName").fill(newName);
    await pageA.locator("#onbStepInner .osback").click();
    await pageA.locator("#onbStepInner .osback").click();

    // CAS-1132: bisect "the UI never committed the rename locally" from "the commit landed but the push to
    // the server failed/never fired" — the two candidate causes the ticket itself names — before ever
    // asking the (real) network. If this reads newName, the bug is sync-side; if it still reads the old
    // name, the bug is in the briefClose/briefCommit/commitDraft chain above, never reaching the account at all.
    await expect.poll(
      () => pageA.evaluate((id) => { const c = cascades.find(x => x.id === id); return c && c.name; }, seededAgent.id),
      { timeout: 5_000 },
    ).toBe(newName);

    // CAS-1109: saveCascades() pushes through acctOp immediately now, no debounce to wait out — this just
    // makes sure the queue is drained rather than racing the network.
    await pageA.evaluate(() => window.CascadePersistence.syncNow());

    await expect.poll(async () => {
      const rows = await liveCascades(user.id);
      const row = rows.find(r => r.id === seededAgent.id);
      return row && row.name;
    }, { timeout: 15_000 }).toBe(newName);

    await pageB.reload();
    await pageB.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
    await settleListing(pageB);
    // CAS-1132: expect.poll's callback is re-invoked with no arguments — the earlier `(id) => ...` here
    // always ran with id===undefined, so this always read cascades.find(x => x.id === undefined) (undefined),
    // never seededAgent.id, however long it polled. Captured via closure instead, like every other poll in
    // this file (see S7's identical fix, 25503c7).
    await expect.poll(
      () => pageB.evaluate((agentId) => {
        const c = cascades.find(x => x.id === agentId);
        return c && c.name;
      }, seededAgent.id),
      { timeout: 15_000 },
    ).toBe(newName);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("S1: a new member's onboarded roster exists on the server", async ({ page }) => {
  // Walk real onboarding (splash → flow → membScreen → sign-up) to a brand-new account and assert its
  // roster exists in `cascades` server-side, through the real complete_membership() RPC — not a direct
  // insert this suite would otherwise be blind to.
  // CAS-1099 (requeue): this is the first scenario in this suite to drive a browser-side client.rpc() call
  // against the local stack — forwarded the same way CAS-1132's S4 fix (25503c7) did, since a prior run of
  // this exact test failed on a bare `locator.click` timeout with no other evidence in the CI log.
  page.on("console", msg => console.log(`[S1 console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", err => console.log(`[S1 pageerror] ${err}`));
  const email = testEmail("s1");

  await gotoIntegrityFresh(page);
  await page.locator("#splashCta").click();
  await walkToServices(page, "cinema");
  await finishFlow(page);

  await page.locator("#membEmail").fill(email);
  await page.locator(".membcta").click();
  // CAS-1169: the code is confirmed on #membScreen itself (State B), never on #authModal.
  await expect(page.locator("#membCode")).toBeVisible({ timeout: 30_000 });
  const code = await fetchOtp(email);
  await page.locator("#membCode").fill(code);
  await page.locator(".membcta").click();
  await expect(page.locator("#membScreen.open")).toBeHidden({ timeout: 30_000 });
  await settleListing(page);

  const userId = await page.evaluate(() => window.CascadeAuth.user.id);
  const onScreenIds = await page.evaluate(() => cascades.map(c => c.id).sort());
  expect(onScreenIds.length, "onboarding must have committed at least one agent").toBeGreaterThan(0);

  const live = await liveCascades(userId);
  expect(idsOf(live)).toEqual(onScreenIds);
});

test("S4 (second half): editing the same agent on both contexts gets a conflict toast, no data lost", async ({ page }) => {
  // Same two-context setup as S4's first half, but both A and B edit the SAME seeded agent's name before
  // either syncs; the second write to land must surface a conflict toast and neither account nor screen
  // may end up short an agent. Fixme'd because conflict detection isn't implemented until agents move onto
  // the account store (CAS-1094+ — the operation queue this class of check depends on).
  test.fixme(true, "until agents move onto the account store");
});

test("S5: deleting one agent on A leaves the others intact on B", async ({ page }) => {
  // Seed 2+ agents, delete one via context A's real delete flow (deleteAgentAsk, a confirm() dialog), then
  // reload context B and assert exactly the deleted one is gone server-side and on B's screen — the others
  // untouched. Fixme'd for the same account-store dependency as S4's conflict half.
  test.fixme(true, "until agents move onto the account store");
});

test("S6: onboarding into a previously-held account by email keeps that account's agents intact", async ({ page }) => {
  // A fresh context walks onboarding, building its own draft roster, then types an email that already has
  // an account — X's existing server-side agents must survive un-touched, not be overwritten by the fresh
  // onboarding roster. AC6's own gate (email_has_account, no code sent) is what actually prevents the
  // overwrite here — this is also the scenario that proves AC6 (see the header comment on S14's stale number).
  // CAS-1099 (requeue): forwarded for the same reason as S1 above — a prior run failed with no browser-side
  // evidence in the CI log.
  page.on("console", msg => console.log(`[S6 console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", err => console.log(`[S6 pageerror] ${err}`));
  const email = testEmail("s6");
  const user = await createTestUser(email);
  const seeded = await seedCascades(user.id, [{ name: "Existing Agent" }]);

  await gotoIntegrityFresh(page);
  await page.locator("#splashCta").click();
  await walkToServices(page, "cinema");
  await finishFlow(page);   // builds a fresh draft roster in memory, never reaching the server

  await page.locator("#membEmail").fill(email);
  await page.locator(".membcta").click();
  // AC6: no code is requested — the message and Sign in button show instead.
  await expect(page.locator("#membAcctExists")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#authVerify")).toBeHidden();
  await page.locator("#membSigninBtn").click();
  await expect(page.locator("#authSignedOut")).toBeVisible();
  expect(await page.locator("#authEmail").inputValue()).toBe(email);
  await page.locator("#authContinue").click();
  await expect(page.locator("#authVerify")).toBeVisible({ timeout: 30_000 });
  const code = await fetchOtp(email);
  await page.locator("#authCode").fill(code);
  await page.locator("#authVerifyBtn").click();
  await expect(page.locator("#authModal.open")).toBeHidden({ timeout: 30_000 });
  await settleListing(page);

  const onScreenIds = await page.evaluate(() => cascades.map(c => c.id).sort());
  expect(onScreenIds).toEqual(idsOf(seeded));
  const live = await liveCascades(user.id);
  expect(idsOf(live)).toEqual(idsOf(seeded));
});

test("S10: abandoning onboarding before membership completes leaves no server-side rows for that email", async ({ page }) => {
  // Change 4's exact shape: a reload abandons the draft (never written anywhere) rather than completing
  // membership. email_has_account — the real server-side check this ticket's own email gate uses — must
  // say false, proving no row for this email exists at all, not merely that `cascades` is empty for it.
  // CAS-1099 (requeue): forwarded for the same reason as S1 above — a prior run failed with no browser-side
  // evidence in the CI log.
  page.on("console", msg => console.log(`[S10 console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", err => console.log(`[S10 pageerror] ${err}`));
  const email = testEmail("s10");

  await gotoIntegrityFresh(page);
  await page.locator("#splashCta").click();
  await walkToServices(page, "cinema");
  await finishFlow(page);
  await page.locator("#membEmail").fill(email);

  await page.reload();
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  const hasAccount = await emailHasAccount(email);
  expect(hasAccount, "abandoning before membership must leave no server-side account for this email").toBe(false);
});

// CAS-1096: verdicts (user_films) moved onto acctOp — S7 proves a verdict set by hand on one device reaches
// another on reload, and clearing it back out is a delete of exactly that one row, every other row untouched.
test("S7: mark a film watched on A -> B shows it after reload; clear it on A leaves every other user_films row intact", async ({ browser }) => {
  // CAS-1093 (decision, 2026-10-01 build chat): scope of what must pass now is exactly S2 and S3 — S7-S9
  // belong to the later tickets that added them (CAS-1096/CAS-1095), fixme'd here even though they have
  // passed in CI before this decision.
  test.fixme(true, "added by a later ticket");
  const email = testEmail("s7");
  const user = await createTestUser(email);
  // CAS-1132: a signed-in account with zero agents routes straight into onboarding (afterSignIn's
  // "signin_empty_account" branch, CAS-1082) instead of the listing settleListing() waits on — this suite's
  // own S2/S3/S4 already seed an agent before signing in for exactly this reason; S7 only forgot to.
  await seedCascades(user.id, [{ name: "S7 agent" }]);
  const otherRows = [
    { user_id: user.id, movie_id: "9700001", status: "liked" },
    { user_id: user.id, movie_id: "9700002", status: "disliked" },
  ];
  const { error: seedErr } = await admin.from("user_films").insert(otherRows);
  if(seedErr) throw new Error(`seeding user_films failed: ${seedErr.message}`);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try{
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await gotoIntegrityFresh(pageA);
    await signInFromSplash(pageA, email);
    await settleListing(pageA);

    await gotoIntegrityFresh(pageB);
    await signInFromSplash(pageB, email);
    await settleListing(pageB);

    const filmId = await pageA.evaluate(() => MOVIES[0].tmdb_id);

    await pageA.evaluate((id) => window.setOpinion(id, "liked"), filmId);

    await expect.poll(async () => {
      const { data } = await admin.from("user_films").select("status")
        .eq("user_id", user.id).eq("movie_id", String(filmId)).maybeSingle();
      return data && data.status;
    }, { timeout: 15_000 }).toBe("liked");

    await pageB.reload();
    await pageB.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
    await settleListing(pageB);
    // CAS-1132: expect.poll's callback is re-invoked with no arguments — a callback declared to take one
    // (the earlier `(id) => ...` here) always ran with id===undefined, so this always read opinionOf(undefined)
    // (""), never the real filmId, however long it polled. Captured via closure instead, like every other
    // poll in this file already does.
    await expect.poll(
      () => pageB.evaluate((mid) => opinionOf(mid), filmId),
      { timeout: 15_000 },
    ).toBe("liked");

    // Tapping the same lit answer again clears it (CAS-100) — an explicit delete of that one row.
    await pageA.evaluate((id) => window.setOpinion(id, "liked"), filmId);

    await expect.poll(async () => {
      const { data } = await admin.from("user_films").select("movie_id,status").eq("user_id", user.id);
      return (data || []).map(r => `${r.movie_id}:${r.status}`).sort();
    }, { timeout: 15_000 }).toEqual(["9700001:liked", "9700002:disliked"]);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// CAS-1096: Watch On (film_watch) and picks/pins (film_picks) also moved onto acctOp — S8 proves every one
// of them (plus a verdict, user_films) survives the exact 2026-09-30-incident shape (a sign-out/sign-in
// cycle on the same context), on screen and server-side, unlike anything that would come back from a whole-
// table diff resync.
test("S8: sign out then sign back in leaves every verdict, Watch On and pin intact", async ({ page }) => {
  // CAS-1093 (decision, 2026-10-01 build chat): scope of what must pass now is exactly S2 and S3 — see S7's
  // identical fixme above.
  test.fixme(true, "added by a later ticket");
  const email = testEmail("s8");
  const user = await createTestUser(email);
  // CAS-1132: same zero-agent-routes-to-onboarding gap as S7 — see its comment above.
  await seedCascades(user.id, [{ name: "S8 agent" }]);
  const verdictId = "9800001", watchId = "9800002", pickId = "9800003", pinId = "9800004";
  const seeds = [
    admin.from("user_films").insert({ user_id: user.id, movie_id: verdictId, status: "wow" }),
    admin.from("film_watch").insert({ user_id: user.id, movie_id: watchId,
      windows: ["stream", "rent"], sources: { stream: "manual", rent: "manual" } }),
    admin.from("film_picks").insert({ user_id: user.id, movie_id: pickId, state: "mine", pinned_to: [], not_in: [] }),
    admin.from("film_picks").insert({ user_id: user.id, movie_id: pinId, state: null, pinned_to: ["s8-fake-agent"], not_in: [] }),
  ];
  for(const seed of await Promise.all(seeds)){
    if(seed.error) throw new Error(`S8 seeding failed: ${seed.error.message}`);
  }

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);

  const readState = ([a, b, c, d]) => ({
    verdict: opinionOf(Number(a)),
    watch: (notify[b] && notify[b].wins) ? Object.keys(notify[b].wins).filter(k => notify[b].wins[k]).sort() : [],
    pick: notify[c] && notify[c].source,
    pin: (notify[d] && notify[d].pinnedTo) || [],
  });
  // CAS-1132: settleListing() only waits on the cascades listing (#groups .group) — it says nothing about
  // user_films/film_picks, which load in the same fireAccountFanout() Promise.allSettled but (unlike
  // film_watch/user_prefs/notify_prefs's filmWatchReady/userPrefsReady/notifyPrefsReady — see app_template.html)
  // have no readiness flag of their own for a test to wait on instead. A one-shot read right after
  // settleListing() can win that race and read empty state despite the data already being seeded; poll
  // instead, the same way every other post-sign-in/post-reload read of this suite already does (S4, S7, S9).
  const before = { verdict: "wow", watch: ["rent", "stream"], pick: "manual", pin: ["s8-fake-agent"] };
  await expect.poll(
    () => page.evaluate(readState, [verdictId, watchId, pickId, pinId]),
    { timeout: 15_000 },
  ).toEqual(before);

  await signOutFromAccount(page);
  await signInFromSplash(page, email);
  await settleListing(page);

  await expect.poll(
    () => page.evaluate(readState, [verdictId, watchId, pickId, pinId]),
    { timeout: 15_000 },
  ).toEqual(before);

  const liveFilms = await admin.from("user_films").select("movie_id,status").eq("user_id", user.id);
  expect(liveFilms.data).toEqual([{ movie_id: verdictId, status: "wow" }]);
  const liveWatch = await admin.from("film_watch").select("movie_id,windows").eq("user_id", user.id);
  expect(liveWatch.data.map(r => r.movie_id)).toEqual([watchId]);
  expect([...liveWatch.data[0].windows].sort()).toEqual(["rent", "stream"]);
});

// CAS-1095: user_prefs moved onto per-column acctOp updates — S9 proves two devices can each change a
// different column of the SAME row concurrently (one a user_prefs column, the other a different user_prefs
// column plus a notify_prefs column) with no updated_at conflict check, and both changes still survive on
// both devices after a reload — the "last write of EACH column wins independently" rule this ticket adds.
test("S9: a service change on A, a language change on B, and a notify switch on B all land on both after reload", async ({ browser }) => {
  // CAS-1093 (decision, 2026-10-01 build chat): scope of what must pass now is exactly S2 and S3 — see S7's
  // identical fixme above.
  test.fixme(true, "added by a later ticket");
  const email = testEmail("s9");
  const user = await createTestUser(email);
  // CAS-1132: same zero-agent-routes-to-onboarding gap as S7/S8 — see S7's comment above.
  await seedCascades(user.id, [{ name: "S9 agent" }]);
  await admin.from("user_prefs").insert({ user_id: user.id });
  await admin.from("notify_prefs").insert({ user_id: user.id });

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try{
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await gotoIntegrityFresh(pageA);
    await signInFromSplash(pageA, email);
    await settleListing(pageA);

    await gotoIntegrityFresh(pageB);
    await signInFromSplash(pageB, email);
    await settleListing(pageB);

    // A changes a service (user_prefs.sub_services).
    await pageA.evaluate(() => { prefs.sub.add("Stan"); savePrefs(); pushPrefsCols(["sub_services", "store_services"]); });

    // B changes a language (user_prefs.taste.langs) and a notification switch (notify_prefs.in_app) —
    // two different settings, two different acctOp updates, from the same device.
    await pageB.evaluate(() => { tasteBase.langs = ["en", "fr"]; saveTasteBase(); });
    await pageB.evaluate(() => { notifyPrefs.inApp = false; saveNotifyPrefs(); });

    await expect.poll(async () => {
      const { data } = await admin.from("user_prefs").select("sub_services,taste").eq("user_id", user.id).single();
      return data && data.sub_services && data.sub_services.includes("Stan") && data.taste && JSON.stringify(data.taste.langs);
    }, { timeout: 15_000 }).toBe(JSON.stringify(["en", "fr"]));

    await expect.poll(async () => {
      const { data } = await admin.from("notify_prefs").select("in_app").eq("user_id", user.id).single();
      return data && data.in_app;
    }, { timeout: 15_000 }).toBe(false);

    await pageA.reload();
    await pageA.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
    await settleListing(pageA);
    await pageB.reload();
    await pageB.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
    await settleListing(pageB);

    for(const page of [pageA, pageB]){
      const state = await page.evaluate(() => ({ sub: [...prefs.sub], langs: tasteBase.langs, inApp: notifyPrefs.inApp }));
      expect(state.sub).toContain("Stan");
      expect(state.langs).toEqual(["en", "fr"]);
      expect(state.inApp).toBe(false);
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// CAS-1102: migration 0003 enforces at the DATABASE level that a client deletes at most one account row
// per statement, and that cascades can never be client-hard-deleted at all. This asserts on the trigger
// itself, not app behaviour, so it drives a real signed-in supabase-js client directly (signInDirect) —
// no browser, no page — the same way tests/rls/matrix.mjs probes RLS from the anon side.
test("S13: a client may delete at most one account row per statement; cascades cannot be hard-deleted; delete_my_account still removes everything", async () => {
  const email = testEmail("s13");
  const user = await createTestUser(email);
  const userClient = await signInDirect(email);

  const seedRows = [
    { user_id: user.id, movie_id: "9900001", status: "liked" },
    { user_id: user.id, movie_id: "9900002", status: "disliked" },
  ];
  const { error: seedErr } = await admin.from("user_films").insert(seedRows);
  if(seedErr) throw new Error(`S13 seeding failed: ${seedErr.message}`);

  // Deleting both of the caller's own user_films rows in one statement is refused; both remain.
  const bulkDelete = await userClient.from("user_films").delete().eq("user_id", user.id);
  expect(bulkDelete.error, "a two-row delete in one statement must be refused").toBeTruthy();
  const afterBulk = await admin.from("user_films").select("movie_id").eq("user_id", user.id);
  expect(afterBulk.data.map(r => r.movie_id).sort()).toEqual(["9900001", "9900002"]);

  // Deleting exactly one succeeds.
  const oneDelete = await userClient.from("user_films").delete()
    .eq("user_id", user.id).eq("movie_id", "9900001");
  expect(oneDelete.error, "a single-row delete must succeed").toBeFalsy();
  const afterOne = await admin.from("user_films").select("movie_id").eq("user_id", user.id);
  expect(afterOne.data.map(r => r.movie_id)).toEqual(["9900002"]);

  // A client delete on cascades is refused outright, even for exactly one row.
  const [agent] = await seedCascades(user.id, [{ name: "S13 agent" }]);
  const cascadeDelete = await userClient.from("cascades").delete().eq("id", agent.id);
  expect(cascadeDelete.error, "a client cascades delete must be refused").toBeTruthy();
  const liveAgent = await admin.from("cascades").select("id").eq("id", agent.id);
  expect(liveAgent.data.length).toBe(1);

  // delete_my_account (security definer) still removes everything, unaffected by the guard above.
  const rpcResult = await userClient.rpc("delete_my_account");
  expect(rpcResult.error, "delete_my_account must still succeed").toBeFalsy();
  const afterAccountCascades = await admin.from("cascades").select("id").eq("user_id", user.id);
  expect(afterAccountCascades.data.length).toBe(0);
  const afterAccountFilms = await admin.from("user_films").select("movie_id").eq("user_id", user.id);
  expect(afterAccountFilms.data.length).toBe(0);
});

// CAS-1137: usage_events_insert's with check rejected every row where data is null (pg_column_size(null)
// is null, and a with check that evaluates to null — not true — fails the row), which is how a signed-in
// user's whole usage_events flush came back 42501 (queueUsageEvent's many call sites with no data argument
// — splash_shown, flow_start, etc. — always send data: null). Drives a real signed-in supabase-js client
// directly, the same way S13 asserts on a policy/trigger rather than app behaviour.
// CAS-1155: a new account starts with email alerts ON, addressed to whatever email it signed up (or first
// signed in) with — not notifyPrefsDefault()'s signed-out device default (emailOn:false), which is what every
// account got before this ticket (membCompleteNewMembership() and loadNotifyPrefs()'s bootstrap insert both
// used to carry that default straight to the server). A row that already exists is never touched either way.
test("CAS-1155 S1: a new sign-up's notify_prefs row has email alerts on, addressed to the sign-up email", async ({ page }) => {
  page.on("console", msg => console.log(`[CAS-1155 S1 console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", err => console.log(`[CAS-1155 S1 pageerror] ${err}`));
  const email = testEmail("cas1155-s1");

  await gotoIntegrityFresh(page);
  await page.locator("#splashCta").click();
  await walkToServices(page, "cinema");
  await finishFlow(page);

  await page.locator("#membEmail").fill(email);
  await page.locator(".membcta").click();
  // CAS-1169: the code is confirmed on #membScreen itself (State B), never on #authModal.
  await expect(page.locator("#membCode")).toBeVisible({ timeout: 30_000 });
  const code = await fetchOtp(email);
  await page.locator("#membCode").fill(code);
  await page.locator(".membcta").click();
  await expect(page.locator("#membScreen.open")).toBeHidden({ timeout: 30_000 });
  await settleListing(page);

  const userId = await page.evaluate(() => window.CascadeAuth.user.id);
  await expect.poll(async () => {
    const row = await liveNotifyPrefs(userId);
    return row && { email_on: row.email_on, email_address: row.email_address };
  }, { timeout: 15_000 }).toEqual({ email_on: true, email_address: email });

  // AC: Settings' "How you're told" row shows Email and the sign-up address — read from the rendered DOM,
  // not notifyPrefs, so a load that wrote the server row but never updated the in-memory copy would be caught.
  await page.evaluate(() => window.openSettings());
  const row = page.locator("#settingsBody .urow", { hasText: "How you're told" });
  await expect(row).toContainText("Email");
  await expect(row).toContainText(email);
});

test("CAS-1155 S2: a missing notify_prefs row turns email alerts on at sign-in; an existing off row stays off", async ({ page }) => {
  const email = testEmail("cas1155-s2");
  const user = await createTestUser(email);
  // CAS-1132: a signed-in account with zero agents routes straight into onboarding instead of the listing
  // settleListing() waits on — seed one agent for exactly the reason S2/S3/S7 above already do.
  await seedCascades(user.id, [{ name: "CAS-1155 agent" }]);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, email);
  await settleListing(page);

  await expect.poll(async () => {
    const row = await liveNotifyPrefs(user.id);
    return row && { email_on: row.email_on, email_address: row.email_address };
  }, { timeout: 15_000 }).toEqual({ email_on: true, email_address: email });

  // An account whose existing row is already off must stay off — the bootstrap-only default above must
  // never touch a row that already exists.
  const emailOff = testEmail("cas1155-s2-off");
  const userOff = await createTestUser(emailOff);
  await seedCascades(userOff.id, [{ name: "CAS-1155 off agent" }]);
  const { error: seedErr } = await admin.from("notify_prefs")
    .insert({ user_id: userOff.id, email_on: false, email_address: null });
  if(seedErr) throw new Error(`CAS-1155 S2 seeding failed: ${seedErr.message}`);

  await gotoIntegrityFresh(page);
  await signInFromSplash(page, emailOff);
  await settleListing(page);

  const rowOff = await liveNotifyPrefs(userOff.id);
  expect(rowOff.email_on, "a row that already exists off must never be flipped on at sign-in").toBe(false);
});

test("S14: a signed-in client's usage_events insert succeeds with queueUsageEvent's exact row shape (data: null included); the same client cannot attribute a row to another user", async () => {
  const email = testEmail("s14");
  const user = await createTestUser(email);
  const userClient = await signInDirect(email);

  // AC1: the exact row shape queueUsageEvent sends, including the common data: null case.
  const ownRow = { user_id: user.id, client_key: "s14-client", session: "s14-session", type: "splash_shown", data: null };
  const ownInsert = await userClient.from("usage_events").insert(ownRow);
  expect(ownInsert.error, "a signed-in user's own usage_events insert must succeed").toBeFalsy();

  // AC2: the same client may not attribute a row to someone else's user id.
  const otherUser = await createTestUser(testEmail("s14-other"));
  const otherRow = { user_id: otherUser.id, client_key: "s14-client", session: "s14-session", type: "splash_shown", data: null };
  const otherInsert = await userClient.from("usage_events").insert(otherRow);
  expect(otherInsert.error, "a signed-in user must not be able to attribute a usage_events row to another user")
    .toBeTruthy();
});

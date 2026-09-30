// CAS-1093: account-integrity suite — the one part of CI that exercises a REAL Supabase (locally, via
// Supabase CLI + Docker; see scripts/test-integrity.mjs and supabase/config.toml). Every other job in
// qa.yml runs the app with no Supabase at all, which is how a sync pass that deleted every agent on
// sign-in (CAS-1090, 2026-09-30) reached production undetected. Each scenario here asserts on database
// rows, not only the screen — a regression that only breaks the screen while quietly leaving the account
// intact is not the class of bug this suite exists to catch.
//
// What must pass now (CAS-1093 AC2): S2 and S3, plus S4's propagation half — the stop-gap tickets CAS-1090
// and CAS-1107 are already in place for them. The rest are `test.fixme()`, not deleted: later tickets in
// the server-first account-store rework (https://codynamics.atlassian.net/wiki/spaces/Cascade/pages/64815105)
// un-fixme them as the features they depend on land, and add scenarios of their own for their own tables.
//   - S1, S6: once onboarding commits through complete_membership (CAS-1098/CAS-1099).
//   - S4's conflict half, S5: once agents move onto the account store (CAS-1094+).
import { test, expect } from "@playwright/test";
import {
  createTestUser, seedCascades, liveCascades, testEmail,
  gotoIntegrityFresh, signInFromSplash, signOutFromAccount,
} from "./helpers.mjs";
import { settleListing } from "../e2e/helpers.mjs";

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

    await gotoIntegrityFresh(pageA);
    await signInFromSplash(pageA, email);
    await settleListing(pageA);

    await gotoIntegrityFresh(pageB);
    await signInFromSplash(pageB, email);
    await settleListing(pageB);

    // Rename through the real Agents-screen edit flow (Edit → the hub's rename pencil → the name step),
    // then back out twice — closing the hub is what commits (briefClose → briefCommit → commitDraft →
    // saveCascades()), there is no separate Save button (CAS-934).
    await pageA.locator("#agentsBtn").click();
    await expect(pageA.locator("#agentsScreen")).toHaveClass(/open/);
    await pageA.locator(`.agrow[data-id="${seededAgent.id}"] .ag-edit`).click();
    await pageA.locator(".eapenc").click();
    await pageA.locator("#onbStepName").fill(newName);
    await pageA.locator(".osback").click();
    await pageA.locator(".osback").click();
    // saveCascades() debounces the actual push 400ms out (scheduleSync); force it rather than waiting on
    // the timer — window.CascadePersistence.syncNow is runSync itself, idempotent to call directly.
    await pageA.evaluate(() => window.CascadePersistence.syncNow());

    await expect.poll(async () => {
      const rows = await liveCascades(user.id);
      const row = rows.find(r => r.id === seededAgent.id);
      return row && row.name;
    }, { timeout: 15_000 }).toBe(newName);

    await pageB.reload();
    await pageB.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
    await settleListing(pageB);
    await expect.poll(
      (id) => pageB.evaluate((agentId) => {
        const c = cascades.find(x => x.id === agentId);
        return c && c.name;
      }, id),
      { timeout: 15_000 },
    ).toBe(newName);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("S1: a new member's onboarded roster exists on the server", async ({ page }) => {
  // Walk real onboarding (splash → flow → membScreen → sign-up) to a brand-new account and assert its
  // roster exists in `cascades` server-side. Fixme'd because onboarding doesn't commit through
  // complete_membership yet — it still writes locally-then-syncs, which this suite isn't asserting on.
  test.fixme(true, "until onboarding commits through complete_membership");
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
  // A context that previously held account X (signed out, or never synced) walks onboarding again and
  // completes membership with X's email — X's existing server-side agents must survive un-touched, not be
  // overwritten by the fresh onboarding roster. Fixme'd alongside S1: both need complete_membership.
  test.fixme(true, "until onboarding commits through complete_membership");
});

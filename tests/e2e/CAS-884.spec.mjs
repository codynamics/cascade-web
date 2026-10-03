// CAS-884: Recommend Cascade — the send half of M11 (Refer a friend). Signed-in only, reached
// from the nav menu; Cascade itself sends the email on a new hourly workflow, so this sheet only
// ever inserts a row into public.recommendations.
//
// CAS-1160 requeue: CAS-931 replaced the old single Name+Email pair (#recommendName/#recommendEmail,
// neither of which exists any more) with the same shared friend picker CAS-928's Invite sheet uses (own
// selMap/ctx:"recommend") — loadFriends() only runs off the app's real 'cascade-auth-change' event, which
// a hand-set window.CascadeAuth (this file's old primeFakeAccount technique) never dispatches, so this
// spec now follows CAS-928.spec.mjs's own bootSignedIn recipe instead: a real (faked) sign-in, a friends
// fixture, and a SEEDED_CASCADE so sign-in skips onboarding straight to the listing with the nav menu
// reachable.
import { test, expect } from "@playwright/test";
import { bootAlreadySignedIn } from "./helpers.mjs";

const SEEDED_CASCADE = { id: "884aaaa1-0000-4000-8000-000000000001", user_id: "cas884-user",
  name: "Existing agent", criteria: {}, created_at: "2020-01-01T00:00:00.000Z" };

const FIXTURE_FRIENDS = [
  { id: 1, name: "Priya", email: "priya@example.com", mobile: null, last_used_at: "2026-09-10T00:00:00.000Z" },
];

function fakeSupabaseScript(friendsFixture){
  return `
    window.__recommendInserts = [];
    window.__friendInserts = [];
    const FIXTURE_FRIENDS = ${JSON.stringify(friendsFixture)};
    const SEEDED_CASCADE = ${JSON.stringify(SEEDED_CASCADE)};
    function chain(){
      return new Proxy(() => {}, {
        get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
        apply: () => chain(),
      });
    }
    window.supabase = { createClient(){
      return {
        auth: {
          getSession: () => new Promise(resolve => { window.__cas884ResolveSession = () => resolve({ data: { session: {
            user: { id: "cas884-user", email: "cas884@example.com" }, access_token: "fake" } } }); }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
        },
        from: (table) => {
          // CAS-1109: acctLoad reads every table as .select("*").order(pk,{ascending:true}).range(from,to) —
          // same shape CAS-928.spec.mjs's own fixture needs for the "cascades" table.
          if(table === "cascades") return { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: [SEEDED_CASCADE], error: null }) }) }),
            upsert: () => chain(), delete: () => chain() };
          if(table === "friends") return {
            select: () => ({ order: () => Promise.resolve({ data: FIXTURE_FRIENDS, error: null }) }),
            insert: (rows) => ({ select: () => ({ single: () => {
              const row = { id: 900 + window.__friendInserts.length + 1, ...rows[0] };
              window.__friendInserts.push(row);
              return Promise.resolve({ data: row, error: null });
            } }) }),
            update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
          };
          if(table === "recommendations") return {
            insert: (rows) => { window.__recommendInserts.push(...rows); return Promise.resolve({ data: rows, error: null }); },
          };
          return chain();
        },
      };
    } };
  `;
}

/** A real (faked) sign-in with the friends fixture loaded off the genuine 'cascade-auth-change' event —
 * same route as CAS-928.spec.mjs's own bootSignedIn. */
async function bootSignedIn(page, friendsFixture){
  await bootAlreadySignedIn(page, {
    supabaseScript: fakeSupabaseScript(friendsFixture),
    resolveFnName: "__cas884ResolveSession",
    readyFlagExpr: "typeof friendsReady !== 'undefined' && friendsReady === true",
  });
}

async function openRecommendSheet(page){
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Recommend Cascade" }).click();
  await expect(page.locator("#recommend")).toHaveClass(/open/);
}

// AC6a: the nav menu contains Recommend Cascade, and opening it opens the sheet.
test("CAS-884 AC6a: the nav menu contains Recommend Cascade, and opening it opens the sheet", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await page.locator("#navMenuBtn").click();
  await expect(page.locator("#navMenu .navitem", { hasText: "Recommend Cascade" })).toBeVisible();
  await page.locator("#navMenu .navitem", { hasText: "Recommend Cascade" }).click();
  await expect(page.locator("#recommend")).toHaveClass(/open/);
});

// AC6b: opening it shows a pre-filled message naming Cascade.
test("CAS-884 AC6b: opening the sheet shows a pre-filled message naming Cascade", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await openRecommendSheet(page);
  const value = await page.locator("#recommendMsg").inputValue();
  expect(value.length).toBeGreaterThan(0);
  expect(value).toContain("Cascade");
});

// AC6c, superseded by CAS-931/CAS-1125: the free-text name field is gone, and the message textarea is no
// longer personalised by a typed name (CAS-1125: "it no longer greets anyone by name") — what replaced it
// is the shared friend picker, so the thing to prove is that selecting a friend is what enables Send and
// is reflected in its own label, same shape as CAS-928's own invite picker.
test("CAS-884 AC6c: selecting a friend from the picker enables Send and counts them in its label", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await openRecommendSheet(page);
  await expect(page.locator("#recommendSend")).toBeDisabled();
  await page.locator('#recommendPicker .frow[data-fid="1"]').click();
  await expect(page.locator("#recommendSend")).toBeEnabled();
  await expect(page.locator("#recommendSend")).toContainText("1");
});

// AC6d: sending performs exactly one insert into recommendations.
test("CAS-884 AC6d: sending performs exactly one insert into recommendations", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await openRecommendSheet(page);
  await page.locator('#recommendPicker .frow[data-fid="1"]').click();
  await page.locator("#recommendSend").click();
  await page.waitForFunction(() => window.__recommendInserts.length > 0, null, { timeout: 5000 });

  const rows = await page.evaluate(() => window.__recommendInserts);
  expect(rows.length).toBe(1);
  expect(rows[0].to_name).toBe("Priya");
  expect(rows[0].to_email).toBe("priya@example.com");
  expect(rows[0].message).toContain("Cascade");
});

// AC6e, superseded by CAS-931: there is no longer a free-text email to mis-type — "nobody selected" is
// the picker's own equivalent empty state, and it already keeps Send disabled with nothing inserted.
test("CAS-884 AC6e: with nobody selected, Send is disabled and nothing is inserted", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await openRecommendSheet(page);
  await expect(page.locator("#recommendSend")).toBeDisabled();
  const rows = await page.evaluate(() => window.__recommendInserts);
  expect(rows.length).toBe(0);
});

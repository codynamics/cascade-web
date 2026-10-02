// CAS-886: Invites screen, menu badge and the in-app reply alert — the SENDER's side of an invite. Follows
// smoke.spec.mjs's CAS-740 fake-network technique (not CAS-883's direct window.CascadeAuth mutation): the
// nav badge/dot and the Moving alert are populated by loadInvites(), which only runs off the app's own
// 'cascade-auth-change' event (fireAccountFanout in app_template.html) — a hand-set CascadeAuth object never
// dispatches that event, so a genuine (faked) sign-in is the only way to exercise it. A SEEDED_CASCADE keeps
// the account "already set up" so sign-in skips the onboarding wizard straight to the main app, exactly as
// CAS-740's own AC4 test proves.
import { test, expect } from "@playwright/test";
import { bootAlreadySignedIn } from "./helpers.mjs";

const SEEDED_CASCADE = { id: "886aaaa1-0000-4000-8000-000000000001", user_id: "cas886-user",
  name: "Existing agent", criteria: {}, created_at: "2020-01-01T00:00:00.000Z" };

// Two unread (Sam, and a null-to_name invite that must render "Someone"), one read ("Earlier"), one with
// no reply at all ("Waiting") — one fixture row per AC's own named case.
const FIXTURE_INVITES = [
  { token: "cas886-t1", tmdb_id: 100886001, film_title: "Practical Magic 2", to_name: "Sam",
    created_at: "2026-09-10T00:00:00.000Z",
    invite_replies: [{ id: 101, answer: "yes", created_at: "2026-09-10T00:10:00.000Z", seen_at: null }] },
  { token: "cas886-t2", tmdb_id: 100886002, film_title: "The Odyssey", to_name: null,
    created_at: "2026-09-09T00:00:00.000Z",
    invite_replies: [{ id: 102, answer: "yes", created_at: "2026-09-09T00:05:00.000Z", seen_at: null }] },
  { token: "cas886-t3", tmdb_id: 100886003, film_title: "The Runner", to_name: "Dex",
    created_at: "2026-09-08T00:00:00.000Z",
    invite_replies: [{ id: 103, answer: "no", created_at: "2026-09-08T00:05:00.000Z", seen_at: "2026-09-08T00:06:00.000Z" }] },
  { token: "cas886-t4", tmdb_id: 100886004, film_title: "The Weight", to_name: "Mum",
    created_at: "2026-09-07T00:00:00.000Z", invite_replies: [] },
];

function fakeSupabaseScript(invitesFixture){
  return `
    window.__seenUpdates = [];
    const FIXTURE_INVITES = ${JSON.stringify(invitesFixture)};
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
          getSession: () => new Promise(resolve => { window.__cas886ResolveSession = () => resolve({ data: { session: {
            user: { id: "cas886-user", email: "cas886@example.com" }, access_token: "fake" } } }); }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
          signInWithPassword: async () => ({ data: {}, error: null }),
          signUp: async () => ({ data: {}, error: null }),
          signOut: async () => ({ error: null }),
        },
        from: (table) => {
          // CAS-1109/CAS-1142: acctLoad() now pages with .select().order().range(), not .select().order()
          // alone — see CAS740_FAKE_SUPABASE_GLOBAL in smoke.spec.mjs for the same fix on the same bug class.
          if(table === "cascades") return { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: [SEEDED_CASCADE], error: null }) }) }),
            upsert: () => chain(), delete: () => chain() };
          if(table === "invites") return { select: () => ({ order: () => Promise.resolve({ data: FIXTURE_INVITES, error: null }) }) };
          if(table === "invite_replies") return { update: (fields) => ({ in: (col, ids) => {
            window.__seenUpdates.push({ fields, ids });
            return Promise.resolve({ error: null });
          } }) };
          return chain();
        },
      };
    } };
  `;
}

/** A real (faked) sign-in to an account that already holds an agent — CAS-740 AC4's own proven route past
 * the onboarding wizard — with loadInvites() run off the genuine 'cascade-auth-change' event this produces.
 * CAS-1084: thin adapter over helpers.mjs's shared bootAlreadySignedIn. */
async function bootSignedIn(page, invitesFixture){
  await bootAlreadySignedIn(page, {
    supabaseScript: fakeSupabaseScript(invitesFixture),
    resolveFnName: "__cas886ResolveSession",
    readyFlagExpr: "typeof invitesReady !== 'undefined' && invitesReady === true",
  });
}

// AC2a
test("CAS-886 AC2a: two unread replies show a count of 2 on Invites, and a dot on the menu button", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_INVITES);
  await page.locator("#navMenuBtn").click();
  await expect(page.locator("#invitesNavBadge")).toHaveText("2");
  await expect(page.locator("#navMenuDot")).toBeVisible();
});

// AC2b/AC2c
test("CAS-886 AC2b/2c: the three groups render in order, each fixture row in the right one, and a null to_name reads Someone", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_INVITES);
  await page.evaluate(() => openInvitesScreen());
  await expect(page.locator("#invitesScreen")).toHaveClass(/open/);

  // .flabel is text-transform:uppercase (app_template.html) — allInnerTexts() reads the rendered text, not
  // the "New replies"/"Earlier"/"Waiting" literal case from the source (renderInvitesScreen's own `label`s).
  const headings = await page.locator("#invitesBody .flabel").allInnerTexts();
  expect(headings).toEqual(["NEW REPLIES", "EARLIER", "WAITING"]);

  const rows = page.locator("#invitesBody .invrow");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Sam");
  await expect(rows.nth(1)).toContainText("Someone");
  await expect(rows.nth(2)).toContainText("Dex");
  await expect(rows.nth(3)).toContainText("Mum");
});

// AC2d
test("CAS-886 AC2d: opening Invites stamps seen_at on exactly the two unread replies, and the badge/dot clear", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_INVITES);
  await page.evaluate(() => openInvitesScreen());
  await page.waitForFunction(() => window.__seenUpdates.length > 0, null, { timeout: 5000 });

  const updates = await page.evaluate(() => window.__seenUpdates);
  expect(updates.length).toBe(1);
  expect(updates[0].ids.slice().sort()).toEqual([101, 102]);
  expect(updates[0].fields.seen_at).toBeTruthy();

  // #invitesScreen is still open and intercepts the nav button underneath it — close it first, the same
  // way AC2e's own test (below) already does before clicking anything else.
  await page.evaluate(() => closeInvitesScreen());
  await page.locator("#navMenuBtn").click();
  await expect(page.locator("#invitesNavBadge")).toBeHidden();
  await expect(page.locator("#navMenuDot")).toBeHidden();
});

// AC2e
test("CAS-886 AC2e: Moving renders the reply alert panel while a reply is unread, and not once it's seen", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_INVITES);
  await page.locator("#movingBtn").click();
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  await expect(page.locator(".invalert")).toBeVisible();

  await page.evaluate(() => openInvitesScreen());
  await page.waitForFunction(() => window.__seenUpdates.length > 0, null, { timeout: 5000 });
  await page.evaluate(() => closeInvitesScreen());

  await page.locator("#movingBtn").click();
  await expect(page.locator(".invalert")).toHaveCount(0);
});

// AC2f
test("CAS-886 AC2f: an account with no invites renders the empty state and no group headings", async ({ page }) => {
  await bootSignedIn(page, []);
  await page.evaluate(() => openInvitesScreen());
  await expect(page.locator("#invitesBody .invempty")).toBeVisible();
  await expect(page.locator("#invitesBody .flabel")).toHaveCount(0);
});

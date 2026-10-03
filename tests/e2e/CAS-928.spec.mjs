// CAS-928: the friends table and the shared recipient picker. Follows CAS-886's fake-network technique
// (not CAS-883's direct window.CascadeAuth mutation): friends are loaded by loadFriends(), which only
// runs off the app's own 'cascade-auth-change' event (fireAccountFanout in app_template.html) — a
// hand-set CascadeAuth object never dispatches that event, so a genuine (faked) sign-in is the only way
// to populate the `friends` array the Friends screen and the Invite picker both read. A SEEDED_CASCADE
// keeps the account "already set up" so sign-in skips the onboarding wizard straight to the main app,
// exactly as CAS-886's own spec proves.
import { test, expect } from "@playwright/test";
import { bootAlreadySignedIn } from "./helpers.mjs";

const SEEDED_CASCADE = { id: "928aaaa1-0000-4000-8000-000000000001", user_id: "cas928-user",
  name: "Existing agent", criteria: {}, created_at: "2020-01-01T00:00:00.000Z" };

// Sam/Mum have both channels (for AC3f's channel-tap), Priya/Tom are email-only, Dex is mobile-only (for
// AC3a's "no envelope" case) — one fixture row per AC's own named case.
const FIXTURE_FRIENDS = [
  { id: 1, name: "Sam", email: "sam@example.com", mobile: "0411111111", last_used_at: "2026-09-10T00:00:00.000Z" },
  { id: 2, name: "Priya", email: "priya@example.com", mobile: null, last_used_at: "2026-09-09T00:00:00.000Z" },
  { id: 3, name: "Dex", email: null, mobile: "0433221109", last_used_at: "2026-09-08T00:00:00.000Z" },
  { id: 4, name: "Mum", email: "mum@example.com", mobile: "0400000000", last_used_at: "2026-09-07T00:00:00.000Z" },
  { id: 5, name: "Tom", email: "tom@example.com", mobile: null, last_used_at: null },
];

function fakeSupabaseScript(friendsFixture){
  return `
    window.__friendInserts = [];
    window.__friendUpdates = [];
    window.__friendDeletes = [];
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
          getSession: () => new Promise(resolve => { window.__cas928ResolveSession = () => resolve({ data: { session: {
            user: { id: "cas928-user", email: "cas928@example.com" }, access_token: "fake" } } }); }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
          signInWithPassword: async () => ({ data: {}, error: null }),
          signUp: async () => ({ data: {}, error: null }),
          signOut: async () => ({ error: null }),
        },
        from: (table) => {
          // CAS-1109: acctLoad reads every table as .select("*").order(pk,{ascending:true}).range(from,to) —
          // the chain must go one level deeper than a bare .order() resolving, or .range() throws on the
          // resolved value and acctLoad never reaches loadAccount()'s afterSignIn() call (same pattern as
          // smoke.spec.mjs's own SEEDED_CASCADE mock).
          if(table === "cascades") return { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: [SEEDED_CASCADE], error: null }) }) }),
            upsert: () => chain(), delete: () => chain() };
          if(table === "friends") return {
            select: () => ({ order: () => Promise.resolve({ data: FIXTURE_FRIENDS, error: null }) }),
            insert: (rows) => ({ select: () => ({ single: () => {
              const row = { id: 900 + window.__friendInserts.length + 1, ...rows[0] };
              window.__friendInserts.push(row);
              return Promise.resolve({ data: row, error: null });
            } }) }),
            update: (fields) => ({ eq: (col, val) => ({ select: () => ({ single: () => {
              window.__friendUpdates.push({ id: val, fields });
              const existing = FIXTURE_FRIENDS.find(f => String(f.id) === String(val)) || {};
              return Promise.resolve({ data: { ...existing, ...fields, id: val }, error: null });
            } }) }) }),
            delete: () => ({ eq: (col, val) => { window.__friendDeletes.push(val); return Promise.resolve({ error: null }); } }),
          };
          return chain();
        },
      };
    } };
  `;
}

/** A real (faked) sign-in with the friends fixture loaded off the genuine 'cascade-auth-change' event —
 * same route as CAS-886's own bootSignedIn. CAS-1084: thin adapter over helpers.mjs's shared
 * bootAlreadySignedIn. */
async function bootSignedIn(page, friendsFixture){
  await bootAlreadySignedIn(page, {
    supabaseScript: fakeSupabaseScript(friendsFixture),
    resolveFnName: "__cas928ResolveSession",
    readyFlagExpr: "typeof friendsReady !== 'undefined' && friendsReady === true",
  });
}

async function openInviteSheet(page){
  const id = await page.evaluate(() => MOVIES[0].tmdb_id);
  await page.evaluate(fid => openFilmInvite(fid), id);
  await expect(page.locator("#filmInvite")).toHaveClass(/open/);
  return id;
}

// AC3a
test("CAS-928 AC3a: the Friends screen lists every fixture friend, and a mobile-only friend shows no envelope", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await page.evaluate(() => openFriendsScreen());
  await expect(page.locator("#friendsScreen")).toHaveClass(/open/);
  await expect(page.locator("#friendsRows .frow")).toHaveCount(5);

  const dex = page.locator('#friendsRows .frow[data-fid="3"]');
  await expect(dex).toContainText("Dex");
  await expect(dex.locator(".fchanstatic")).toHaveCount(0);

  const sam = page.locator('#friendsRows .frow[data-fid="1"]');
  await expect(sam.locator(".fchanstatic")).toHaveCount(1);
});

// AC3b
test("CAS-928 AC3b: typing in search filters by name and by email", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await page.evaluate(() => openFriendsScreen());

  await page.locator("#friendsSearchInput").fill("priya");
  await expect(page.locator("#friendsRows .frow:visible")).toHaveCount(1);
  await expect(page.locator("#friendsRows .frow:visible")).toContainText("Priya");

  await page.locator("#friendsSearchInput").fill("tom@example.com");
  await expect(page.locator("#friendsRows .frow:visible")).toHaveCount(1);
  await expect(page.locator("#friendsRows .frow:visible")).toContainText("Tom");
});

// AC3d
test("CAS-928 AC3d: adding a friend with a name but no email or mobile performs no insert and shows a reason", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await page.evaluate(() => openFriendsScreen());
  await page.locator('#friendsBody button:has-text("Add someone")').click();
  await page.locator("#ffName").fill("Jess");
  await page.locator('#friendsBody button:has-text("Add and select")').click();

  await expect(page.locator("#ffErr")).toBeVisible();
  const inserts = await page.evaluate(() => window.__friendInserts);
  expect(inserts.length).toBe(0);
});

// AC3g
test("CAS-928 AC3g: deleting a friend asks for confirmation first, then removes the row", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await page.evaluate(() => openFriendsScreen());
  page.on("dialog", dialog => dialog.accept());

  await page.locator('#friendsRows .frow[data-fid="5"]').click();
  await page.locator('#friendsBody button:has-text("Remove")').click();

  await expect(page.locator("#friendsScreen")).not.toContainText("Tom");
  const deletes = await page.evaluate(() => window.__friendDeletes);
  expect(deletes.map(String)).toContain("5");
});

// AC4
test("CAS-928 AC4: the empty-friends state renders without error", async ({ page }) => {
  await bootSignedIn(page, []);
  await page.evaluate(() => openFriendsScreen());
  await expect(page.locator("#friendsBody .fempty")).toBeVisible();
});

// AC3c, superseded by CAS-1121: Send's label is the selected friend's own name for exactly one selection
// ("Invite Jess"), not a bare count — "Your name" (the sender's own) is what moved into the sheet, and a
// count only shows once two or more people are picked (see AC3e just below).
test("CAS-928 AC3c: adding a friend with a name and an email inserts one row, selects them and names them on Send", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await openInviteSheet(page);

  await page.locator('#filmInviteBody button:has-text("Add someone new")').click();
  await page.locator("#ffName").fill("Jess");
  await page.locator("#ffEmail").fill("jess@example.com");
  await page.locator('#filmInviteBody button:has-text("Add and select")').click();
  await page.waitForFunction(() => window.__friendInserts.length > 0, null, { timeout: 5000 });

  const inserts = await page.evaluate(() => window.__friendInserts);
  expect(inserts.length).toBe(1);
  expect(inserts[0].name).toBe("Jess");
  await expect(page.locator("#filmInviteSend")).toContainText("Jess");
  const jessId = inserts[0].id;
  await expect(page.locator(`#filmInvitePicker .frow[data-fid="${jessId}"]`)).toHaveClass(/fsel/);
});

// AC3e
test("CAS-928 AC3e: ticking three friends shows three selected, unticking one leaves two", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await openInviteSheet(page);

  for(const id of [1, 2, 4]){
    await page.locator(`#filmInvitePicker .frow[data-fid="${id}"]`).click();
  }
  await expect(page.locator("#filmInviteSend")).toContainText("3");

  await page.locator('#filmInvitePicker .frow[data-fid="2"]').click();
  await expect(page.locator("#filmInviteSend")).toContainText("2");
});

// AC3f
test("CAS-928 AC3f: tapping WhatsApp on a friend with a mobile marks that row's channel and clears the envelope", async ({ page }) => {
  await bootSignedIn(page, FIXTURE_FRIENDS);
  await openInviteSheet(page);

  const row = page.locator('#filmInvitePicker .frow[data-fid="1"]');
  await row.click();
  const mail = row.locator('.fchan[aria-label^="Email"]');
  const wa = row.locator('.fchan[aria-label^="WhatsApp"]');
  await expect(mail).toHaveClass(/on/);

  await wa.click();
  await expect(wa).toHaveClass(/on/);
  await expect(mail).not.toHaveClass(/on/);
});

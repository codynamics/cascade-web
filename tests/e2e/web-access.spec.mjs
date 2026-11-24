// CAS-1551: the web's invite-only path (CAS-1531/CAS-1533). On the web (Capacitor.isNativePlatform() false) a
// signed-in account that is not on the approved list (public.web_access, asked through the
// is_web_access_approved RPC) is held on the invite-only screen with a Sign out button; an approved one gets
// in. The Supabase client is faked here, the same way the other specs fake it (CAS-932's recipe, with the
// session already present on boot so the sign-in gate runs by itself rather than behind the splash flow).
// Runs in e2e-full only (not the push gate).
import { test, expect } from "@playwright/test";
import { gotoFresh } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 } });

const SEEDED_CASCADE = { id: "1551aaaa-0000-4000-8000-000000000001", user_id: "cas1551-user",
  name: "Existing agent", criteria: {}, created_at: "2020-01-01T00:00:00.000Z" };

function fakeSupabaseScript(approved){
  return `
    window.__rpcCalls = [];
    window.__signOutCalls = 0;
    const SEEDED_CASCADE = ${JSON.stringify(SEEDED_CASCADE)};
    const SESSION = { user: { id: "cas1551-user", email: "cas1551@example.com" }, access_token: "fake" };
    function chain(){
      return new Proxy(() => {}, {
        get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
        apply: () => chain(),
      });
    }
    window.supabase = { createClient(){
      return {
        auth: {
          getSession: async () => ({ data: { session: SESSION } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
          signOut: async () => { window.__signOutCalls += 1; return { error: null }; },
        },
        from: (table) => {
          if(table === "cascades") return { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: [SEEDED_CASCADE], error: null }) }) }),
            upsert: () => chain(), delete: () => chain() };
          // memberships (no row) and everything else: an empty answer, which is "no active membership".
          return chain();
        },
        rpc: async (fn) => {
          window.__rpcCalls.push(fn);
          if(fn === "is_web_access_approved") return { data: ${approved ? "true" : "false"}, error: null };
          return { data: null, error: null };
        },
      };
    } };
  `;
}

async function bootSignedIn(page, approved){
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: fakeSupabaseScript(approved),
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);
  await page.waitForFunction(() => window.CascadeAuth.status === "signed-in", null, { timeout: 30_000 });
  // The gate has asked the server by the time the entitlement is anything but "unknown".
  await page.waitForFunction(() => membEnt.state !== "unknown", null, { timeout: 30_000 });
}

test("CAS-1551 web access: a signed-in account not on the approved list sees the invite-only screen, with Sign out", async ({ page }) => {
  await bootSignedIn(page, false);
  expect(await page.evaluate(() => membIsNativeApp())).toBe(false);
  expect(await page.evaluate(() => window.__rpcCalls)).toContain("is_web_access_approved");

  await expect(page.locator("#membScreen")).toHaveClass(/open/);
  await expect(page.locator("#membHead")).toHaveText("Cascade on the web is invite-only");
  await expect(page.locator("#membInviteMsg")).toContainText("invite-only");
  await expect(page.locator("#membInviteMsg")).toContainText("iPhone app");
  // No price box and no purchase on the web: Sign out is the only action.
  await expect(page.locator("#membScreen .membcta")).toHaveCount(1);
  await expect(page.locator("#membSignOutBtn")).toBeVisible();
  await expect(page.locator("#membSignOutBtn")).toHaveText("Sign out");

  await page.locator("#membSignOutBtn").click();
  await expect(page.locator("#membScreen")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => window.__signOutCalls)).toBe(1);
});

test("CAS-1551 web access: an approved account gets in", async ({ page }) => {
  await bootSignedIn(page, true);
  expect(await page.evaluate(() => window.__rpcCalls)).toContain("is_web_access_approved");
  expect(await page.evaluate(() => membEnt.state)).toBe("active");
  expect(await page.evaluate(() => membEnt.row.source)).toBe("web_access");

  await expect(page.locator("#membScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#membSignOutBtn")).toHaveCount(0);
  await expect(page.locator("#splash")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => cascades.length)).toBe(1);
});

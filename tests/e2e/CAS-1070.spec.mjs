// CAS-1070 / CAS-1170: App Store requires a privacy policy link reachable inside the app, and a support
// link. CAS-1170 moved the policy itself in-app (#privacyScreen, in Cascade's own look) instead of linking
// out to the company site — these specs cover both surfaces: the About screen (Menu → About) and the
// account sign-up email step on #membScreen (shown when membNeedsEmail() is true — a configured,
// signed-out build).
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

const SUPPORT_URL = "https://www.codynamics.com.au/support";

test("About screen (Menu → About): Privacy policy opens #privacyScreen in-app, Back returns to About (CAS-1170 AC5)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "About" }).click();
  await expect(page.locator("#aboutScreen.open")).toBeVisible();

  const support = page.locator("#aboutScreen a", { hasText: "Support" });
  await expect(support).toBeVisible();
  await expect(support).toHaveAttribute("href", SUPPORT_URL);

  await page.locator("#aboutScreen button", { hasText: "Privacy policy" }).click();
  await expect(page.locator("#privacyScreen.open")).toBeVisible();
  const onTop = await page.evaluate(() => {
    const r = document.getElementById("privacyScreen").getBoundingClientRect();
    const el = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return !!(el && el.closest("#privacyScreen"));
  });
  expect(onTop).toBe(true);

  await page.locator("#privacyScreen .osback").click();
  await expect(page.locator("#privacyScreen.open")).toHaveCount(0);
  await expect(page.locator("#aboutScreen.open")).toBeVisible();
});

// Reuses the CAS-913/smoke.spec.mjs technique for a configured-but-signed-out device: a REAL (fake)
// Supabase config from page load, not freshApp's guest-mode 404, so membNeedsEmail() is true and
// #membScreen's email step actually renders. Reached directly via ?step=membership (same preview entry
// CAS-1069's own standalone-preview test uses) rather than walking the full onboarding flow, since this
// only needs the email step's own markup, not a completed roster.
const CAS1070_FAKE_SUPABASE_GLOBAL = `
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
        signInWithOtp: async () => ({ data: {}, error: null }),
        verifyOtp: async () => ({ data: {}, error: null }),
        signOut: async () => ({ error: null }),
      },
      from: () => chain(),
    };
  } };
`;

// CAS-1159: confirmed app defect, not a stale assertion — #membEmail genuinely never renders. The
// ?step=membership preview's boot-time openPreviewStep("membership", ...) call (app_template.html, the
// `if(!openedShared && previewStep && openPreviewStep(...))` line) runs inside the classic <script>, before
// the `<script type="module">` further down the page has executed — that module is what assigns
// `window.CascadeAuth` in the first place. So membNeedsEmail() reads a `window.CascadeAuth` that doesn't
// exist yet, always returns false, and openMembership() renders with no #membEmail field at all. Nothing
// ever re-renders the membership screen once the module finishes and CascadeAuth becomes real — unlike the
// equivalent races this file documents already having a fix for (e.g. tryResolveFilmInvite's own
// 'cascade-auth-change' "second chance" listener), this call site has no such retry. Reproduced locally
// (no Docker needed — this test never calls toShortlist): #membEmail is confirmed absent every run. CAS-1170
// inherits this same block: the Privacy policy control it added only exists inside the `needsEmail` branch,
// so it can't be exercised here either until CAS-1159's underlying race is fixed.
test.fixme("membScreen email step: Privacy policy opens #privacyScreen in-app and keeps the typed email (CAS-1170 AC4)", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS1070_FAKE_SUPABASE_GLOBAL,
  }));
  await page.goto("/index.html?step=membership");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html?step=membership");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await expect(page.locator("#membScreen.open")).toBeVisible();
  await expect(page.locator("#membEmail")).toBeVisible();
  await page.locator("#membEmail").fill("person@example.com");

  await page.locator("#membBody button", { hasText: "Privacy policy" }).click();
  await expect(page.locator("#privacyScreen.open")).toBeVisible();
  const onTop = await page.evaluate(() => {
    const r = document.getElementById("privacyScreen").getBoundingClientRect();
    const el = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return !!(el && el.closest("#privacyScreen"));
  });
  expect(onTop).toBe(true);

  await page.locator("#privacyScreen .osback").click();
  await expect(page.locator("#privacyScreen.open")).toHaveCount(0);
  await expect(page.locator("#membScreen.open")).toBeVisible();
  await expect(page.locator("#membEmail")).toHaveValue("person@example.com");
});

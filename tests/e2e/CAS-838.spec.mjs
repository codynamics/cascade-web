// CAS-838: one shared Contact us sheet, opened from both About surfaces — #aboutPage (signed out, from
// the splash) and renderAbout()'s #aboutScreen (reached from the nav menu). Mirrors the fake-config/
// fake-supabase-js technique CAS-740/CAS-835/CAS-837's specs use (see CAS740_FAKE_SUPABASE_GLOBAL in
// smoke.spec.mjs) to capture the contact_messages insert without touching a live project. The fake
// session is signed-out-but-configured throughout — CascadeAuth's client exists once Supabase is
// configured regardless of session state, and contact_messages' own RLS policy grants insert to anon.
import { test, expect } from "@playwright/test";
import { freshApp, gotoFresh, toShortlist, finishFlow, toListing } from "./helpers.mjs";

const CAS838_FAKE_SUPABASE_GLOBAL = `
  window.__contactInserts = [];
  window.__contactShouldFail = false;
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
        signInWithPassword: async () => ({ data: {}, error: null }),
        signUp: async () => ({ data: {}, error: null }),
        signOut: async () => ({ error: null }),
      },
      from: (table) => {
        if(table !== "contact_messages") return chain();
        return { insert: (rows) => {
          if(window.__contactShouldFail) return Promise.resolve({ data: null, error: { message: "insert failed" } });
          window.__contactInserts.push(...rows);
          return Promise.resolve({ data: rows, error: null });
        } };
      },
    };
  } };
`;

async function configuredApp(page){
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS838_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.enabled === true, null, { timeout: 5000 });
}

async function openFromSplash(page){
  await page.locator("#splashAbout").click();
  await expect(page.locator("#aboutPage")).toHaveClass(/open/);
  await page.locator("#aboutPageContact").click();
  await expect(page.locator("#contact")).toHaveClass(/open/);
}

// AC4a — gating moved from "a category is chosen" to "message + email are valid" under CAS-927;
// category is now optional, so choosing one alone no longer enables Send.
test("CAS-838 AC4a: from the splash, About then Contact us opens the sheet with Send disabled until message and email are valid (CAS-927)", async ({ page }) => {
  await freshApp(page);
  await openFromSplash(page);
  await expect(page.locator("#contactSend")).toBeDisabled();
  await page.locator("#contactCatChips .chip", { hasText: "Bug" }).click();
  await expect(page.locator("#contactSend")).toBeDisabled();
  await page.locator("#contactMsg").fill("Something looks broken.");
  await page.locator("#contactEmail").fill("cas838@example.com");
  await expect(page.locator("#contactSend")).toBeEnabled();
});

// AC4b
test("CAS-838 AC4b: choosing Bug and sending inserts one row with a non-empty diagnostics string carrying the build version", async ({ page }) => {
  await configuredApp(page);
  await openFromSplash(page);
  await page.locator("#contactCatChips .chip", { hasText: "Bug" }).click();
  await page.locator("#contactEmail").fill("cas838@example.com");
  await page.locator("#contactMsg").fill("Something looks broken.");
  // CAS-1149: WebKit swallows the very next real tap after a .fill() leaves a text field focused (see
  // CAS-864's spec and CAS-927's existing .blur() convention around this same button) — blur it first.
  await page.locator("#contactMsg").blur();
  await page.locator("#contactSend").click();
  await page.waitForFunction(() => window.__contactInserts.length > 0, null, { timeout: 5000 });

  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows.length).toBe(1);
  expect(rows[0].category).toBe("bug");
  expect(typeof rows[0].diagnostics).toBe("string");
  expect(rows[0].diagnostics.length).toBeGreaterThan(0);
  const version = await page.evaluate(() => BUILD_INFO.version);
  expect(rows[0].diagnostics).toContain(version);
});

// AC4c
test("CAS-838 AC4c: choosing Suggestion and sending inserts a row whose diagnostics is null", async ({ page }) => {
  await configuredApp(page);
  await openFromSplash(page);
  await page.locator("#contactCatChips .chip", { hasText: "Suggestion" }).click();
  await page.locator("#contactEmail").fill("cas838@example.com");
  await page.locator("#contactMsg").fill("It would be nice if...");
  // CAS-1149: see AC4b's comment above — blur the just-filled field before the Send tap.
  await page.locator("#contactMsg").blur();
  await page.locator("#contactSend").click();
  await page.waitForFunction(() => window.__contactInserts.length > 0, null, { timeout: 5000 });

  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows.length).toBe(1);
  expect(rows[0].category).toBe("suggestion");
  expect(rows[0].diagnostics).toBeNull();
});

// AC4d
test("CAS-838 AC4d: filling the honeypot and sending performs no insert at all", async ({ page }) => {
  await configuredApp(page);
  await openFromSplash(page);
  await page.locator("#contactCatChips .chip", { hasText: "Bug" }).click();
  await page.locator("#contactEmail").fill("cas838@example.com");
  await page.locator("#contactMsg").fill("Ignore me, I'm a bot.");
  await page.evaluate(() => { document.getElementById("contactHp").value = "http://spam.example"; });
  await page.locator("#contactSend").click();
  await page.waitForTimeout(300);

  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows.length).toBe(0);
});

// AC4e
test("CAS-838 AC4e: a message longer than 2000 characters cannot be entered", async ({ page }) => {
  await freshApp(page);
  await openFromSplash(page);
  await page.locator("#contactMsg").fill("x".repeat(2500));
  const value = await page.locator("#contactMsg").inputValue();
  expect(value.length).toBe(2000);
});

// AC4f
test("CAS-838 AC4f: when the insert rejects, the typed message stays in the textarea and an error is visible", async ({ page }) => {
  await configuredApp(page);
  await page.evaluate(() => { window.__contactShouldFail = true; });
  await openFromSplash(page);
  await page.locator("#contactCatChips .chip", { hasText: "Bug" }).click();
  await page.locator("#contactEmail").fill("cas838@example.com");
  await page.locator("#contactMsg").fill("This should fail to send.");
  // CAS-1149: see AC4b's comment above — blur the just-filled field before the Send tap.
  await page.locator("#contactMsg").blur();
  await page.locator("#contactSend").click();

  await expect(page.locator("#contactErr")).toBeVisible();
  await expect(page.locator("#contactMsg")).toHaveValue("This should fail to send.");
  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows.length).toBe(0);
});

// AC5
test("CAS-838 AC5: reached from the nav-menu About screen, the same sheet opens", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator(".navitem", { hasText: "About" }).click();
  await expect(page.locator("#aboutScreen")).toHaveClass(/open/);
  await page.locator("#aboutScreenContact").click();
  await expect(page.locator("#contact")).toHaveClass(/open/);
});

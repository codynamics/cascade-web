// CAS-927: the Contact us sheet (CAS-838) gated Send on a category chip and validated neither of the two
// fields that actually matter. Category is now optional (defaults to "other" on insert — the column is
// not-null with a 4-value check constraint), while message and email are both required, email validated
// for shape only. Mirrors the fake-config/fake-supabase-js technique CAS-838's own spec uses to capture
// the contact_messages insert without touching a live project.
import { test, expect } from "@playwright/test";
import { freshApp, gotoFresh } from "./helpers.mjs";

const CAS927_FAKE_SUPABASE_GLOBAL = `
  window.__contactInserts = [];
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
    body: CAS927_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.enabled === true, null, { timeout: 5000 });
}

async function openFromSplash(page){
  await page.locator("#splashLogin").click();
  await expect(page.locator("#authModal")).toHaveClass(/open/);
  await page.locator("#authContact").click();
  await expect(page.locator("#contact")).toHaveClass(/open/);
}

// AC2a
test("CAS-927 AC2a: on first open, Send is disabled and no error text is shown", async ({ page }) => {
  await freshApp(page);
  await openFromSplash(page);
  await expect(page.locator("#contactSend")).toBeDisabled();
  await expect(page.locator("#contactMsgErr")).toBeHidden();
  await expect(page.locator("#contactEmailErr")).toBeHidden();
});

// AC2b
test("CAS-927 AC2b: a message with no email leaves Send disabled and shows an email error once that field is touched and left", async ({ page }) => {
  await freshApp(page);
  await openFromSplash(page);
  await page.locator("#contactMsg").fill("Something looks broken.");
  await expect(page.locator("#contactEmailErr")).toBeHidden();
  await page.locator("#contactEmail").focus();
  await page.locator("#contactEmail").blur();
  await expect(page.locator("#contactEmailErr")).toBeVisible();
  await expect(page.locator("#contactEmailErr")).toContainText(/email/i);
  await expect(page.locator("#contactSend")).toBeDisabled();
});

// AC2c
test("CAS-927 AC2c: a valid email with no message leaves Send disabled and shows a message error once that field is touched and left", async ({ page }) => {
  await freshApp(page);
  await openFromSplash(page);
  await page.locator("#contactEmail").fill("cas927@example.com");
  await expect(page.locator("#contactMsgErr")).toBeHidden();
  await page.locator("#contactMsg").focus();
  await page.locator("#contactMsg").blur();
  await expect(page.locator("#contactMsgErr")).toBeVisible();
  await expect(page.locator("#contactMsgErr")).toContainText(/message/i);
  await expect(page.locator("#contactSend")).toBeDisabled();
});

// AC2d
test("CAS-927 AC2d: a valid message and email with no category chosen enables Send and inserts category \"other\" with null diagnostics", async ({ page }) => {
  await configuredApp(page);
  await openFromSplash(page);
  await page.locator("#contactMsg").fill("Something looks broken.");
  await page.locator("#contactEmail").fill("cas927@example.com");
  await expect(page.locator("#contactSend")).toBeEnabled();
  await page.locator("#contactSend").click();
  await page.waitForFunction(() => window.__contactInserts.length > 0, null, { timeout: 5000 });

  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows.length).toBe(1);
  expect(rows[0].category).toBe("other");
  expect(rows[0].diagnostics).toBeNull();
});

// AC2e
test("CAS-927 AC2e: choosing Bug with a valid message and email inserts category \"bug\" with non-empty diagnostics", async ({ page }) => {
  await configuredApp(page);
  await openFromSplash(page);
  await page.locator("#contactCatChips .chip", { hasText: "Bug" }).click();
  await page.locator("#contactMsg").fill("Something looks broken.");
  await page.locator("#contactEmail").fill("cas927@example.com");
  await expect(page.locator("#contactSend")).toBeEnabled();
  await page.locator("#contactSend").click();
  await page.waitForFunction(() => window.__contactInserts.length > 0, null, { timeout: 5000 });

  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows.length).toBe(1);
  expect(rows[0].category).toBe("bug");
  expect(typeof rows[0].diagnostics).toBe("string");
  expect(rows[0].diagnostics.length).toBeGreaterThan(0);
});

// AC2f
test("CAS-927 AC2f: email shape is validated — a+b@example.co.uk is accepted, notanemail and a@b are rejected", async ({ page }) => {
  await freshApp(page);
  await openFromSplash(page);
  await page.locator("#contactMsg").fill("Something looks broken.");

  await page.locator("#contactEmail").fill("notanemail");
  await page.locator("#contactEmail").blur();
  await expect(page.locator("#contactSend")).toBeDisabled();

  await page.locator("#contactEmail").fill("a@b");
  await page.locator("#contactEmail").blur();
  await expect(page.locator("#contactSend")).toBeDisabled();

  await page.locator("#contactEmail").fill("a+b@example.co.uk");
  await page.locator("#contactEmail").blur();
  await expect(page.locator("#contactSend")).toBeEnabled();
});

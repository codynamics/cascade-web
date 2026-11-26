// CAS-835: logEvent's local-only usage log gains a batched Supabase sink (`usage_events`), used
// alongside — not instead of — the existing localStorage copy. Mirrors the fake-config/fake-supabase-js
// technique CAS-740's smoke.spec.mjs tests use (see CAS740_FAKE_SUPABASE_GLOBAL there): route config.js
// to a "configured" (non-placeholder) Supabase config and supabase-js.js to a fake global whose client's
// `.from("usage_events").insert()` captures rows instead of hitting a network.
import { test, expect } from "@playwright/test";
import { freshApp, gotoFresh, withActiveMember } from "./helpers.mjs";

const CAS835_FAKE_SUPABASE_GLOBAL = `
  window.__cas835Inserts = [];
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
      from: (table) => table === "usage_events"
        ? { insert: (rows) => { window.__cas835Inserts.push(rows); return Promise.resolve({ data: rows, error: null }); } }
        : chain(),
    };
  } };
`;

test("CAS-835 AC4: a hidden tab flushes exactly one batch insert into usage_events, every row carrying client_key/type/session", async ({ page }) => {
  const rejections = [];
  page.on("pageerror", e => rejections.push(String(e)));

  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: withActiveMember(CAS835_FAKE_SUPABASE_GLOBAL),
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);

  // showSplash() on a fresh device already calls logEvent("splash_shown") — drive one more explicit
  // event on top of it so a flush batching several queued events into one insert is exercised.
  await expect(page.locator("#splashCta")).toBeVisible();
  await page.evaluate(() => logEvent("cas835_test", { a: 1 }));

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const inserts = await page.evaluate(() => window.__cas835Inserts);
  expect(inserts.length).toBe(1);
  const rows = inserts[0];
  expect(rows.length).toBeGreaterThan(0);
  for(const row of rows){
    expect(row.client_key).toBeTruthy();
    expect(row.type).toBeTruthy();
    expect(row.session).toBeTruthy();
  }
  expect(rejections).toEqual([]);
});

test("CAS-835 AC5: with no Supabase config the app still boots, the local usage log still fills, and nothing throws", async ({ page }) => {
  const rejections = [];
  page.on("pageerror", e => rejections.push(String(e)));

  await freshApp(page);
  await expect(page.locator("#splashCta")).toBeVisible();

  await page.evaluate(() => logEvent("cas835_test", { a: 1 }));
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const log = await page.evaluate(() => JSON.parse(localStorage.getItem("cascade_log") || "[]"));
  expect(log.length).toBeGreaterThan(0);
  expect(log.some(e => e.type === "cas835_test")).toBe(true);
  expect(rejections).toEqual([]);
});

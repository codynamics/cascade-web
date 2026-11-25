// CAS-1577: a signed-out cold load must route to the splash at boot, with no frame of the main app first.
// Before: boot chose splash vs app on the device flag cascade_onboarded alone, so an onboarded device with no
// session painted the app, then the auth module's async no-session result (setSignedOut -> showSplash)
// replaced it. The fake supabase-js below leaves getSession() pending forever: that is the point — the
// decision must be made synchronously from the stored sb-*-auth-token, not from the async restore.
import { test, expect } from "@playwright/test";

const HOST = "https://cas1577-project.supabase.test";
const STORAGE_KEY = "sb-cas1577-project-auth-token";

const FAKE_SUPABASE = `
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: () => new Promise(() => {}),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
        signInWithPassword: async () => ({ data: {}, error: null }),
        signUp: async () => ({ data: {}, error: null }),
        signOut: async () => ({ error: null }),
      },
      from: () => chain(),
      rpc: async () => ({ data: null, error: null }),
    };
  } };
`;

async function load(page, { session }){
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "${HOST}", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({ contentType: "application/javascript", body: FAKE_SUPABASE }));
  await page.route(`${HOST}/**`, route => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  // Seed the device as onboarded (and optionally holding a stored session) before any page script runs, and
  // record every frame on which the splash is NOT open — the flash is exactly such a frame.
  await page.addInitScript(([key, withSession]) => {
    try{
      localStorage.setItem("cascade_onboarded", "1");
      if(withSession) localStorage.setItem(key, JSON.stringify({ access_token: "fake", refresh_token: "fake-refresh", user: { id: "u1" } }));
    }catch(e){}
    window.__cas1577 = { atDomReady: null, framesWithoutSplash: 0, frames: 0 };
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.getElementById("splash");
      window.__cas1577.atDomReady = !!(s && s.classList.contains("open"));
    });
    // Frames count from DOMContentLoaded: boot runs in a script at the end of the body, so a frame painted
    // mid-parse (before boot has run at all) says nothing about boot's routing decision.
    let ready = false;
    document.addEventListener("DOMContentLoaded", () => { ready = true; });
    const tick = () => {
      const s = document.getElementById("splash");
      if(s && ready){ window.__cas1577.frames++; if(!s.classList.contains("open")) window.__cas1577.framesWithoutSplash++; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [STORAGE_KEY, session]);
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);
}

test("CAS-1577: onboarded device with config but no stored session opens on the splash, never the app", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page, { session: false });
  await expect(page.locator("#splash")).toHaveClass(/open/);
  const r = await page.evaluate(() => window.__cas1577);
  expect(r.atDomReady, "splash already open when DOMContentLoaded fires").toBe(true);
  expect(r.frames).toBeGreaterThan(0);
  expect(r.framesWithoutSplash, "no frame where the splash was absent (the main nav showing)").toBe(0);
});

test("CAS-1577: onboarded device with a stored session opens the app, not the splash", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page, { session: true });
  await expect(page.locator("#splash")).not.toHaveClass(/open/);
  await expect(page.locator("#navMenuBtn")).toBeVisible();
  const r = await page.evaluate(() => window.__cas1577);
  expect(r.atDomReady).toBe(false);
});

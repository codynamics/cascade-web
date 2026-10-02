// CAS-978: Feedback — wires Account's dead "Feedback form" row (and the Help screen footer) onto the
// same contact_messages pipeline #contact (CAS-838) already uses. Mirrors CAS-838.spec.mjs's
// fake-supabase-js technique (see CAS740_FAKE_SUPABASE_GLOBAL in smoke.spec.mjs) to capture the insert
// without touching a live project — signed-out-but-configured throughout, since contact_messages' own
// RLS policy grants insert to anon.
import { test, expect } from "@playwright/test";
import { freshApp, gotoFresh, toShortlist, walkToServices, finishFlow, toListing } from "./helpers.mjs";

// CAS-1150 requeue: this fake client predates CAS-1056 (email OTP replaced the derived-password scheme)
// — signInWithPassword/signUp are no longer called by the app at all, and onAuthStateChange never stored
// or invoked its callback, so nothing here ever told the app a session had landed and #authModal.open
// could never clear (same fake-Supabase gap CAS-1073 found and fixed in its own copy; mirrored here).
const CAS978_FAKE_SUPABASE_GLOBAL = `
  window.__contactInserts = [];
  window.__contactShouldFail = false;
  let __cas978AuthChangeCb = null;
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
        onAuthStateChange: (cb) => { __cas978AuthChangeCb = cb; return { data: { subscription: { unsubscribe(){} } } }; },
        signInWithOtp: async () => ({ data: {}, error: null }),
        verifyOtp: async ({ email }) => {
          const session = { user: { id: "cas978-user", email }, access_token: "fake" };
          if(__cas978AuthChangeCb) __cas978AuthChangeCb("SIGNED_IN", session);
          return { data: { session }, error: null };
        },
        signOut: async () => ({ error: null }),
      },
      // CAS-1159 requeue: CAS-1099 added both of these RPC calls ahead of a new signup — this fixture
      // predates them and had no .rpc() at all. email_has_account() missing crashed membStart() synchronously
      // (client.rpc is not a function), leaving the button stuck on "Setting up your account…" forever
      // (idle() never ran); complete_membership() missing then surfaced as "Could not save your account" once
      // that was fixed, since an unhandled rpc() call resolved to {data:null}, which membCompleteNewMembership()
      // treats as neither 'created' nor 'account_exists'. Every caller here is a brand-new signup. Recording
      // the agents it was sent (window.__cas978Agents) is what let "cascades" below serve them straight back
      // out — fireAccountFanout()'s post-membership acctLoad() otherwise replaces the local, just-built
      // roster with whatever "cascades" answers, which was an empty table before this, wiping the roster the
      // listing needs to render anything at all.
      rpc: (fn, args) => {
        if(fn === "email_has_account") return Promise.resolve({ data: false, error: null });
        if(fn === "complete_membership"){
          window.__cas978Agents = (args && args.p && args.p.agents) || [];
          return Promise.resolve({ data: "created", error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      from: (table) => {
        if(table === "contact_messages") return { insert: (rows) => {
          if(window.__contactShouldFail) return Promise.resolve({ data: null, error: { message: "insert failed" } });
          window.__contactInserts.push(...rows);
          return Promise.resolve({ data: rows, error: null });
        } };
        if(table === "cascades") return { select: () => ({ order: () => ({ range: () =>
          Promise.resolve({ data: window.__cas978Agents || [], error: null }) }) }) };
        return chain();
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
    body: CAS978_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.enabled === true, null, { timeout: 5000 });
}

// CAS-1150 requeue: configuredApp above routes both config.js (a fake-but-real-looking URL) AND
// supabase-js.js (the fake client itself) BEFORE this runs — toShortlist()/freshAppSignedIn() (CAS-1110)
// would re-route config.js to a REAL local-stack URL (last-registered route wins) while leaving the fake
// supabase-js.js in place, so the page ends up pairing a real URL with a client that never talks to it.
// This is the signed-out, fake-client walk toShortlist() used to be before CAS-1110 made it always sign
// in for real — walkToServices() (helpers.mjs) is the same onboarding walk, written to work with whatever
// client is already on the page, which is exactly what these configuredApp() tests need.
async function toConfiguredShortlist(page, kind){
  await page.waitForFunction(() => flowOn === true || document.querySelector("#splashCta"));
  if(!(await page.evaluate(() => flowOn === true))) await page.locator("#splashCta").click();
  await walkToServices(page, kind);
}

// CAS-1159: CAS-1126 moved Feedback off the Account screen entirely — Account no longer carries any
// "Feedback form" row, so this shared setup (used by every AC below this point) now opens it the one way
// the app actually offers, via the Help screen's "Send feedback" row (the same route the test below this
// one already covers directly).
async function openFromAccount(page){
  await page.locator("#navMenuBtn").click();
  await page.locator(".navitem", { hasText: "Help" }).click();
  await expect(page.locator("#helpScreen")).toHaveClass(/open/);
  await page.locator(".urow", { hasText: "Send feedback" }).click();
  await expect(page.locator("#feedback")).toHaveClass(/open/);
}

// AC — reachable from the Help screen's "Send feedback" row (CAS-1126 retired the old Account row; this
// used to prove a second, independent entry point from Account, which no longer exists).
test("CAS-978: the Help screen 'Send feedback' row opens the sheet", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFromAccount(page);
});

// AC — also reachable from the Help screen footer.
test("CAS-978: the Help screen footer opens the same sheet", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await page.locator("#navMenuBtn").click();
  await page.locator(".navitem", { hasText: "Help" }).click();
  await expect(page.locator("#helpScreen")).toHaveClass(/open/);
  await page.locator(".urow", { hasText: "Send feedback" }).click();
  await expect(page.locator("#feedback")).toHaveClass(/open/);
});

// AC2 — category and message enforced client-side; Send stays disabled until all fields are valid.
test("CAS-978: Send is disabled until category, message and email are all valid", async ({ page }) => {
  await freshApp(page);
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFromAccount(page);
  await expect(page.locator("#feedbackSend")).toBeDisabled();
  await page.locator("#feedbackCatChips .chip", { hasText: "An idea" }).click();
  await expect(page.locator("#feedbackSend")).toBeDisabled();
  await page.locator("#feedbackMsg").fill("It would be nice if...");
  await expect(page.locator("#feedbackSend")).toBeDisabled();
  await page.locator("#feedbackEmail").fill("cas978@example.com");
  await expect(page.locator("#feedbackSend")).toBeEnabled();
});

// AC3 — signed out, the email field is required: filling everything else still leaves Send disabled
// with an empty email, and the field's error shows once a Send attempt has been made.
test("CAS-978: signed out, an empty email blocks Send and surfaces its own error", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFromAccount(page);
  await page.locator("#feedbackCatChips .chip", { hasText: "Something else" }).click();
  await page.locator("#feedbackMsg").fill("Just a note.");
  await expect(page.locator("#feedbackSend")).toBeDisabled();
  await page.locator("#feedbackEmail").click();
  await page.locator("#feedbackMsg").click();   // blur email empty
  await expect(page.locator("#feedbackEmailErr")).toBeVisible();
});

// AC2 — an over-length message is blocked and the counter turns red.
test("CAS-978: a message over 2000 characters turns the counter red and blocks Send", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFromAccount(page);
  await page.locator("#feedbackCatChips .chip", { hasText: "An idea" }).click();
  await page.locator("#feedbackEmail").fill("cas978@example.com");
  await page.locator("#feedbackMsg").fill("x".repeat(2001));
  await expect(page.locator("#feedbackMsgCount")).toHaveText("2001 / 2000");
  await expect(page.locator("#feedbackMsgCount")).toHaveCSS("color", "rgb(255, 185, 166)");
  await expect(page.locator("#feedbackSend")).toBeDisabled();
});

// AC4 — "Something's broken" shows the diagnostics switch, checked by default; sending inserts a row
// carrying a non-empty diagnostics string.
test("CAS-978: choosing Something's broken sends diagnostics by default", async ({ page }) => {
  await configuredApp(page);
  await toConfiguredShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFromAccount(page);
  await page.locator("#feedbackCatChips .chip", { hasText: "Something's broken" }).click();
  await expect(page.locator("#feedbackDiagSwitch")).toHaveClass(/on/);
  await page.locator("#feedbackEmail").fill("cas978@example.com");
  await page.locator("#feedbackMsg").fill("Something looks broken.");
  await page.locator("#feedbackSend").click();
  await page.waitForFunction(() => window.__contactInserts.length > 0, null, { timeout: 5000 });

  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows.length).toBe(1);
  expect(rows[0].category).toBe("broken");
  expect(typeof rows[0].diagnostics).toBe("string");
  expect(rows[0].diagnostics.length).toBeGreaterThan(0);
});

// AC4 — switching the diagnostics switch off means no diagnostics text reaches the row.
test("CAS-978: turning off Include diagnostics sends a null diagnostics field", async ({ page }) => {
  await configuredApp(page);
  await toConfiguredShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFromAccount(page);
  await page.locator("#feedbackCatChips .chip", { hasText: "Something's broken" }).click();
  await page.locator("#feedbackDiagSwitch").click();
  await expect(page.locator("#feedbackDiagSwitch")).not.toHaveClass(/on/);
  await page.locator("#feedbackEmail").fill("cas978@example.com");
  await page.locator("#feedbackMsg").fill("Something looks broken, no diagnostics please.");
  await page.locator("#feedbackSend").click();
  await page.waitForFunction(() => window.__contactInserts.length > 0, null, { timeout: 5000 });

  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows.length).toBe(1);
  expect(rows[0].diagnostics).toBeNull();
});

// AC — a category outside "Something's broken" never carries diagnostics, switch or not.
test("CAS-978: a non-broken category sends no diagnostics at all", async ({ page }) => {
  await configuredApp(page);
  await toConfiguredShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFromAccount(page);
  await page.locator("#feedbackCatChips .chip", { hasText: "A film is wrong or missing" }).click();
  await expect(page.locator("#feedbackDiagWrap")).toBeHidden();
  await page.locator("#feedbackEmail").fill("cas978@example.com");
  await page.locator("#feedbackMsg").fill("Wrong poster on this title.");
  // CAS-1159 requeue: same WebKit fill-then-click-swallow as #contact's Send (CAS-838/864/927's own .blur()
  // convention) — without the diagnostics switch block, the layout change leaves nothing to absorb it.
  await page.locator("#feedbackMsg").blur();
  await page.locator("#feedbackSend").click();
  await page.waitForFunction(() => window.__contactInserts.length > 0, null, { timeout: 5000 });

  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows[0].category).toBe("film");
  expect(rows[0].diagnostics).toBeNull();
});

// AC — success shows the receipt.
test("CAS-978: a successful send shows the receipt", async ({ page }) => {
  await configuredApp(page);
  await toConfiguredShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFromAccount(page);
  await page.locator("#feedbackCatChips .chip", { hasText: "Membership and billing" }).click();
  await page.locator("#feedbackEmail").fill("cas978@example.com");
  await page.locator("#feedbackMsg").fill("A billing question.");
  // CAS-1159 requeue: same WebKit fill-then-click-swallow as #contact's Send (CAS-838/864/927's own .blur()
  // convention) — without the diagnostics switch block, the layout change leaves nothing to absorb it.
  await page.locator("#feedbackMsg").blur();
  await page.locator("#feedbackSend").click();
  await expect(page.locator("#feedbackBody")).toContainText("Thanks — we read every one of these.");
});

// AC5/AC6 — a failed insert leaves the sheet open with the typed text intact and an error visible.
test("CAS-978: when the insert rejects, the typed message stays and an error is visible", async ({ page }) => {
  await configuredApp(page);
  await page.evaluate(() => { window.__contactShouldFail = true; });
  await toConfiguredShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFromAccount(page);
  await page.locator("#feedbackCatChips .chip", { hasText: "An idea" }).click();
  await page.locator("#feedbackEmail").fill("cas978@example.com");
  await page.locator("#feedbackMsg").fill("This should fail to send.");
  // CAS-1159 requeue: same WebKit fill-then-click-swallow as #contact's Send (CAS-838/864/927's own .blur()
  // convention) — without the diagnostics switch block, the layout change leaves nothing to absorb it.
  await page.locator("#feedbackMsg").blur();
  await page.locator("#feedbackSend").click();

  await expect(page.locator("#feedbackErr")).toBeVisible();
  await expect(page.locator("#feedbackMsg")).toHaveValue("This should fail to send.");
  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows.length).toBe(0);
});

// AC — the honeypot silently drops the submission, same convention as #contact's.
test("CAS-978: filling the honeypot and sending performs no insert at all", async ({ page }) => {
  await configuredApp(page);
  await toConfiguredShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFromAccount(page);
  await page.locator("#feedbackCatChips .chip", { hasText: "An idea" }).click();
  await page.locator("#feedbackEmail").fill("cas978@example.com");
  await page.locator("#feedbackMsg").fill("Ignore me, I'm a bot.");
  await page.evaluate(() => { document.getElementById("feedbackHp").value = "http://spam.example"; });
  await page.locator("#feedbackSend").click();
  await page.waitForTimeout(300);

  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows.length).toBe(0);
});

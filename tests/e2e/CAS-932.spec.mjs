// CAS-932: "Choose from contacts" on CAS-928's "Add someone" form. Native-only — the system contact
// picker (Capacitor.Plugins.ContactPicker, see capacitor-contact-picker.js and
// ios/App/App/Plugins/ContactPicker.swift) is unreachable from a Playwright web run, so these stand in
// for the native plugin with an injected Capacitor.Plugins.ContactPicker.pickContact() stub, the same
// technique CAS-969's spec uses for Capacitor.Plugins.InAppReview. The friends fixture / fake Supabase
// client is CAS-928.spec.mjs's own bootSignedIn recipe, trimmed to what this ticket needs.
import { test, expect } from "@playwright/test";
import { bootAlreadySignedIn } from "./helpers.mjs";

const SEEDED_CASCADE = { id: "932aaaa1-0000-4000-8000-000000000001", user_id: "cas932-user",
  name: "Existing agent", criteria: {}, created_at: "2020-01-01T00:00:00.000Z" };

function fakeSupabaseScript(){
  return `
    window.__friendInserts = [];
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
          getSession: () => new Promise(resolve => { window.__cas932ResolveSession = () => resolve({ data: { session: {
            user: { id: "cas932-user", email: "cas932@example.com" }, access_token: "fake" } } }); }),
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
          // loadFriends() reads this table directly (no acctLoad), so a bare .order() resolving is correct.
          if(table === "friends") return {
            select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
            insert: (rows) => ({ select: () => ({ single: () => {
              const row = { id: 900 + window.__friendInserts.length + 1, ...rows[0] };
              window.__friendInserts.push(row);
              return Promise.resolve({ data: row, error: null });
            } }) }),
          };
          return chain();
        },
      };
    } };
  `;
}

/** CAS-1160: an addInitScript-set window.Capacitor runs before any page script, but the real (vendored)
 * capacitor-core.js loads straight after it and unconditionally recomputes isNativePlatform from actual
 * bridge detection — always "web" in a Playwright browser — clobbering whatever addInitScript had set, the
 * same gap CAS-969's own primeNativeReviewStub was written to dodge for Capacitor.Plugins.InAppReview.
 * Setting isNativePlatform/Plugins.ContactPicker via page.evaluate AFTER boot (capacitor-core.js and
 * capacitor-contact-picker.js have already run by then) is what actually makes `native` stick. */
async function primeCapacitor(page, native, pickResult){
  await page.evaluate(({ native, pickResult }) => {
    window.Capacitor.isNativePlatform = () => native;
    if(native) window.Capacitor.Plugins.ContactPicker = { pickContact: () => Promise.resolve(pickResult) };
  }, { native, pickResult });
}

/** CAS-1084: thin adapter over helpers.mjs's shared bootAlreadySignedIn — same recipe as CAS-928's own
 * bootSignedIn, trimmed to this spec's single (empty) friends fixture. */
async function bootSignedIn(page){
  await bootAlreadySignedIn(page, {
    supabaseScript: fakeSupabaseScript(),
    resolveFnName: "__cas932ResolveSession",
    readyFlagExpr: "typeof friendsReady !== 'undefined' && friendsReady === true",
  });
}

async function openAddForm(page){
  await page.evaluate(() => openFriendsScreen());
  await page.locator('#friendsBody button:has-text("Add someone")').click();
}

test("CAS-932: on the web surface (isNativePlatform false) the form shows no contacts control, unchanged from CAS-928", async ({ page }) => {
  await bootSignedIn(page);
  await primeCapacitor(page, false, undefined);
  await openAddForm(page);

  await expect(page.locator("#ffContactsPick")).toHaveCount(0);
  await expect(page.locator("#ffName")).toHaveValue("");
  await expect(page.locator("#ffEmail")).toHaveValue("");
  await expect(page.locator("#ffMobile")).toHaveValue("");
});

test("CAS-932: picking a contact with two emails and one number fills the form with the first of each, and saves only on Save", async ({ page }) => {
  await bootSignedIn(page);
  await primeCapacitor(page, true, { name: "Jamie Fox", emails: ["jamie@work.example.com", "jamie@personal.example.com"], phones: ["0455123456"] });
  await openAddForm(page);

  await expect(page.locator("#ffContactsPick")).toBeVisible();
  await page.locator("#ffContactsPick").click();

  await expect(page.locator("#ffName")).toHaveValue("Jamie Fox");
  await expect(page.locator("#ffEmail")).toHaveValue("jamie@work.example.com");
  await expect(page.locator("#ffMobile")).toHaveValue("0455123456");
  expect(await page.evaluate(() => window.__friendInserts.length)).toBe(0);

  await page.locator('#friendsBody button:has-text("Add and select")').click();
  await page.waitForFunction(() => window.__friendInserts.length > 0, null, { timeout: 5000 });
  const inserts = await page.evaluate(() => window.__friendInserts);
  expect(inserts[0].name).toBe("Jamie Fox");
  expect(inserts[0].email).toBe("jamie@work.example.com");
  expect(inserts[0].mobile).toBe("0455123456");
});

test("CAS-932: a cancelled pick leaves the form untouched and shows no error", async ({ page }) => {
  await bootSignedIn(page);
  await primeCapacitor(page, true, { cancelled: true });
  await openAddForm(page);

  await page.locator("#ffContactsPick").click();
  await page.waitForTimeout(100);

  await expect(page.locator("#ffName")).toHaveValue("");
  await expect(page.locator("#ffEmail")).toHaveValue("");
  await expect(page.locator("#ffMobile")).toHaveValue("");
  await expect(page.locator("#ffErr")).toBeHidden();
  expect(await page.evaluate(() => window.__friendInserts.length)).toBe(0);
});

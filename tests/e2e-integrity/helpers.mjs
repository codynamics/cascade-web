// CAS-1093: shared driving for tests/e2e-integrity/*.spec.mjs — this suite runs against a REAL local
// Supabase stack (scripts/test-integrity.mjs starts it), never the live project. Every helper here that
// touches the database goes through the service_role client (`admin`, below), bypassing RLS the same way
// tests/rls/matrix.mjs's anon-role probing does from the other side — test setup and assertion, never
// shipped to the browser.
import { expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.CASCADE_INTEGRITY_SUPABASE_URL;
const ANON_KEY = process.env.CASCADE_INTEGRITY_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.CASCADE_INTEGRITY_SUPABASE_SERVICE_ROLE_KEY;

for(const [name, value] of Object.entries({
  CASCADE_INTEGRITY_SUPABASE_URL: SUPABASE_URL,
  CASCADE_INTEGRITY_SUPABASE_ANON_KEY: ANON_KEY,
  CASCADE_INTEGRITY_SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
})){
  if(!value) throw new Error(`${name} is not set — run this suite via "npm run test:integrity", not Playwright directly`);
}

/** service_role client — test setup/assertions only, bypasses RLS. Never routed into the page. */
export const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let seq = 0;
/** A fresh, never-reused test email per call, namespaced to this run. */
export function testEmail(tag){
  seq += 1;
  return `cas1093-${tag}-${Date.now()}-${seq}@integrity.test`;
}

/** A confirmed test user, created directly via the local admin API — no email round trip needed. */
export async function createTestUser(email){
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if(error) throw new Error(`createTestUser(${email}) failed: ${error.message}`);
  return data.user;
}

/** Seed cascades rows straight into the account, bypassing onboarding entirely — S1 (onboarding
 * committing its own roster through complete_membership) is out of scope until CAS-1098/CAS-1099 land. */
export async function seedCascades(userId, rows){
  const { data, error } = await admin.from("cascades").insert(
    rows.map(r => ({ user_id: userId, name: r.name, criteria: r.criteria || {}, active: true }))
  ).select();
  if(error) throw new Error(`seedCascades failed: ${error.message}`);
  return data;
}

/** Every non-soft-deleted cascades row currently on the server for this account. */
export async function liveCascades(userId){
  const { data, error } = await admin.from("cascades")
    .select("id,name,updated_at,deleted_at")
    .eq("user_id", userId)
    .is("deleted_at", null);
  if(error) throw new Error(`liveCascades failed: ${error.message}`);
  return data;
}

/** The notify_prefs row currently on the server for this account, or null if none exists yet. */
export async function liveNotifyPrefs(userId){
  const { data, error } = await admin.from("notify_prefs")
    .select("in_app,email_on,email_address")
    .eq("user_id", userId)
    .maybeSingle();
  if(error) throw new Error(`liveNotifyPrefs failed: ${error.message}`);
  return data;
}

/** The one-time code a real sign-in would have emailed — fetched via the admin API instead of standing up
 * a mail-capture dependency this suite has no other use for. */
export async function fetchOtp(email){
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if(error) throw new Error(`generateLink(${email}) failed: ${error.message}`);
  const code = data && data.properties && data.properties.email_otp;
  if(!code) throw new Error(`generateLink(${email}) returned no email_otp`);
  return code;
}

/** Route config.js at the LOCAL stack instead of production — the one test-only config injection point
 * the ticket asks for; never the real project.js this script never touches (config.js on disk carries the
 * live keys, untouched). Then a fresh boot with nothing remembered, same shape as tests/e2e/helpers.mjs's
 * own freshApp(), which 404s config.js instead for the guest-mode smoke suite. */
export async function gotoIntegrityFresh(page){
  await page.route("**/config.js", route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: ${JSON.stringify(SUPABASE_URL)}, SUPABASE_ANON_KEY: ${JSON.stringify(ANON_KEY)} };`,
  }));
  await page.goto("/index.html");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html");
  // MOVIES/flowStart are top-level lexical bindings, not window properties — see tests/e2e/helpers.mjs's
  // own gotoFresh() for why this waits on the bare names rather than window.*.
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  return page;
}

/** Sign in from the front door (CAS-186's #splashLogin) — the door a RETURNING/existing account uses.
 * Deliberately not onboarding's own membScreen path (tests/e2e/helpers.mjs's toListing()), which is for a
 * brand new device with no account yet (S1, out of scope here). */
export async function signInFromSplash(page, email){
  await page.locator("#splashLogin").click();
  await expect(page.locator("#authSignedOut")).toBeVisible();
  await page.locator("#authEmail").fill(email);
  await page.locator("#authContinue").click();
  await expect(page.locator("#authVerify")).toBeVisible({ timeout: 30_000 });
  const code = await fetchOtp(email);
  await page.locator("#authCode").fill(code);
  await page.locator("#authVerifyBtn").click();
  await expect(page.locator("#authModal.open")).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.CascadeAuth.status), { timeout: 30_000 }).toBe("signed-in");
}

/** Sign out through the real Account-screen control — S3 exists specifically because a sign-out/sign-in
 * cycle on the SAME context is the 2026-09-30 incident's exact shape, so this has to be a real sign-out,
 * not a state reset. */
export async function signOutFromAccount(page){
  await page.evaluate(() => window.openAccountAuth());
  await expect(page.locator("#authSignedIn")).toBeVisible();
  // CAS-1100: the sign-out button confirms first ("Some changes haven't saved yet. Sign out anyway?") if the
  // acctOp queue still owes a write — e.g. a background agent_films admission push still in flight. Playwright
  // auto-dismisses an unhandled dialog, which would read as "no, stay signed in" and hang this forever, so
  // accept it the way a tester who already clicked Sign out would.
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#authSignOut").click();
  await expect.poll(() => page.evaluate(() => window.CascadeAuth.status), { timeout: 15_000 }).toBe("signed-out");
}

/** An authenticated supabase-js client for one real test user, with no browser involved — S13 (CAS-1102)
 * asserts on a database TRIGGER, not app behaviour, so it drives the same anon-key REST path the app's own
 * client uses (verifyOtp with type:'email', matching app_template.html's own call) directly rather than
 * through a page. Never routed into a browser context. */
export async function signInDirect(email){
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const code = await fetchOtp(email);
  const { error } = await client.auth.verifyOtp({ email, token: code, type: "email" });
  if(error) throw new Error(`signInDirect(${email}) failed: ${error.message}`);
  return client;
}

/** The real email_has_account(p_email) RPC, called the same way the app itself does — anon key, no
 * session — rather than through the service_role `admin` client, which the migration never grants EXECUTE
 * on this function to. */
export async function emailHasAccount(email){
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.rpc("email_has_account", { p_email: email });
  if(error) throw new Error(`email_has_account(${email}) failed: ${error.message}`);
  return data;
}

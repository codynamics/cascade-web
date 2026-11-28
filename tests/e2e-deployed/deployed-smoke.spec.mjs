// CAS-1574: the real-user check. One person, on the DEPLOYED site, against that environment's real database and
// real email: sign up with a promo code, read the six-digit code from the real email, do first-run setup, use the
// core features once each, sign out, sign back in, and see the same things. Then delete the account.
//
// Inputs (env): DEPLOYED_URL, DEPLOYED_ENV (staging), EXPECTED_COMMIT, QA_EMAIL, PROMO_CODE,
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (clean-up; and the degraded code fallback when the mailbox is not set up),
//   MS_TENANT_ID + MS_CLIENT_ID + MS_CLIENT_SECRET + MS_MAILBOX (read the real email via Microsoft Graph).
// Missing MS_* secrets: the email checks are reported Blocked (not Fail) and the rest still runs, with the code taken
// through the admin API instead. smoke-result.json records which.
//
// Keep this spec current: any ticket that changes sign-up, onboarding, first-run setup or the features in step 5
// below updates it in the same commit (see README.md).
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const URL_ = (process.env.DEPLOYED_URL || "https://cascade-web-3x1.pages.dev/").replace(/\/?$/, "/");
const ENV_ = process.env.DEPLOYED_ENV || "staging";
const EXPECTED_COMMIT = (process.env.EXPECTED_COMMIT || "").trim();
const QA_EMAIL = process.env.QA_EMAIL || "lee+CascadeQA@codynamics.com.au";
const PROMO = process.env.PROMO_CODE || "CASCADEFRIENDS";
const SENDER = { staging: "Cascade Staging", production: "Cascade" }[ENV_];
const FROM_ADDR = "alerts@cascademovies.com";
const MS = ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET"];
const missingMs = MS.filter(k => !process.env[k]);
const emailBlocked = missingMs.length > 0;
const MAILBOX = process.env.MS_MAILBOX || "lee@codynamics.com.au";
const results = { env: ENV_, url: URL_, emailBlocked, missingSecrets: missingMs, emailChecks: "not run", steps: [] };

function step(name){ results.steps.push(name); console.log(`[smoke] ${name}`); }
function finish(){ try{ writeFileSync("smoke-result.json", JSON.stringify(results, null, 1)); }catch(e){} }

function admin(){
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (GitHub environment secrets) are needed to clean up the test account");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Delete the QA account (and what it created) if it exists. Runs before and after the run. */
async function cleanUp(){
  const a = admin();
  for(let p = 1; p <= 20; p++){
    const { data, error } = await a.auth.admin.listUsers({ page: p, perPage: 200 });
    if(error) throw new Error(`clean-up: listUsers failed: ${error.message}`);
    const u = data.users.find(x => (x.email || "").toLowerCase() === QA_EMAIL.toLowerCase());
    if(u){
      const del = await a.auth.admin.deleteUser(u.id);
      if(del.error) throw new Error(`clean-up: deleteUser failed: ${del.error.message}`);
      return true;
    }
    if(data.users.length < 200) break;
  }
  return false;
}

async function graphToken(){
  const body = new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  const r = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, { method: "POST", body });
  if(!r.ok) throw new Error(`Microsoft Graph token request failed (${r.status}) - check MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET`);
  return (await r.json()).access_token;
}

/** Wait up to 2 minutes for the sign-in email to QA_EMAIL received after `since`. Reads nothing else; logs only the subject. */
async function readSignInEmail(since){
  const token = await graphToken();
  const deadline = Date.now() + 2 * 60_000;
  const sinceIso = new Date(since - 5_000).toISOString();
  while(Date.now() < deadline){
    const q = `$filter=receivedDateTime ge ${sinceIso}&$orderby=receivedDateTime desc&$top=25&$select=subject,from,toRecipients,receivedDateTime,body`;
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages?${q}`,
      { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' } });
    if(!r.ok) throw new Error(`Microsoft Graph mailbox read failed (${r.status}) - check the Mail.Read permission and the application access policy`);
    const msg = (await r.json()).value.find(m => (m.toRecipients || []).some(t => (t.emailAddress.address || "").toLowerCase() === QA_EMAIL.toLowerCase()));
    if(msg) return msg;
    await new Promise(res => setTimeout(res, 5_000));
  }
  throw new Error(`EMAIL: no sign-in email reached ${QA_EMAIL} within 2 minutes of asking for the code`);
}

function checkEmail(msg){
  const addr = (msg.from && msg.from.emailAddress) || {};
  console.log(`[smoke] email subject: ${msg.subject}`);
  expect(addr.address && addr.address.toLowerCase(), `EMAIL: sender address was ${addr.address}, expected ${FROM_ADDR}`).toBe(FROM_ADDR);
  expect(addr.name, `EMAIL: sender name was "${addr.name}", expected "${SENDER}"`).toBe(SENDER);
  const m = /^(\d{6}) is your Cascade sign-in code$/.exec(msg.subject || "");
  expect(m, `EMAIL: subject was "${msg.subject}", expected "<six digits> is your Cascade sign-in code"`).not.toBeNull();
  const body = (msg.body && msg.body.content) || "";
  expect(body.includes(m[1]), "EMAIL: the body does not contain the code from the subject").toBe(true);
  expect(/https?:\/\/\S*(confirm|verify|token|auth\/v1)/i.test(body),
    "EMAIL: the body holds a confirmation link - the site sent a confirm-your-email link instead of a code").toBe(false);
  return m[1];
}

async function fallbackCode(){
  // DEGRADED (mailbox secrets missing): the admin API mints a code, which skips the email system. Email checks are Blocked.
  const a = admin();
  const { data, error } = await a.auth.admin.generateLink({ type: "magiclink", email: QA_EMAIL });
  if(error) throw new Error(`fallback code failed: ${error.message}`);
  return data.properties.email_otp;
}

const watchBusy = page => page.evaluate(() => document.querySelectorAll("#groups .card, #groups .stub").length);

test("real user on the deployed site", async ({ page }) => {
  const problems = [];
  const ownHost = new URL(URL_).host;
  let supaHost = "";
  try{ supaHost = new URL(process.env.SUPABASE_URL || "").host; }catch(e){}
  const mine = u => { try{ const h = new URL(u).host; return h === ownHost || (supaHost && h === supaHost); }catch(e){ return false; } };
  page.on("console", m => { if(m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`console error: ${m.text().slice(0, 200)}`); });
  page.on("pageerror", e => problems.push(`page error: ${String(e).slice(0, 200)}`));
  page.on("requestfailed", r => { const t = (r.failure() || {}).errorText || ""; if(mine(r.url()) && !/ERR_ABORTED|cancelled/i.test(t)) problems.push(`request failed: ${r.method()} ${new URL(r.url()).pathname} ${t}`); });
  page.on("response", r => { if(mine(r.url()) && r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${new URL(r.url()).pathname}`); });

  step("0 clean up any earlier test account");
  await cleanUp();
  try{
    // 1. wait for the deploy to serve this commit
    step(`1 wait for ${URL_} to serve commit ${EXPECTED_COMMIT || "(any)"}`);
    if(EXPECTED_COMMIT){
      const deadline = Date.now() + 15 * 60_000;
      let seen = "";
      const ok = () => seen && (EXPECTED_COMMIT.startsWith(seen) || seen.startsWith(EXPECTED_COMMIT));
      while(Date.now() < deadline){
        try{
          // version.json is where deployed-smoke.yml takes EXPECTED_COMMIT from; build-info.js can carry a different stamp.
          const r = await fetch(`${URL_}version.json?t=${Date.now()}`, { cache: "no-store" });
          const m = /commit["']?\s*:\s*["']([0-9a-f]{7,40})["']/.exec(await r.text());
          seen = m ? m[1] : "";
          if(ok()) break;
        }catch(e){}
        await new Promise(res => setTimeout(res, 15_000));
      }
      expect(ok(), `DEPLOY: ${URL_} still serves commit "${seen || "unknown"}" after 15 minutes, expected ${EXPECTED_COMMIT}`).toBeTruthy();
    }

    // 2. environment
    await page.goto(URL_);
    await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES), null, { timeout: 60_000 });
    step("2 confirm the environment");
    const env = await page.evaluate(() => window.CASCADE_CONFIG && window.CASCADE_CONFIG.ENV);
    expect(env, `ENV: CASCADE_CONFIG.ENV is "${env}", expected "${ENV_}" - the site is pointed at the wrong environment`).toBe(ENV_);
    const dbUp = await page.evaluate(() => !!(window.CascadeAuth && window.CascadeAuth.enabled));
    expect(dbUp, "DATABASE: the site has no working database connection (CascadeAuth is not enabled)").toBe(true);

    // 3 + 4. first-run setup as a new person
    step("3 first-run questions and the first agent");
    await page.waitForFunction(() => document.querySelector("#oafScreen.open") || document.querySelector("#splashCta"));
    if(!(await page.evaluate(() => !!document.querySelector("#oafScreen.open")))){
      try{ await page.locator("#splashCta").click({ timeout: 5000 }); }
      catch(e){ if(!(await page.evaluate(() => !!document.querySelector("#oafScreen.open")))) throw e; }
    }
    const cta = page.locator("#oafCta");
    await expect(page.locator("#oafInner .osh")).toContainText("Let's get you set up.");
    await cta.click();
    await expect(page.locator("#oafInner .osh")).toHaveText("Who watches movies with you?");
    await page.locator('.whopill[data-field="age"][data-val="18plus"]').click();
    await cta.click();
    await expect(page.locator("#oafSvcStores")).toBeVisible();
    for(let i = 0; i < 20; i++){
      if(!(await page.evaluate(() => !!document.querySelector("#oafScreen.open")))) break;
      const st = await page.evaluate(() => oafStep).catch(() => null);
      if(st === "favourites" && await page.evaluate(() => oafFavCount() === 0)) await page.locator("#oafFavGrid .favcell .favtoggle").first().click();
      else if(st === "topSvc") await page.locator("#oafTopSvcOpts .chip").first().click();
      await cta.click();
      await page.waitForTimeout(150);
    }
    await expect(page.locator("#membScreen.open")).toBeVisible();

    // sign-up: email, promo code, then the code from the real email
    step("3a sign up with email and promo code");
    await page.locator("#membEmail").fill(QA_EMAIL);
    await page.locator("#membPromoLink").click();
    await page.locator("#membPromoCode").fill(PROMO);
    const started = Date.now();
    await page.locator(".membcta").click();
    await expect(page.locator("#membCode"), "SIGNUP: no code box appeared - the site could not send a sign-in code").toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#membPromoErr"), "SIGNUP: the promo code was not accepted").toBeHidden();
    expect(await page.evaluate(() => window.CascadeAuth.status)).not.toBe("signed-in");

    let code;
    if(emailBlocked){
      console.log(`[smoke] BLOCKED: email checks skipped, missing secrets: ${missingMs.join(", ")}`);
      results.emailChecks = "Blocked";
      code = await fallbackCode();
    } else {
      step("3b read and check the real sign-in email");
      code = checkEmail(await readSignInEmail(started));
      results.emailChecks = "Pass";
    }
    await page.locator("#membCode").fill(code);
    await page.locator(".membcta").click();
    await expect(page.locator("#membScreen.open"), "SIGNUP: the code was entered but the app did not open").toBeHidden({ timeout: 60_000 });
    expect(await page.evaluate(() => window.CascadeAuth.status)).toBe("signed-in");

    // reach Watch with films showing
    step("4 reach Watch with films showing");
    await page.waitForFunction(() => document.querySelectorAll("#groups .card, #groups .stub").length > 0, null, { timeout: 60_000 });
    if(await page.locator("#tutScrim.open").count() === 0){
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    if(await page.locator("#tutScrim.open").count() > 0){
      await page.locator("#tutSkipBtn").click();
      if(await page.locator("#tutScrim.open").count() > 0) await page.locator("#tutNextBtn").click();
      await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);
    }
    expect(await page.locator("#groups .card").count(), "WATCH: Watch shows no films after sign-up").toBeGreaterThan(0);
    const listsBefore = await page.evaluate(() => cascades.map(c => c.name).join("|"));
    expect(listsBefore.length, "LISTS: the new account has no list/agent").toBeGreaterThan(0);

    // 5. core features, through the interface only
    step("5 open a film, rate it, change an alert setting");
    const first = page.locator("#groups .card").first();
    await first.locator(".titletext").first().click();
    if(await page.locator("#filmPage.open").count() > 0){
      await page.locator("#filmPage .fpclose button").first().click();
      await expect(page.locator("#filmPage")).not.toHaveClass(/open/);
    }
    await expect(first.locator(".ctl.watch"), "FILM: the film card did not stay usable after opening it").toBeVisible();
    await first.locator(".ctl.watch").click();
    const options = page.locator(".cpop .cseg .cl");
    await expect(options.first()).toBeVisible();
    await options.first().click();
    await expect.poll(() => page.evaluate(() => watched.size), { timeout: 15_000 }).toBeGreaterThan(0);
    const watchedBefore = await page.evaluate(() => watched.size);

    await page.locator("#navMenuBtn").click();
    await page.locator("#navMenu .navitem", { hasText: "Settings" }).click();
    await page.locator("#settingsScreen .urow", { hasText: "Notification Settings" }).click();
    const inAppBefore = await page.evaluate(() => notifyPrefs.inApp);
    await page.locator("#notifyScreen .bigtoggle", { hasText: "Allow in-app notifications" }).click();
    await expect.poll(() => page.evaluate(() => notifyPrefs.inApp)).toBe(!inAppBefore);
    await page.waitForTimeout(3_000);   // let the change reach the database before signing out
    await page.locator("#notifyScreen .osback").click();
    await page.locator("#settingsScreen .osback").click();

    // sign out, sign back in
    step("5b sign out, sign back in");
    await page.locator("#navMenuBtn").click();
    await page.locator("#navMenu .navitem", { hasText: "Account" }).click();
    await page.locator(".urow", { has: page.locator(".ut", { hasText: "Signed in" }) }).click();
    await expect(page.locator("#authModal")).toHaveClass(/open/);
    await page.locator("#authSignOut").click();
    await expect(page.locator("#splash")).toHaveClass(/open/);

    const signInStart = Date.now();
    await page.locator("#splashLogin").click();
    await page.locator("#authEmail").fill(QA_EMAIL);
    await page.locator("#authContinue").click();
    await expect(page.locator("#authCode"), "SIGNIN: no code box appeared when signing back in").toBeVisible({ timeout: 60_000 });
    const code2 = emailBlocked ? await fallbackCode() : checkEmail(await readSignInEmail(signInStart));
    await page.locator("#authCode").fill(code2);
    await page.locator("#authVerifyBtn").click();
    await page.waitForFunction(() => window.CascadeAuth.status === "signed-in", null, { timeout: 60_000 });
    if(await page.locator("#authModal.open").count() > 0 && await page.locator("#authDone").count() > 0) await page.locator("#authDone").click().catch(() => {});
    await expect.poll(() => watchBusy(page), { timeout: 60_000 }).toBeGreaterThan(0);

    step("5c same lists, rating and setting after signing back in");
    expect(await page.evaluate(() => cascades.map(c => c.name).join("|")), "PERSIST: lists differ after signing back in").toBe(listsBefore);
    await expect.poll(() => page.evaluate(() => watched.size), { message: "PERSIST: the rating did not survive sign-out/in", timeout: 30_000 }).toBe(watchedBefore);
    expect(await page.evaluate(() => notifyPrefs.inApp), "PERSIST: the alert setting did not survive sign-out/in").toBe(!inAppBefore);

    // 6. no console errors or failed requests to our own hosts
    step("6 no console errors or failed requests");
    expect(problems, `ERRORS on the deployed site:\n${problems.join("\n")}`).toEqual([]);
  } finally {
    // 7. clean up
    step("7 delete the test account");
    try{ await cleanUp(); }catch(e){ console.log(`[smoke] clean-up failed: ${e.message}`); results.cleanupError = e.message; }
    finish();
  }
});

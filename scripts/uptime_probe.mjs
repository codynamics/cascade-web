#!/usr/bin/env node
// CAS-975: hourly synthetic monitoring — is the site up, does the catalogue parse, can a real
// person sign in. The nightly checks (CAS-974) cover the pipeline; this covers the other 23
// hours, where a Pages/Cloudflare/Supabase outage was previously invisible until a user
// complained.
//
// Nine independent probes: site_up, movies_json, supabase_canary, signup, usage_events_insert,
// pages_head, orphan_probe_accounts, and (CAS-995) two dead-man checks — daily_refresh_fresh (has
// daily.yml actually landed a commit in the last 30h) and alerts_ran (has alerts.yml completed
// successfully in the last 30h) — so a dropped schedule or disabled Action is caught even though
// nothing "failed". Each is split into a `probeX()` (real network I/O) and a `checkX()` (pure
// pass/fail decision over the probe's result) — the same split monitor/health.py uses — so the
// decision logic is unit-testable without a network.
//
// Flap control: a single red probe must not page anyone, EXCEPT the three checks in
// FAST_ALERT_CHECKS (site_up, movies_json, daily_refresh_fresh) — an outage or a silently
// stopped daily refresh is worth knowing about immediately, not after a second confirming red.
// Every other probe still needs two consecutive reds. `state/uptime.json` (committed by the
// workflow) carries the running `consecutiveReds` count, the last alert time, and which
// fast-alert checks were red last run (`fastRedNames`, so re-alerting is edge-triggered on a
// check NEWLY going red, not every hour it stays red); decideAlerting() is the whole state
// machine. The first green after any red always sends a recovery so a red is never left open.
// Never more than one alert per hour (a `lastAlertAt` cooldown, belt-and-braces alongside the
// hourly cron cadence itself).
//
// CAS-995: every alert/recovery is ALSO sent as an APNs push (to the device tokens of the
// Supabase account whose email equals CASCADE_ALERT_TO), independently of the Resend email — a
// Resend outage must not silence the push, and a push misconfiguration must not silence the
// email.
//
// The signup probe follows its own contingency clause: CAS-980 (the delete_my_account RPC) has
// not shipped yet (no such function in supabase/schema.sql at the time this was written), so
// rather than guess at a second deletion mechanism, this probe always ATTEMPTS the real
// delete_my_account RPC after creating the throwaway account, and treats "function does not
// exist" as expected-for-now: it leaves the account in place and reports the running count of
// accounts still pending removal. Once CAS-980 ships, the same code path starts removing them for
// real with no change needed here.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_FILE = path.join(ROOT, "state", "uptime.json");

const SITE_URL = (process.env.CASCADE_SITE_URL || "https://cascademovies.com").replace(/\/$/, "");
const MOVIES_JSON_URL = process.env.CASCADE_MOVIES_JSON_URL || `${SITE_URL}/movies.json`;
const PAGES_URL = process.env.CASCADE_PAGES_URL || "https://cascade-web-3x1.pages.dev/";
const MAIN_VERSION = (process.env.CASCADE_MAIN_VERSION || "").trim() || null;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const CANARY_EMAIL = process.env.CASCADE_CANARY_EMAIL;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.CASCADE_EMAIL_FROM || "Cascade <onboarding@resend.dev>";
const ALERT_TO = process.env.CASCADE_ALERT_TO;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || "codynamics/cascade-web";
const GITHUB_API = "https://api.github.com";

const APNS_KEY_ID = process.env.APNS_KEY_ID;
const APNS_TEAM_ID = process.env.APNS_TEAM_ID;
const APNS_AUTH_KEY = process.env.APNS_AUTH_KEY;      // base64-encoded .p8 contents
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const CATALOGUE_MIN = 5500;
const ONE_HOUR_MS = 60 * 60 * 1000;
const THIRTY_HOURS_MS = 30 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const DAILY_REFRESH_COMMIT_PREFIX = "Daily refresh ";
const ALERTS_WORKFLOW_FILE = "alerts.yml";

function withTimeout(opts = {}) {
  return { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
}

// CAS-995: the exact env var names among `pairs` (name, value) whose value is falsy — used to
// build the "not configured: <NAME>" detail a credential-gated probe reports instead of a vaguer
// "not all set" list, so health.py and this script name a missing secret the same way.
function missingNames(...pairs) {
  return pairs.filter(([, value]) => !value).map(([name]) => name);
}

// ---------------------------------------------------------------------------
// site_up
// ---------------------------------------------------------------------------
export function parseBuildInfoVersion(text) {
  const m = /window\.BUILD_INFO\s*=\s*(\{[\s\S]*?\})\s*;/.exec(text || "");
  if (!m) return null;
  try { return JSON.parse(m[1]).version || null; } catch { return null; }
}

export async function probeSiteUp(fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(SITE_URL, withTimeout());
  } catch (err) {
    return { ok: false, detail: `GET ${SITE_URL} -> ${err && err.message || err}` };
  }
  if (!res.ok) return { ok: false, detail: `GET ${SITE_URL} -> HTTP ${res.status}` };
  try {
    const biRes = await fetchImpl(`${SITE_URL}/build-info.js`, withTimeout());
    if (!biRes.ok) return { ok: true, status: res.status, buildInfoError: `build-info.js -> HTTP ${biRes.status}` };
    const version = parseBuildInfoVersion(await biRes.text());
    return { ok: true, status: res.status, version };
  } catch (err) {
    return { ok: true, status: res.status, buildInfoError: `build-info.js -> ${err && err.message || err}` };
  }
}

export function checkSiteUp(probe, expectedVersion) {
  if (!probe.ok) return { ok: false, detail: probe.detail || "site unreachable" };
  if (probe.buildInfoError) return { ok: false, detail: `build-info.js unreachable: ${probe.buildInfoError}` };
  if (!probe.version) return { ok: false, detail: "build-info.js did not carry a BUILD_INFO.version" };
  if (expectedVersion && probe.version !== expectedVersion) {
    return { ok: false, detail: `live version ${probe.version} does not match main's VERSION ${expectedVersion}` };
  }
  return { ok: true, detail: `HTTP ${probe.status}, version ${probe.version}` };
}

// ---------------------------------------------------------------------------
// movies_json
// ---------------------------------------------------------------------------
export async function probeMoviesJson(fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(MOVIES_JSON_URL, withTimeout());
  } catch (err) {
    return { ok: false, detail: `GET ${MOVIES_JSON_URL} -> ${err && err.message || err}` };
  }
  if (!res.ok) return { ok: false, detail: `GET ${MOVIES_JSON_URL} -> HTTP ${res.status}` };
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (err) {
    return { ok: false, detail: `movies.json did not parse: ${err.message}` };
  }
  const movies = Array.isArray(data) ? data : data.movies;
  if (!Array.isArray(movies)) return { ok: false, detail: "movies.json parsed but carried no movies array" };
  return { ok: true, count: movies.length };
}

export function checkMoviesJson(probe) {
  if (!probe.ok) return { ok: false, detail: probe.detail || "movies.json unreachable" };
  if (probe.count < CATALOGUE_MIN) {
    return { ok: false, detail: `${probe.count} record(s) — below the ${CATALOGUE_MIN}-record floor` };
  }
  return { ok: true, detail: `${probe.count} record(s), parses.` };
}

// ---------------------------------------------------------------------------
// supabase_canary — sign in, agents (cascades) + agent_films non-empty, film_watch read succeeds
// ---------------------------------------------------------------------------
async function supabaseFetch(fetchImpl, pathAndQuery, { method = "GET", token, body, prefer, serviceRole } = {}) {
  const headers = { apikey: serviceRole ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY, "Content-Type": "application/json" };
  if (serviceRole) headers.Authorization = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (prefer) headers.Prefer = prefer;
  const res = await fetchImpl(`${SUPABASE_URL.replace(/\/$/, "")}${pathAndQuery}`,
    withTimeout({ method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }));
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body, leave null */ }
  return { status: res.status, ok: res.ok, json };
}

// CAS-996: Cascade accounts are passwordless (magic-link/emailed-code only), so there is no
// account-password secret to grant_type=password with — and there never will be one, since no
// such secret can exist for a passwordless account. Mint a real session the same way a signed-in
// magic-link click does, without sending an email: admin/generate_link (service-role key) returns
// a hashed_token that /auth/v1/verify (anon key) exchanges for a normal access_token. `type`
// defaults to "magiclink" for an existing account (the canary); the signup probe below passes
// "signup" instead, which additionally creates the throwaway account as a side effect.
//
// CAS-998: the raw GoTrue response carries hashed_token (+ action_link, email_otp,
// verification_type) at the TOP LEVEL of the body, alongside the user fields — `properties.
// hashed_token` is supabase-js's client-side wrapper shape, not what the HTTP endpoint itself
// sends. Check the top level first, keep the wrapper shape as a fallback in case a future GoTrue
// version reintroduces it.
function errDetail(json) {
  const msg = json && (json.msg || json.error_description || json.message || json.error);
  return msg ? ` — ${msg}` : "";
}

async function mintSessionForEmail(fetchImpl, email, { type = "magiclink", extraBody = {} } = {}) {
  const missing = missingNames(
    ["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_ANON_KEY", SUPABASE_ANON_KEY],
    ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY]);
  if (missing.length) return { ok: false, detail: `not configured: ${missing.join(", ")}` };

  const gen = await supabaseFetch(fetchImpl, "/auth/v1/admin/generate_link",
    { method: "POST", serviceRole: true, body: { type, email, ...extraBody } });
  const hashedToken = gen.json?.hashed_token ?? gen.json?.properties?.hashed_token;
  if (!gen.ok || !hashedToken) {
    return { ok: false, detail: `generate_link failed: HTTP ${gen.status}${errDetail(gen.json)}` };
  }
  const verify = await supabaseFetch(fetchImpl, "/auth/v1/verify",
    { method: "POST", body: { type, token_hash: hashedToken } });
  const token = verify.json?.access_token;
  if (!verify.ok || !token) {
    return { ok: false, detail: `verify failed: HTTP ${verify.status}${errDetail(verify.json)}` };
  }
  return { ok: true, token };
}

export async function probeSupabaseCanary(fetchImpl = fetch) {
  const missing = missingNames(
    ["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_ANON_KEY", SUPABASE_ANON_KEY],
    ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY], ["CASCADE_CANARY_EMAIL", CANARY_EMAIL]);
  if (missing.length) {
    return { signedIn: false, detail: `not configured: ${missing.join(", ")}` };
  }
  const session = await mintSessionForEmail(fetchImpl, CANARY_EMAIL);
  if (!session.ok) {
    return { signedIn: false, detail: `canary sign-in failed: ${session.detail}` };
  }
  const token = session.token;
  // CAS-1109: a soft-deleted agent (deleted_at set) is gone, same as the client's own loadAccount and the
  // monitor's fetch_active_cascades — the canary's roster must never read green off rows nobody can see.
  const cascades = await supabaseFetch(fetchImpl, "/rest/v1/cascades?select=id&deleted_at=is.null", { token });
  const agentFilms = await supabaseFetch(fetchImpl, "/rest/v1/agent_films?select=movie_id&limit=1", { token });
  const filmWatch = await supabaseFetch(fetchImpl, "/rest/v1/film_watch?select=movie_id&limit=1", { token });
  await supabaseFetch(fetchImpl, "/auth/v1/logout", { method: "POST", token }).catch(() => {});
  return {
    signedIn: true,
    cascadesOk: cascades.ok, cascadesCount: Array.isArray(cascades.json) ? cascades.json.length : null,
    agentFilmsOk: agentFilms.ok, agentFilmsCount: Array.isArray(agentFilms.json) ? agentFilms.json.length : null,
    filmWatchOk: filmWatch.ok,
  };
}

export function checkSupabaseCanary(probe) {
  if (!probe.signedIn) return { ok: false, detail: probe.detail || "canary sign-in failed" };
  if (!probe.cascadesOk) return { ok: false, detail: "canary account's agent roster read failed" };
  if (!probe.cascadesCount) return { ok: false, detail: "canary account's agent roster came back empty" };
  if (!probe.agentFilmsOk) return { ok: false, detail: "canary account's agent_films read failed" };
  if (!probe.agentFilmsCount) return { ok: false, detail: "canary account's agent_films came back empty" };
  if (!probe.filmWatchOk) return { ok: false, detail: "canary account's film_watch read failed" };
  return {
    ok: true,
    detail: `${probe.cascadesCount} agent(s), ${probe.agentFilmsCount} admitted film(s), film_watch read OK.`,
  };
}

// ---------------------------------------------------------------------------
// signup — create a throwaway +probe-<timestamp> account, confirm it, try the real CAS-980
// deletion path, tolerate it not existing yet.
// ---------------------------------------------------------------------------
export function probeSignupEmail(canaryEmail = CANARY_EMAIL, now = Date.now()) {
  const [local, domain] = canaryEmail.split("@");
  const base = local.split("+")[0];
  return `${base}+probe-${now}@${domain}`;
}

function randomPassword() {
  return `Probe-${Date.now()}-${Math.random().toString(36).slice(2)}!`;
}

export async function probeSignup(fetchImpl = fetch) {
  const missing = missingNames(
    ["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_ANON_KEY", SUPABASE_ANON_KEY],
    ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY], ["CASCADE_CANARY_EMAIL", CANARY_EMAIL]);
  if (missing.length) {
    return { created: false, detail: `not configured: ${missing.join(", ")}` };
  }
  const email = probeSignupEmail();
  // CAS-996: no password grant here either — generate_link's "signup" type creates the throwaway
  // account as a side effect (the API still requires a password field to shape the row; it is
  // never used to sign in) and verify hands back a real, already-confirmed session directly.
  const session = await mintSessionForEmail(fetchImpl, email, { type: "signup", extraBody: { password: randomPassword() } });
  if (!session.ok) {
    return { created: false, detail: `sign-up failed: ${session.detail}` };
  }
  const token = session.token;

  const del = await supabaseFetch(fetchImpl, "/rest/v1/rpc/delete_my_account", { method: "POST", token, body: {} });
  const bodyStr = JSON.stringify(del.json || {});
  const notShipped = del.status === 404 || /Could not find function|PGRST202/i.test(bodyStr);
  const removed = del.ok && !notShipped;
  return {
    created: true, removed, notShipped, email,
    detail: (!removed && !notShipped) ? `delete_my_account failed: HTTP ${del.status}` : null,
  };
}

export function checkSignup(probe, pendingAfter) {
  if (!probe.created) return { ok: false, detail: probe.detail || "sign-up probe failed" };
  if (probe.removed) return { ok: true, detail: `created and removed ${probe.email} via delete_my_account.` };
  if (probe.notShipped) {
    return {
      ok: true,
      detail: `created ${probe.email}; delete_my_account (CAS-980) not live yet, left in place — `
        + `${pendingAfter} probe account(s) pending removal.`,
    };
  }
  return { ok: false, detail: `created ${probe.email} but could not remove it: ${probe.detail}` };
}

// ---------------------------------------------------------------------------
// orphan_probe_accounts — CAS-1012: 16 signup-probe accounts from a broken cleanup path sat in
// auth.users for hours before anyone noticed (RB-MON-02). Assert directly that no `probe` account
// outlives its own throwaway lifetime, so a cleanup regression is caught within the hour instead
// of at the next manual QA pass.
// ---------------------------------------------------------------------------
const ORPHAN_PROBE_AGE_MS = 2 * ONE_HOUR_MS;

export async function probeOrphanAccounts(fetchImpl = fetch) {
  const missing = missingNames(["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY]);
  if (missing.length) return { detail: `not configured: ${missing.join(", ")}` };

  const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const base = SUPABASE_URL.replace(/\/$/, "");
  const users = [];
  for (let page = 1; page <= 25; page++) {
    let res;
    try {
      res = await fetchImpl(`${base}/auth/v1/admin/users?page=${page}&per_page=200`, withTimeout({ headers }));
    } catch (err) {
      return { detail: `GET admin/users -> ${err && err.message || err}` };
    }
    if (!res.ok) return { detail: `GET admin/users -> HTTP ${res.status}` };
    const data = await res.json();
    const pageUsers = Array.isArray(data) ? data : (data.users || []);
    users.push(...pageUsers);
    if (pageUsers.length < 200) break;
  }
  return { users };
}

export function checkOrphanAccounts(probe, now = Date.now()) {
  if (!probe.users) return { ok: false, detail: probe.detail || "could not list auth.users" };
  const stale = probe.users.filter(u =>
    (u.email || "").toLowerCase().includes("probe")
    && u.created_at
    && (now - new Date(u.created_at).getTime()) > ORPHAN_PROBE_AGE_MS);
  if (stale.length) {
    return {
      ok: false,
      detail: `${stale.length} probe account(s) older than 2h: ${stale.map(u => u.email).join(", ")}`,
    };
  }
  return { ok: true, detail: "no probe account older than 2h." };
}

// ---------------------------------------------------------------------------
// usage_events_insert — one row, as anon
// ---------------------------------------------------------------------------
export async function probeUsageEventsInsert(fetchImpl = fetch) {
  const missing = missingNames(["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_ANON_KEY", SUPABASE_ANON_KEY]);
  if (missing.length) {
    return { ok: false, detail: `not configured: ${missing.join(", ")}` };
  }
  const res = await supabaseFetch(fetchImpl, "/rest/v1/usage_events", {
    method: "POST", prefer: "return=minimal",
    body: { client_key: "cascade-uptime-probe", type: "uptime_probe", data: { source: "scripts/uptime_probe.mjs" } },
  });
  return { ok: res.ok, detail: `HTTP ${res.status}` };
}

export function checkUsageEventsInsert(probe) {
  return { ok: !!probe.ok, detail: probe.detail };
}

// ---------------------------------------------------------------------------
// pages_head
// ---------------------------------------------------------------------------
export async function probePagesHead(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(PAGES_URL, withTimeout({ method: "HEAD" }));
    return { ok: res.ok, detail: `HEAD ${PAGES_URL} -> HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `HEAD ${PAGES_URL} -> ${err && err.message || err}` };
  }
}

export function checkPagesHead(probe) {
  return { ok: !!probe.ok, detail: probe.detail };
}

// ---------------------------------------------------------------------------
// daily_refresh_fresh — dead-man check: has daily.yml's refresh actually landed a commit
// recently, or did the schedule silently stop firing (CAS-995)
// ---------------------------------------------------------------------------
function githubHeaders() {
  const headers = { "User-Agent": "cascade-uptime-probe/1.0", Accept: "application/vnd.github+json" };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

export async function probeDailyRefreshFresh(fetchImpl = fetch) {
  try {
    const url = `${GITHUB_API}/repos/${GITHUB_REPOSITORY}/commits?sha=staging&per_page=100`;
    const res = await fetchImpl(url, withTimeout({ headers: githubHeaders() }));
    if (!res.ok) return { detail: `GET commits -> HTTP ${res.status}` };
    const commits = await res.json();
    const hit = (commits || []).find(c =>
      (c.commit?.message || "").startsWith(DAILY_REFRESH_COMMIT_PREFIX));
    if (!hit) return { detail: `no "${DAILY_REFRESH_COMMIT_PREFIX.trim()}" commit in the last 100 on staging` };
    return { lastCommitAt: hit.commit.author?.date || hit.commit.committer?.date };
  } catch (err) {
    return { detail: `GET commits -> ${err && err.message || err}` };
  }
}

export function checkDailyRefreshFresh(probe, now = new Date()) {
  if (!probe || !probe.lastCommitAt) {
    return { ok: false, detail: (probe && probe.detail) || "no \"Daily refresh\" commit found" };
  }
  const ageMs = now.getTime() - new Date(probe.lastCommitAt).getTime();
  const ok = ageMs <= THIRTY_HOURS_MS;
  return { ok, detail: `last "Daily refresh" commit ${(ageMs / 3600000).toFixed(1)}h ago (floor 30h).` };
}

// ---------------------------------------------------------------------------
// alerts_ran — dead-man check: has alerts.yml (CAS-993) completed successfully recently
// ---------------------------------------------------------------------------
export async function probeAlertsRan(fetchImpl = fetch) {
  try {
    const url = `${GITHUB_API}/repos/${GITHUB_REPOSITORY}/actions/workflows/${ALERTS_WORKFLOW_FILE}/runs`
      + `?status=success&per_page=1`;
    const res = await fetchImpl(url, withTimeout({ headers: githubHeaders() }));
    if (!res.ok) return { detail: `GET workflow runs -> HTTP ${res.status}` };
    const data = await res.json();
    const run = (data.workflow_runs || [])[0];
    if (!run) return { detail: `no successful ${ALERTS_WORKFLOW_FILE} run found` };
    return { lastSuccessAt: run.updated_at || run.run_started_at || run.created_at };
  } catch (err) {
    return { detail: `GET workflow runs -> ${err && err.message || err}` };
  }
}

export function checkAlertsRan(probe, now = new Date()) {
  if (!probe || !probe.lastSuccessAt) {
    return { ok: false, detail: (probe && probe.detail) || `no successful ${ALERTS_WORKFLOW_FILE} run found` };
  }
  const ageMs = now.getTime() - new Date(probe.lastSuccessAt).getTime();
  const ok = ageMs <= THIRTY_HOURS_MS;
  return { ok, detail: `last successful ${ALERTS_WORKFLOW_FILE} run ${(ageMs / 3600000).toFixed(1)}h ago (floor 30h).` };
}

// ---------------------------------------------------------------------------
// flap control (CAS-975/CAS-995) — site_up, movies_json and daily_refresh_fresh alert on their
// FIRST red (an outage or a silently-stopped schedule is worth knowing about immediately); every
// other probe still needs two consecutive reds, same as before, so a single flaky probe doesn't
// page anyone. Either path fires at most once per open red streak (edge-triggered on the probe
// NEWLY going red, tracked per-name in state) and respects the same one-alert-per-hour cooldown.
// The first green after any red always sends exactly one recovery, unchanged.
//
// CAS-998: those two triggers only decide whether the FIRST alert of a streak fires. Once one
// has, `lastAlertedRedNames` (the sorted, comma-joined set of failing check names at the moment
// of that alert) drives what happens next: if the failing set changes at all — a check newly
// joins it — that's alerted immediately, bypassing every cooldown, because it's new information;
// otherwise, while the same set stays red, the alert repeats every twelve hours rather than
// staying silent for the rest of the outage.
// ---------------------------------------------------------------------------
export const FAST_ALERT_CHECKS = ["site_up", "movies_json", "daily_refresh_fresh"];
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export function decideAlerting(prevState, results, nowMs = Date.now()) {
  const allOk = results.every(r => r.ok);
  const prevReds = (prevState && prevState.consecutiveReds) || 0;
  const prevSlowReds = (prevState && prevState.slowConsecutiveReds) || 0;
  const prevFastRed = new Set((prevState && prevState.fastRedNames) || []);
  const prevAlertedRed = (prevState && prevState.lastAlertedRedNames) || null;

  if (allOk) {
    return {
      consecutiveReds: 0, slowConsecutiveReds: 0, fastRedNames: [], lastAlertedRedNames: null,
      sendAlert: false, sendRecovery: prevReds > 0 || prevFastRed.size > 0,
    };
  }

  const consecutiveReds = prevReds + 1;
  const fastRedNames = results.filter(r => FAST_ALERT_CHECKS.includes(r.name) && !r.ok).map(r => r.name);
  const newlyFastRed = fastRedNames.some(n => !prevFastRed.has(n));
  // Tracked separately from `consecutiveReds` (which counts ANY red, for the recovery message's
  // "after N red runs" text): a fast check staying red on its own must not also trip the slow
  // two-in-a-row rule a run after it already alerted on its own first-red rule.
  const anySlowRed = results.some(r => !FAST_ALERT_CHECKS.includes(r.name) && !r.ok);
  const slowConsecutiveReds = anySlowRed ? prevSlowReds + 1 : 0;

  const lastAlertAt = prevState && prevState.lastAlertAt ? Date.parse(prevState.lastAlertAt) : null;
  const withinCooldown = lastAlertAt != null && (nowMs - lastAlertAt) < ONE_HOUR_MS;

  const redNamesKey = results.filter(r => !r.ok).map(r => r.name).sort().join(",");
  const setChangedSinceLastAlert = prevAlertedRed != null && redNamesKey !== prevAlertedRed;
  const persistentRedDue = prevAlertedRed != null && !setChangedSinceLastAlert
    && lastAlertAt != null && (nowMs - lastAlertAt) >= TWELVE_HOURS_MS;

  const sendAlert = setChangedSinceLastAlert || persistentRedDue
    || ((newlyFastRed || slowConsecutiveReds === 2) && !withinCooldown);
  return {
    consecutiveReds, slowConsecutiveReds, fastRedNames,
    lastAlertedRedNames: sendAlert ? redNamesKey : prevAlertedRed,
    sendAlert, sendRecovery: false,
  };
}

async function sendResendEmail(fetchImpl, subject, text) {
  if (!(RESEND_API_KEY && ALERT_TO)) {
    console.log("[uptime] RESEND_API_KEY/CASCADE_ALERT_TO not set — skipping alert email.");
    return;
  }
  try {
    await fetchImpl("https://api.resend.com/emails", withTimeout({
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [ALERT_TO], subject, text }),
    }));
  } catch (err) {
    console.error(`::error::Resend send failed: ${err && err.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// push (CAS-995) — the second, independent alert channel. APNs auth is the same ES256
// token-based provider API monitor/pusher.py signs by hand (no npm install step in this repo);
// Node's built-in `crypto` module signs P-256 natively via `dsaEncoding: "ieee-p1363"`, which
// hands back the raw r||s bytes ES256 needs directly — no manual DER/point-math required here.
// ---------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function mintApnsProviderJwt(keyId, teamId, authKeyB64, nowSeconds = Math.floor(Date.now() / 1000)) {
  const keyObject = crypto.createPrivateKey({
    key: Buffer.from(authKeyB64, "base64"), format: "der", type: "pkcs8",
  });
  const header = { alg: "ES256", kid: keyId };
  const payload = { iss: teamId, iat: nowSeconds };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key: keyObject, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}

async function sendApnsPush(fetchImpl, deviceToken, title, body) {
  if (!(APNS_KEY_ID && APNS_TEAM_ID && APNS_AUTH_KEY && APNS_BUNDLE_ID)) {
    console.log("[uptime] APNS_* not set — skipping push.");
    return false;
  }
  let token;
  try {
    token = mintApnsProviderJwt(APNS_KEY_ID, APNS_TEAM_ID, APNS_AUTH_KEY);
  } catch (err) {
    console.error(`[uptime] APNs provider JWT mint failed: ${err && err.message || err}`);
    return false;
  }
  try {
    const res = await fetchImpl(`https://api.push.apple.com/3/device/${deviceToken}`, withTimeout({
      method: "POST",
      headers: {
        authorization: `bearer ${token}`, "apns-topic": APNS_BUNDLE_ID,
        "apns-push-type": "alert", "content-type": "application/json",
      },
      body: JSON.stringify({ aps: { alert: { title, body } } }),
    }));
    if (!res.ok) console.log(`[uptime] APNs push rejected: HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error(`[uptime] APNs push failed: ${err && err.message || err}`);
    return false;
  }
}

// GoTrue admin users listing has no documented stable exact-email filter, so this paginates the
// same way scripts/send_alert.py's Python twin does — cheap for this project's small user count.
export async function findPushTokensForEmail(fetchImpl, email) {
  if (!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)) return [];
  const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const base = SUPABASE_URL.replace(/\/$/, "");
  const target = email.toLowerCase();
  let userId = null;
  for (let page = 1; page <= 25 && !userId; page++) {
    const res = await fetchImpl(`${base}/auth/v1/admin/users?page=${page}&per_page=200`, withTimeout({ headers }));
    if (!res.ok) break;
    const data = await res.json();
    const users = Array.isArray(data) ? data : (data.users || []);
    const match = users.find(u => (u.email || "").toLowerCase() === target);
    if (match) userId = match.id;
    if (users.length < 200) break;
  }
  if (!userId) return [];
  const res = await fetchImpl(
    `${base}/rest/v1/push_tokens?select=device_token&user_id=eq.${encodeURIComponent(userId)}`,
    withTimeout({ headers }));
  if (!res.ok) return [];
  const rows = await res.json();
  return (rows || []).map(r => r.device_token).filter(Boolean);
}

async function sendPushAlert(fetchImpl, subject, text) {
  if (!ALERT_TO) return;
  let tokens;
  try {
    tokens = await findPushTokensForEmail(fetchImpl, ALERT_TO);
  } catch (err) {
    console.error(`[uptime] push token lookup failed: ${err && err.message || err}`);
    return;
  }
  if (!tokens.length) {
    console.log(`[uptime] no push tokens registered for ${ALERT_TO} — skipping push.`);
    return;
  }
  const body = text.split("\n").find(l => l.trim()) || subject;
  await Promise.all(tokens.map(tok => sendApnsPush(fetchImpl, tok, "Cascade Alert", body)));
}

// ---------------------------------------------------------------------------
// state/uptime.json
// ---------------------------------------------------------------------------
export function readState(file = STATE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

export function writeState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// run everything
// ---------------------------------------------------------------------------
async function timeProbe(name, fn) {
  const t0 = Date.now();
  let result;
  try { result = await fn(); } catch (err) { result = { ok: false, detail: `threw: ${err && err.message || err}` }; }
  return { name, ok: !!result.ok, ms: Date.now() - t0, detail: result.detail || "" };
}

export async function runAllProbes(fetchImpl = fetch, prevState = {}) {
  const results = [];
  results.push(await timeProbe("site_up", async () => checkSiteUp(await probeSiteUp(fetchImpl), MAIN_VERSION)));
  results.push(await timeProbe("movies_json", async () => checkMoviesJson(await probeMoviesJson(fetchImpl))));
  results.push(await timeProbe("supabase_canary", async () => checkSupabaseCanary(await probeSupabaseCanary(fetchImpl))));

  let signupPendingAfter = prevState.signupAccountsPending || 0;
  results.push(await timeProbe("signup", async () => {
    const probe = await probeSignup(fetchImpl);
    if (probe.created && !probe.removed) signupPendingAfter += 1;
    return checkSignup(probe, signupPendingAfter);
  }));

  results.push(await timeProbe("orphan_probe_accounts", async () => checkOrphanAccounts(await probeOrphanAccounts(fetchImpl))));
  results.push(await timeProbe("usage_events_insert", async () => checkUsageEventsInsert(await probeUsageEventsInsert(fetchImpl))));
  results.push(await timeProbe("pages_head", async () => checkPagesHead(await probePagesHead(fetchImpl))));
  results.push(await timeProbe("daily_refresh_fresh", async () => checkDailyRefreshFresh(await probeDailyRefreshFresh(fetchImpl))));
  results.push(await timeProbe("alerts_ran", async () => checkAlertsRan(await probeAlertsRan(fetchImpl))));

  return { results, signupPendingAfter };
}

async function main() {
  const jsonMode = process.argv.includes("--json");
  const prevState = readState();
  const { results, signupPendingAfter } = await runAllProbes(fetch, prevState);
  const allOk = results.every(r => r.ok);
  const decision = decideAlerting(prevState, results);

  for (const r of results) {
    if (jsonMode) console.log(JSON.stringify({ name: r.name, ok: r.ok, ms: r.ms, detail: r.detail }));
    else console.log(`[uptime] ${r.name}: ${r.ok ? "OK" : "RED"} (${r.ms}ms) — ${r.detail}`);
  }

  if (decision.sendAlert) {
    const failed = results.filter(r => !r.ok).map(r => r.name).join(", ");
    const subject = "[Cascade ALERT] hourly uptime check red";
    const text = `Failing probe(s): ${failed}\n\n`
      + results.map(r => `${r.name}: ${r.ok ? "OK" : "RED"} — ${r.detail}`).join("\n");
    // Independent channels (CAS-995): a Resend outage must not also silence the push, and vice
    // versa, so each is sent on its own path rather than one gating the other.
    await Promise.all([sendResendEmail(fetch, subject, text), sendPushAlert(fetch, subject, text)]);
  }
  if (decision.sendRecovery) {
    const subject = "[Cascade RECOVERY] hourly uptime check green";
    const text = `The hourly uptime check is green again after ${(prevState.consecutiveReds || 0)} red run(s).\n\n`
      + results.map(r => `${r.name}: OK — ${r.detail}`).join("\n");
    await Promise.all([sendResendEmail(fetch, subject, text), sendPushAlert(fetch, subject, text)]);
  }

  writeState({
    lastRun: new Date().toISOString(),
    consecutiveReds: decision.consecutiveReds,
    slowConsecutiveReds: decision.slowConsecutiveReds || 0,
    fastRedNames: decision.fastRedNames || [],
    lastAlertedRedNames: decision.lastAlertedRedNames ?? null,
    lastAlertAt: decision.sendAlert ? new Date().toISOString() : (prevState.lastAlertAt || null),
    signupAccountsPending: signupPendingAfter,
    checks: results,
  });

  if (!allOk) {
    console.log(`[uptime] FAILED: ${results.filter(r => !r.ok).map(r => r.name).join(", ")}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

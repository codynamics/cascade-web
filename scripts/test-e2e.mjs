#!/usr/bin/env node
// CAS-1110: `npm run test:e2e` — starts a local Supabase stack the same way scripts/test-integrity.mjs
// (CAS-1093) does (see scripts/lib/local-supabase.mjs), creates the one shared test user the whole suite
// signs in as (via the local admin API — no email round trip), builds the app, and runs the e2e suite with
// that user's real session available for tests/e2e/helpers.mjs to inject (CASCADE_E2E_SESSION) — never the
// live project, which this script never touches.
//
// Any spec path/flag after the script name is forwarded straight to `playwright test` — e.g.
// `node scripts/test-e2e.mjs tests/e2e/smoke.spec.mjs --retries=1` (what qa.yml's merged job runs) or
// `node scripts/test-e2e.mjs` with no path for the full ./tests/e2e suite (`npm run test:e2e:full`).
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { withLocalSupabase, statusEnv, readEnvField } from "./lib/local-supabase.mjs";

function run(cmd, args, extraEnv){
  const res = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  if(res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

const specArgs = process.argv.slice(2);

await withLocalSupabase(async () => {
  const env = statusEnv();
  const apiUrl = readEnvField(env, ["API_URL", "PROJECT_URL"], "API URL");
  const anonKey = readEnvField(env, ["ANON_KEY", "PUBLISHABLE_KEY"], "anon/publishable key");
  const serviceRoleKey = readEnvField(env, ["SERVICE_ROLE_KEY", "SECRET_KEY"], "service_role/secret key");

  console.log("[test:e2e] creating the shared signed-in test user...");
  const admin = createClient(apiUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const email = `cas1110-e2e-${Date.now()}@e2e.test`;
  const { error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if(createErr) throw new Error(`createUser(${email}) failed: ${createErr.message}`);

  // The one-time code a real sign-in would have emailed, fetched via the admin API instead of standing up
  // a mail-capture dependency this script has no other use for — same technique as
  // tests/e2e-integrity/helpers.mjs's fetchOtp/signInDirect.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if(linkErr) throw new Error(`generateLink(${email}) failed: ${linkErr.message}`);
  const code = linkData && linkData.properties && linkData.properties.email_otp;
  if(!code) throw new Error(`generateLink(${email}) returned no email_otp`);

  const anon = createClient(apiUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({ email, token: code, type: "email" });
  if(verifyErr) throw new Error(`verifyOtp(${email}) failed: ${verifyErr.message}`);

  console.log("[test:e2e] building the app...");
  run("python", ["poc_pipeline.py", "--build-html"]);

  console.log("[test:e2e] running the e2e suite signed in against the local stack...");
  run("npx", ["playwright", "test", ...specArgs], {
    CASCADE_E2E_SUPABASE_URL: apiUrl,
    CASCADE_E2E_SUPABASE_ANON_KEY: anonKey,
    CASCADE_E2E_SESSION: JSON.stringify(verifyData.session),
  });
});

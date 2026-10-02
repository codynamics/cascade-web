#!/usr/bin/env node
// CAS-1110: `npm run test:e2e` — starts a local Supabase stack the same way scripts/test-integrity.mjs
// (CAS-1093) does (see scripts/lib/local-supabase.mjs), builds the app, and runs the e2e suite with the
// local stack's own URL/anon/service_role credentials available for tests/e2e/helpers.mjs's
// freshAppSignedIn() to create a fresh signed-in test user per test (via the local admin API — no email
// round trip) — never the live project, which this script never touches.
//
// A fresh user per test, not one shared across the run: see freshAppSignedIn()'s own comment in
// tests/e2e/helpers.mjs for why a single shared account isn't safe once account data lives server-side.
//
// Any spec path/flag after the script name is forwarded straight to `playwright test` — e.g.
// `node scripts/test-e2e.mjs tests/e2e/smoke.spec.mjs --retries=1` (what qa.yml's merged job runs) or
// `node scripts/test-e2e.mjs` with no path for the full ./tests/e2e suite (`npm run test:e2e:full`).
import { spawnSync } from "node:child_process";
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

  console.log("[test:e2e] building the app...");
  run("python", ["poc_pipeline.py", "--build-html"]);

  console.log("[test:e2e] running the e2e suite signed in against the local stack...");
  run("npx", ["playwright", "test", ...specArgs], {
    CASCADE_E2E_SUPABASE_URL: apiUrl,
    CASCADE_E2E_SUPABASE_ANON_KEY: anonKey,
    CASCADE_E2E_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  });
});

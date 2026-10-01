#!/usr/bin/env node
// CAS-1093: `npm run test:integrity` — the one command the ticket asks for. Starts a local Supabase stack
// (Supabase CLI, Docker; supabase/config.toml), loads supabase/schema.sql into it, builds the app, and runs
// tests/e2e-integrity/*.spec.mjs against it with test-only config injection (tests/e2e-integrity/helpers.mjs
// routes config.js at the local stack's own URL/anon key — never the real project's, which live only in the
// git-tracked config.js this script never touches).
//
// CAS-1110: stack start/stop/schema-load is now shared with scripts/test-e2e.mjs via
// scripts/lib/local-supabase.mjs's withLocalSupabase() — see that module's own header for why, and for how
// qa.yml's merged e2e+integrity job shares one `supabase start`/`stop` round trip between the two suites.
// Run on its own (as below), this still starts and stops its own stack exactly as before.
//
// Why the local URL/anon/service_role keys (and the db connection string) are read back from
// `supabase status -o env` rather than hardcoded: the CLI generates them per-stack from
// supabase/config.toml + its own JWT secret, and reading them keeps this script correct across CLI
// versions instead of quietly drifting from whatever the installed CLI actually started.
import { spawnSync } from "node:child_process";
import { withLocalSupabase, statusEnv, readEnvField } from "./lib/local-supabase.mjs";

function run(cmd, args, extraEnv){
  const res = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  if(res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

await withLocalSupabase(async () => {
  const env = statusEnv();
  const apiUrl = readEnvField(env, ["API_URL", "PROJECT_URL"], "API URL");
  const anonKey = readEnvField(env, ["ANON_KEY", "PUBLISHABLE_KEY"], "anon/publishable key");
  const serviceRoleKey = readEnvField(env, ["SERVICE_ROLE_KEY", "SECRET_KEY"], "service_role/secret key");

  console.log("[test:integrity] building the app...");
  run("python", ["poc_pipeline.py", "--build-html"]);

  console.log("[test:integrity] running the account-integrity suite against the local stack...");
  run("npx", ["playwright", "test", "--config=playwright.integrity.config.mjs"], {
    CASCADE_INTEGRITY_SUPABASE_URL: apiUrl,
    CASCADE_INTEGRITY_SUPABASE_ANON_KEY: anonKey,
    CASCADE_INTEGRITY_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  });
});

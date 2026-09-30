#!/usr/bin/env node
// CAS-1093: `npm run test:integrity` — the one command the ticket asks for. Starts a local Supabase stack
// (Supabase CLI, Docker; supabase/config.toml), resets it so every file in supabase/migrations/ is applied
// in number order, builds the app, and runs tests/e2e-integrity/*.spec.mjs against it with test-only config
// injection (tests/e2e-integrity/helpers.mjs routes config.js at the local stack's own URL/anon key — never
// the real project's, which live only in the git-tracked config.js this script never touches).
//
// Why the local URL/anon/service_role keys are read back from `supabase status` rather than hardcoded: the
// CLI generates them per-stack from supabase/config.toml + its own JWT secret, and reading them keeps this
// script correct across CLI versions instead of quietly drifting from whatever the installed CLI actually
// started.
import { spawnSync } from "node:child_process";

function run(cmd, args, extraEnv){
  const res = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  if(res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

function supabaseStatusText(){
  const res = spawnSync("npx", ["supabase", "status"], { encoding: "utf8" });
  if(res.status !== 0) throw new Error(`supabase status exited ${res.status}:\n${res.stderr}`);
  return res.stdout;
}

function readField(text, label){
  const m = text.match(new RegExp(`^\\s*${label}:\\s*(\\S+)`, "im"));
  if(!m) throw new Error(`supabase status output had no "${label}:" line — CLI output shape may have changed:\n${text}`);
  return m[1];
}

console.log("[test:integrity] starting local Supabase stack (npx supabase start)...");
run("npx", ["supabase", "start"]);

try{
  console.log("[test:integrity] resetting the local database and applying supabase/migrations/ in order...");
  run("npx", ["supabase", "db", "reset"]);

  const status = supabaseStatusText();
  const apiUrl = readField(status, "API URL");
  const anonKey = readField(status, "anon key");
  const serviceRoleKey = readField(status, "service_role key");

  console.log("[test:integrity] building the app...");
  run("python", ["poc_pipeline.py", "--build-html"]);

  console.log("[test:integrity] running the account-integrity suite against the local stack...");
  run("npx", ["playwright", "test", "--config=playwright.integrity.config.mjs"], {
    CASCADE_INTEGRITY_SUPABASE_URL: apiUrl,
    CASCADE_INTEGRITY_SUPABASE_ANON_KEY: anonKey,
    CASCADE_INTEGRITY_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  });
}finally{
  console.log("[test:integrity] stopping the local Supabase stack...");
  spawnSync("npx", ["supabase", "stop"], { stdio: "inherit" });
}

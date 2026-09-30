#!/usr/bin/env node
// CAS-1093: `npm run test:integrity` — the one command the ticket asks for. Starts a local Supabase stack
// (Supabase CLI, Docker; supabase/config.toml), loads supabase/schema.sql into it, builds the app, and runs
// tests/e2e-integrity/*.spec.mjs against it with test-only config injection (tests/e2e-integrity/helpers.mjs
// routes config.js at the local stack's own URL/anon key — never the real project's, which live only in the
// git-tracked config.js this script never touches).
//
// Why schema.sql, not a migrations/ replay: supabase/README.md is explicit that migrations/ is the
// incremental history applied BY HAND onto an already-live project, while schema.sql is "the script to run
// against a brand-new project instead of replaying every migration from scratch" — its earliest migration
// (0000, CAS-1074) assumes objects like analytics_admins already exist live, so replaying migrations/ from
// an empty database (what `supabase start`/`db reset` do on a fresh stack) fails on that very first file.
// A brand-new local stack is exactly the "brand-new project" case the README already calls out, so this
// hides migrations/ from the CLI's automatic first-boot replay and loads schema.sql directly instead,
// matching the documented bootstrap path rather than the by-hand incremental one.
//
// Why the local URL/anon/service_role keys are read back from `supabase status` rather than hardcoded: the
// CLI generates them per-stack from supabase/config.toml + its own JWT secret, and reading them keeps this
// script correct across CLI versions instead of quietly drifting from whatever the installed CLI actually
// started.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

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

const MIGRATIONS_DIR = "supabase/migrations";
const MIGRATIONS_BAK = "supabase/migrations.test-integrity-bak";

console.log("[test:integrity] starting local Supabase stack (npx supabase start)...");
fs.renameSync(MIGRATIONS_DIR, MIGRATIONS_BAK);
fs.mkdirSync(MIGRATIONS_DIR);
try{
  run("npx", ["supabase", "start"]);
}finally{
  fs.rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
  fs.renameSync(MIGRATIONS_BAK, MIGRATIONS_DIR);
}

try{
  console.log("[test:integrity] loading supabase/schema.sql into the fresh local database...");
  run("npx", ["supabase", "db", "query", "--local", "--file", "supabase/schema.sql"]);

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

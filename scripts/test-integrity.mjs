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
// Why psql, not `supabase db query --file`: that command sends the whole file as one prepared statement,
// which Postgres rejects for a multi-statement script ("cannot insert multiple commands into a prepared
// statement") — schema.sql is exactly that. psql runs it the same way the README's own SQL-Editor step
// runs it live: as a plain multi-statement script.
//
// Why the local URL/anon/service_role keys (and the db connection string) are read back from
// `supabase status -o env` rather than hardcoded: the CLI generates them per-stack from
// supabase/config.toml + its own JWT secret, and reading them keeps this script correct across CLI
// versions instead of quietly drifting from whatever the installed CLI actually started. The lookup below
// matches by field-name pattern rather than one exact name because the CLI has already renamed these once
// (anon/service_role key -> Publishable/Secret key) between versions.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

function run(cmd, args, extraEnv){
  const res = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  if(res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

function supabaseStatusEnv(){
  const res = spawnSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
  if(res.status !== 0) throw new Error(`supabase status -o env exited ${res.status}:\n${res.stderr}`);
  const map = {};
  for(const line of res.stdout.split(/\r?\n/)){
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if(!m) continue;
    let value = m[2].trim();
    if(value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    map[m[1]] = value;
  }
  return map;
}

function readEnvField(map, candidateNames, label){
  const hit = Object.entries(map).find(([k]) => candidateNames.some(n => n.toLowerCase() === k.toLowerCase()));
  if(!hit){
    throw new Error(`supabase status -o env had no ${label} key (looked for ${candidateNames.join(" / ")}) — got keys: ${Object.keys(map).join(", ")}`);
  }
  if(hit[1].includes("***")){
    throw new Error(`${label} value from supabase status -o env looks masked (${hit[1]}) — expected the unmasked machine-readable form`);
  }
  return hit[1];
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
  const statusEnv = supabaseStatusEnv();
  const dbUrl = readEnvField(statusEnv, ["DB_URL", "DATABASE_URL"], "database connection");
  const apiUrl = readEnvField(statusEnv, ["API_URL", "PROJECT_URL"], "API URL");
  const anonKey = readEnvField(statusEnv, ["ANON_KEY", "PUBLISHABLE_KEY"], "anon/publishable key");
  const serviceRoleKey = readEnvField(statusEnv, ["SERVICE_ROLE_KEY", "SECRET_KEY"], "service_role/secret key");

  console.log("[test:integrity] loading supabase/schema.sql into the fresh local database...");
  run("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", "supabase/schema.sql"]);

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

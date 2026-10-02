// CAS-1110: local Supabase stack management shared by scripts/test-integrity.mjs (CAS-1093) and
// scripts/test-e2e.mjs — factored out so the two suites can share one `supabase start`/`stop` round trip
// when they run back to back in the same CI job (qa.yml's merged e2e+integrity job) instead of each
// paying the full stack-start cost on its own. A standalone `npm run test:e2e` or `npm run test:integrity`
// still starts and stops its own stack exactly as before; withLocalSupabase only skips start/stop when it
// finds a stack already running.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

function run(cmd, args, extraEnv){
  const res = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  if(res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

export function isStackRunning(){
  return spawnSync("npx", ["supabase", "status"], { encoding: "utf8" }).status === 0;
}

const MIGRATIONS_DIR = "supabase/migrations";
const MIGRATIONS_BAK = "supabase/migrations.local-supabase-bak";

// Why migrations/ is hidden before `supabase start`: see scripts/test-integrity.mjs's original header —
// schema.sql (loaded separately, below) is the documented from-empty bootstrap path; migrations/ is the
// by-hand incremental history applied onto an already-live project, and its earliest file assumes objects
// that only exist live, so the CLI's automatic first-boot replay of migrations/ fails on a brand-new stack.
export function startStack(){
  console.log("[local-supabase] starting local Supabase stack (npx supabase start)...");
  fs.renameSync(MIGRATIONS_DIR, MIGRATIONS_BAK);
  fs.mkdirSync(MIGRATIONS_DIR);
  try{
    run("npx", ["supabase", "start"]);
  }finally{
    fs.rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
    fs.renameSync(MIGRATIONS_BAK, MIGRATIONS_DIR);
  }
}

export function stopStack(){
  console.log("[local-supabase] stopping local Supabase stack...");
  spawnSync("npx", ["supabase", "stop"], { stdio: "inherit" });
}

export function statusEnv(){
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

// Field names are matched by pattern, not one exact name, because the CLI has already renamed these once
// (anon/service_role key -> Publishable/Secret key) between versions.
export function readEnvField(map, candidateNames, label){
  const hit = Object.entries(map).find(([k]) => candidateNames.some(n => n.toLowerCase() === k.toLowerCase()));
  if(!hit){
    throw new Error(`supabase status -o env had no ${label} key (looked for ${candidateNames.join(" / ")}) — got keys: ${Object.keys(map).join(", ")}`);
  }
  if(hit[1].includes("***")){
    throw new Error(`${label} value from supabase status -o env looks masked (${hit[1]}) — expected the unmasked machine-readable form`);
  }
  return hit[1];
}

// psql, not `supabase db query --file`: that command sends the whole file as one prepared statement, which
// Postgres rejects for a multi-statement script — schema.sql is exactly that.
export function loadSchema(dbUrl){
  console.log("[local-supabase] loading supabase/schema.sql into the fresh local database...");
  run("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", "supabase/schema.sql"]);
}

/** Runs `fn({ startedFresh })` against a running local Supabase stack: starts one and loads schema.sql
 * first if none is already up, and stops it afterward — unless this call found the stack already running
 * (whoever started it owns stopping it), or CASCADE_SHARE_STACK is set (qa.yml's merged e2e+integrity job
 * sets it for the first consumer only, so it leaves the stack it started running for the second consumer
 * to reuse instead of paying a second `supabase start`/`stop` round trip and a second schema load; the
 * second consumer finds the stack already running and so neither starts, loads nor stops it either — the
 * job's runner is destroyed right after, so nothing is left to clean up). */
export async function withLocalSupabase(fn){
  const startedFresh = !isStackRunning();
  if(startedFresh){
    startStack();
    const dbUrl = readEnvField(statusEnv(), ["DB_URL", "DATABASE_URL"], "database connection");
    loadSchema(dbUrl);
  }
  try{
    return await fn({ startedFresh });
  }finally{
    if(startedFresh && !process.env.CASCADE_SHARE_STACK) stopStack();
  }
}

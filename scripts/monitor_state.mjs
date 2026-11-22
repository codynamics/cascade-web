// CAS-1514: publish / pull monitoring state via public.monitor_state (Supabase) instead of git.
//
//   node scripts/monitor_state.mjs push <key>=<file> [<key>=<file> ...]   upsert each JSON file
//   node scripts/monitor_state.mjs pull <key>=<file> [<key>=<file> ...]   write the row's payload to the file
//
// Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (service role bypasses RLS; anon/authenticated have
// no write policy). Never fails the job: a missing secret / network blip prints a warning and exits 0,
// so a probe result is never lost to a publishing problem (the same rule the probe's own alerts follow).
import fs from "node:fs";
import path from "node:path";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export async function pushState(key, file, fetchImpl = fetch) {
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const res = await fetchImpl(`${URL_}/rest/v1/monitor_state?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, payload, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export async function pullState(key, file, fetchImpl = fetch) {
  const res = await fetchImpl(`${URL_}/rest/v1/monitor_state?key=eq.${encodeURIComponent(key)}&select=payload`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  if (!rows.length) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows[0].payload, null, 2) + "\n");
  return true;
}

async function main(argv) {
  const [cmd, ...pairs] = argv;
  if (!["push", "pull"].includes(cmd) || !pairs.length) {
    console.error("usage: monitor_state.mjs push|pull key=file ...");
    return 2;
  }
  if (!URL_ || !KEY) {
    console.log("[monitor_state] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping.");
    return 0;
  }
  for (const pair of pairs) {
    const [key, file] = pair.split("=");
    try {
      if (cmd === "push") {
        if (!fs.existsSync(file)) { console.log(`[monitor_state] ${file} missing — skip ${key}`); continue; }
        await pushState(key, file);
        console.log(`[monitor_state] pushed ${key}`);
      } else {
        console.log(`[monitor_state] pull ${key}: ${(await pullState(key, file)) ? "ok" : "no row yet"}`);
      }
    } catch (err) {
      console.log(`::warning::monitor_state ${cmd} ${key} failed: ${err.message}`);
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main(process.argv.slice(2)).then(c => process.exit(c));
}

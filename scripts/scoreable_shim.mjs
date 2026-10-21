#!/usr/bin/env node
// CAS-986: the two-tier catalogue's publication test. Reads candidate movie dicts on stdin, asks
// the shipped engine which ones can carry a Cascade score today via isScoreable() — the same rule
// scripts/wm_scoreable_manifest.mjs already encodes for CAS-922 — and writes their tmdb_ids on
// stdout. One process for the whole batch, never per title, the same discipline
// monitor/admit_shim.mjs (CAS-825) already established: writing a second copy of this rule in
// Python is the defect CAS-986 exists to avoid, so this file is a thin pipe, not a reimplementation.
//
// Request shape:  { "movies": [ <movie dict>, ... ], "floor": <int, optional, default 0>,
//                    "today": <"YYYY-MM-DD", optional> }
// Response shape: { "scoreable_ids": [ <tmdb_id>, ... ] }
//
// CAS-997: `floor` is the Cascade-score publication floor — poc_pipeline.py passes its
// WM_PUBLISH_FLOOR (default 60) here. Defaulting to 0 when omitted keeps this shim's own
// existing callers/tests (none of which name a floor) on the pre-CAS-997 unfloored rule.
//
// CAS-1232: `today` pins the engine's notion of "today" (isScoreable's deriveStatus/primaryStatus
// re-derivation, e.g. the cinema-estimate-window check) to an explicit date instead of this
// process's own wall clock/timezone — poc_pipeline.py's publication path passes the catalogue's
// own build date, so a film doesn't cross WM_PUBLISH_FLOOR between refreshes purely because the
// CI runner's clock ticked over. Omitted entirely, every existing caller (including
// wm_scoreable_manifest.mjs's own CAS-922 manifest build) keeps asking against the real date.
//
// CAS-1327: `--track-min` is a second, stdin-free CLI mode — poc_pipeline.py's publication floor
// must equal the app's own agent-score minimum (TRACK_MIN), so it asks this shim rather than
// hard-coding a second copy of that number in Python. Prints { "track_min": <int> } and exits,
// never touching stdin. `--html <path>` overrides which built file the engine loads from (default
// the repo's own index.html) — used by tests to point at a fixture with a different TRACK_MIN.
import { loadEngine } from "../tests/js/engine.mjs";
import { isScoreable } from "./wm_scoreable_manifest.mjs";

async function readStdin(){
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function htmlPathArg(){
  const i = process.argv.indexOf("--html");
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// CAS-992: one malformed candidate (e.g. missing `status`) must never fail the whole batch — a
// record that throws is treated as not scoreable, and the count of such records goes to stderr,
// never stdout, so the JSON response scoreable_ids() parses stays clean.
async function main(){
  const htmlPath = htmlPathArg();
  const E = loadEngine(htmlPath ? { htmlPath } : {});
  if (process.argv.includes("--track-min")){
    process.stdout.write(JSON.stringify({ track_min: E.TRACK_MIN }));
    return;
  }
  const raw = await readStdin();
  const req = raw.trim() ? JSON.parse(raw) : {};
  const movies = req.movies || [];
  const floor = req.floor || 0;
  if (req.today) E.setToday(req.today);
  let failed = 0;
  const scoreable_ids = movies.filter(m => {
    try {
      return isScoreable(E, m, floor);
    } catch (err) {
      failed++;
      return false;
    }
  }).map(m => m.tmdb_id);
  if (failed > 0) {
    console.error(`[warn] CAS-992: ${failed} record(s) threw during isScoreable() and were treated as not scoreable`);
  }
  process.stdout.write(JSON.stringify({ scoreable_ids }));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

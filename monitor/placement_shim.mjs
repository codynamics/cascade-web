// CAS-1097: ask the SHIPPED engine, the same way admit_shim.mjs asks it which films an agent admits
// (CAS-825), which WINDOW an admission earns — the question recomputeFound's own placement block answers
// on the device (earnedWindowForScore/autoPlacementFor/autoPlacementForAdmission, app_template.html,
// extracted for this exact purpose). A second, hand-ported copy of that score-threshold/standing-ladder
// arithmetic in Python is exactly the drift CAS-825 fixed for admission itself — this shim is the same fix
// applied to placement.
//
// Reads one JSON request on stdin, writes one JSON response on stdout, then exits. Invoked once per
// monitor run (see monitor/matching.py's compute_auto_placements) — never once per film.
//
// Request shape:
//   {
//     "users": [
//       { "userId": "...", "watchWindows": {...} | null,
//         "placements": [ { "cascadeId": "...", "criteria": {...}, "movieId": "...", "admissionScore": 80 }, ... ] },
//       ...
//     ],
//     "movies": { "<tmdb_id>": <movie dict>, ... }
//   }
//
// `watchWindows` is the account's own `user_prefs.watch_windows` (Where & when you'll watch) — null means
// no row yet, read the same way the app's own loadUserPrefs() treats an absent row: engine defaults only.
//
// Response shape: { "<cascadeId>::<movieId>": "<window key>" | null, ... } — flat, keyed the same way the
// app's own agentFilmKey(cascadeId, movieId) is, one entry per requested placement.
import { loadEngine } from "../tests/js/engine.mjs";

async function readStdin(){
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(){
  const raw = await readStdin();
  const req = raw.trim() ? JSON.parse(raw) : {};
  const E = loadEngine();
  const movies = req.movies || {};
  const out = {};

  for(const user of (req.users || [])){
    E.setWatchPrefs({ ...E.watchPrefsDefaults(), ...E.migrateWatch(user.watchWindows || {}) });

    for(const p of (user.placements || [])){
      const key = p.cascadeId + "::" + p.movieId;
      const m = movies[String(p.movieId)];
      if(!m){ out[key] = null; continue; }
      const c = E.normCascade(JSON.parse(JSON.stringify(p.criteria || {})));
      out[key] = E.autoPlacementForAdmission(c, m, p.admissionScore);
    }
  }

  process.stdout.write(JSON.stringify(out));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

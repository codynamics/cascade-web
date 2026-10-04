// CAS-825: ask the SHIPPED engine (the same one the app runs) which films each agent admits, instead of
// re-porting matchesCriteria's rules into Python a second time — that second port is exactly what let
// monitor/matching.py's matcher drift from app_template.html's real one.
//
// Reads one JSON request on stdin, writes one JSON response on stdout, then exits. Invoked once per
// monitor run (see monitor/matching.py's compute_admission) — never once per film or once per agent.
//
// Request shape:
//   {
//     "users": [
//       { "userId": "...", "langs": ["en"] | null, "subServices": [...], "storeServices": [...],
//         "filmStatuses": [{"movie_id": "...", "status": "disliked"|"soso"|"notfor"|"wow"|"enjoyed"|"liked"}, ...],
//         "servicesOnly": true|false,
//         "agents": [ { "id": "<cascade id>", "criteria": {...} }, ... ] },
//       ...
//     ],
//     "catalogues": { "<snapshot label, e.g. today/yesterday>": [ <movie dict>, ... ], ... }
//   }
//
// `langs: null` means "no user_prefs row" — left alone so the engine's own permissive default
// (baseDefaults().langs, English-only) applies, exactly as it would for a device that never opened the
// Languages screen. subServices/storeServices/filmStatuses/servicesOnly absent or empty mean the same
// "never touched this" default the app itself would show — servicesOnly absent leaves E.prefs.on at the
// engine's own default (off).
//
// Response shape:
//   { "<cascade id>": { "<snapshot label>": ["<tmdb_id>", ...], ... }, ... }
import { loadEngine } from "../tests/js/engine.mjs";

async function readStdin(){
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function admittedIds(E, criteria, movies){
  // normCascade fills in the full agent shape (every field matchesCriteria reads, e.g. c.age/c.year/
  // c.exclude/c.watchMarkers) exactly as the app does on every load — a Supabase criteria row is only
  // ever partial (an agent created before a field existed, a hand-built fixture), and matchesCriteria
  // itself assumes normCascade has already run, same as it does for every agent object in the app.
  const c = E.normCascade(JSON.parse(JSON.stringify(criteria || {})));
  const out = [];
  for(const m of movies){
    // Score gate always ON (CAS-825 change item 1) — the app never shows a film that fails it, so an
    // admission answer that ignored it would still disagree with what the app itself lists.
    // CAS-1195: matchesCriteria alone waives the Awards requirement for a pre-release film (CAS-780,
    // correct for WATCHES) — but admission here answers "would the LISTING show this film", which also
    // demands awardsListOK's no-exemption re-check, same as listedBy does for the app's own list.
    if(E.matchesCriteria(m, c, false, false) && E.awardsListOK(m, c)) out.push(String(m.tmdb_id));
  }
  return out;
}

async function main(){
  const raw = await readStdin();
  const req = raw.trim() ? JSON.parse(raw) : {};
  const E = loadEngine();
  const catalogues = req.catalogues || {};
  const out = {};

  for(const user of (req.users || [])){
    if(Array.isArray(user.langs)) E.tasteBase.langs = user.langs;
    E.prefs.sub.clear();
    (user.subServices || []).forEach(s => E.prefs.sub.add(s));
    E.prefs.store.clear();
    (user.storeServices || []).forEach(s => E.prefs.store.add(s));
    // CAS-853: the account-level "only show films on my services" switch — matchesCriteria now reads
    // this directly and it governs every agent, not just the ones that copied it into their own myServices.
    E.prefs.on = !!user.servicesOnly;
    // applyFilmRows lives inside the account-sync closure, not at the engine's top level — reached
    // the same way the rest of that surface is (CascadePersistence), per tests/js/engine.mjs's own
    // comment on watchRows/applyWatchRows just above its `found` export.
    E.CascadePersistence.applyFilmRows(user.filmStatuses || []);

    for(const agent of (user.agents || [])){
      const bySnapshot = {};
      for(const [label, movies] of Object.entries(catalogues)){
        bySnapshot[label] = admittedIds(E, agent.criteria, movies || []);
      }
      out[agent.id] = bySnapshot;
    }
  }

  process.stdout.write(JSON.stringify(out));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

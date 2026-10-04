// CAS-1196: ask the shipped engine, ONCE, for the Cascade score of each film the digest is about to
// show — the same number cascadeScore(m) prints on the film's own card in the app (CAS-825's reasoning
// for admit_shim.mjs applies here too: a hand-ported second copy of the score arithmetic is exactly
// what would let the email quietly disagree with the app).
//
// loadEngine() loads the BUILT index.html (tests/js/engine.mjs), so its MOVIES global is whatever
// catalogue the last build baked in. The monitor's own run order makes that today's catalogue: the daily
// job builds index.html from the day's movies.json before it runs the monitor (see daily.yml) — the same
// assumption compute_admission()'s admit_shim.mjs already relies on for its own engine answers.
//
// Reads one JSON request on stdin: {"movieIds": ["<tmdb_id>", ...]}.
// Writes one JSON response on stdout: {"<tmdb_id>": <score>|null, ...} — null for a film not in the
// shipped catalogue, or one cascadeScore itself scores -1 (no score yet — honesty guardrail, never a
// fabricated number).
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
  const out = {};
  for(const id of (req.movieIds || [])){
    const m = E.filmByMovieId(id);
    if(!m){ out[id] = null; continue; }
    const score = E.cascadeScore(m);
    out[id] = score >= 0 ? score : null;
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

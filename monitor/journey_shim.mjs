// CAS-1554: the Cascade score of the film EXACTLY AS THE JOURNEY HAS MOVED IT. score_shim.mjs looks a film up in
// the engine's own embedded catalogue (E.filmByMovieId), which would score the real film's real status; a journey
// film is a temporary variant (different status/dates/offers), so its score must be asked of the same shipped
// engine function (E.cascadeScore) on the variant itself.
//
// Reads {"movies": [<movie dict>, ...]} on stdin; writes {"<tmdb_id>": <score>|null, ...} (null = unscored).
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
  for(const m of (req.movies || [])){
    const score = E.cascadeScore(m);
    out[String(m.tmdb_id)] = score >= 0 ? score : null;
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

// CAS-1592: the app's OWN Taste-card decision (rnudgeDecide / rnudgeBestAdjustment, CAS-1566) asked of the built
// index.html for each member, so the email's "<agent> has learned something" line never re-derives a taste score
// in Python. For each member the shim loads the same account verdicts the app holds after sign-in
// (applyFilmRows), then asks: how many Watched ratings (rnudgeRatingsCount), what is the strongest genre-pair
// adjustment (rnudgeBestAdjustment), and does rnudgeDecide say "taste" for a signed-in account that has not
// been shown the card.
//
// Request (stdin JSON):  {"users": [{"userId", "filmStatuses": [{"movie_id","status"}]}]}
// Response (stdout JSON): {"<userId>": {"ratings": <n>, "pts": <int|null>, "text": "<line>|null"}}
// `text` is non-null exactly when the app would show its Taste card for the same data.
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
  E.CascadePersistence.accountActive = () => true;
  const out = {};
  for(const user of (req.users || [])){
    E.CascadePersistence.applyFilmRows(user.filmStatuses || []);
    const ratings = E.rnudgeRatingsCount();
    const adj = ratings >= 10 ? E.rnudgeBestAdjustment() : null;
    const kind = E.rnudgeDecide({ signedIn: true, now: Date.now(), createdAt: null, ratings, adj,
      seen: { rem: 0, taste: false }, tutorialShownThisVisit: false, cardShownThisVisit: false, blocked: false });
    out[user.userId] = { ratings, pts: adj ? adj.pts : null, text: kind === "taste" && adj ? adj.text : null };
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

// CAS-1535: the day +1 catch-up picks, asked of the SHIPPED engine (the same one the app runs) rather than
// re-ported into Python - a hand-ported copy of the Me list's membership/cap/sort is exactly what would
// let the catch-up email name films the member's own Me list does not show.
//
// HOW IT REPRODUCES THE ME LIST. For each member the shim loads the same account state the app holds
// after sign-in (services, film verdicts, language taste, the one v2 agent's criteria, the "me" mood out
// of user_prefs.view.moods), points the engine at one stage's tab, and runs the app's own pipeline:
//     oamVisibleRows()  - membership (filmInOneAgentMood) + the Show cap (oamApplyShowCap), then
//     listingGroups()   - the section split and the list's own sort (the Me mood's `sort`, via
//                         applyMoodToState exactly as selecting the mood does; "you" = the member's taste
//                         score, so window.CascadePersistence.accountActive() is answered true here,
//                         as it is for a signed-in device).
// The flattened listingGroups order is "the list's own order". Only then does the SERVER's rule apply
// (it is not the app's): drop every film the member has any verdict on (watched, or Not for me), and cap
// per stage - 3 in cinemas now, 5 coming to cinemas, 10 streaming. Streaming also keeps only films
// included (sub/free) on one of the member's OWN services.
//
// Request (stdin JSON):  {"users": [{"userId","langs","subServices","storeServices","servicesOnly",
//     "filmStatuses":[{"movie_id","status"}], "criteria": {...the agent's criteria...},
//     "moods": [...user_prefs.view.moods...] | null}]}
// Response (stdout JSON): {"<userId>": {"cinema": [<tmdb_id>...], "coming": [...], "streaming": [...]}}
// A member with no v2 agent, or whose moods exist but hold no "me" list, gets all three groups empty.
import { loadEngine } from "../tests/js/engine.mjs";

const CAPS = { cinema: 3, coming: 5, streaming: 10 };
// stage key -> [watch tab, cinema half]
const STAGES = {
  cinema: ["in_cinema", "in_cinema"],
  coming: ["in_cinema", "upcoming"],
  streaming: ["stream", "in_cinema"],
};

async function readStdin(){
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function meMoodFor(E, moods){
  if(Array.isArray(moods) && moods.length){
    const found = moods.find(m => m && m.id === "me");
    return found ? { ...E.oamMoodDefaultFields(), ...found, v2: true } : null;
  }
  // No provisioned moods at all: the app's own starter Me list.
  return E.oneAgentStarterMoods({}, []).find(m => m.id === "me") || null;
}

function stageIds(E, stage, mood, held, subServices){
  const [tab, half] = STAGES[stage];
  E.setWatchTab(tab);
  E.setWatchCinemaStage(half);
  const { rows } = E.oamVisibleRows();
  const ordered = E.listingGroups(rows, null).flatMap(g => g.items);
  const own = new Set(subServices || []);
  const out = [];
  for(const m of ordered){
    if(held.has(String(m.tmdb_id))) continue;
    if(stage === "streaming"){
      const onOwn = (m.offers || []).some(o => (o.type === "sub" || o.type === "free") && own.has(E.svcCanon(o.service)));
      if(!onOwn) continue;
    }
    out.push(String(m.tmdb_id));
    if(out.length >= CAPS[stage]) break;
  }
  return out;
}

async function main(){
  const raw = await readStdin();
  const req = raw.trim() ? JSON.parse(raw) : {};
  const E = loadEngine();
  const out = {};
  // A signed-in device: the "you" sort (the member's taste score) only means anything with an account.
  E.CascadePersistence.accountActive = () => true;

  for(const user of (req.users || [])){
    const empty = { cinema: [], coming: [], streaming: [] };
    out[user.userId] = empty;
    if(!user.criteria) continue;
    if(Array.isArray(user.langs)) E.tasteBase.langs = user.langs;
    E.prefs.sub.clear();
    (user.subServices || []).forEach(s => E.prefs.sub.add(s));
    E.prefs.store.clear();
    (user.storeServices || []).forEach(s => E.prefs.store.add(s));
    E.prefs.on = !!user.servicesOnly;
    E.CascadePersistence.applyFilmRows(user.filmStatuses || []);
    const held = new Set((user.filmStatuses || []).map(r => String(r.movie_id)));

    const mood = meMoodFor(E, user.moods);
    if(!mood) continue;
    // The one v2 agent (oneAgentCriteria() finds it by v === 2), and the Me list as the selected mood.
    E.cascades.length = 0;
    E.cascades.push({ ...E.normCascade(JSON.parse(JSON.stringify(user.criteria))), v: 2 });
    E.watchMoods.length = 0;
    E.watchMoods.push(mood);
    E.applyMoodToState(mood);

    for(const stage of Object.keys(STAGES)) empty[stage] = stageIds(E, stage, mood, held, user.subServices);
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

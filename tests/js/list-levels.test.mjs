// CAS-1593 (rewritten by CAS-1690): a list owns its genres. The five-stop levels are retired; each genre is Off,
// Include (top 25%) or Favourite (every scored film), turned into a score with oneBarForTopPct everywhere, saved
// per list — and for Latest and Best, saved into the agent's bars in the same save.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();
const NO_AL = { cinema:false, rent:false, stream:false };

function criteriaWith(styles){
  return { id:"cas1593-fixture", name:"Agent", v:2, styles, combo:{}, seenAdj:{}, dismissed:[] };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"cas1593-mood", name:"Test list", ...overrides };
}
let _id = 159300001;
function film(genre, wmUserRating){
  return { tmdb_id:_id++, title:"CAS-1593 fixture", genres:[genre], status:["included_streaming"],
    wm_critic_score:null, wm_user_rating:wmUserRating, _fixture:true, availability_confidence:"confirmed",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}] };
}
// A single-genre film whose agent score is exactly `score` (the People rating maps monotonically onto it).
function filmScoring(genre, score){
  const c = criteriaWith({ [genre]:{ bar:1, al:NO_AL } });
  for(let r = 1; r <= 10; r += 0.01){
    const f = film(genre, Math.round(r*100)/100);
    if(E.oneScore(f, c) === score) return f;
  }
  throw new Error(`no fixture film scores exactly ${score} in ${genre}`);
}
function withV2Agent(fn){
  const savedCascades = [...E.cascades];
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  const savedSel = E.watchMoodSel;
  E.cascades.length = 0;
  const c = criteriaWith({});
  E.cascades.push(c);
  try { return fn(c); }
  finally {
    E.cascades.length = 0; savedCascades.forEach(x => E.cascades.push(x));
    E.watchMoods.length = 0; savedMoods.forEach(m => E.watchMoods.push(m));
    if (E.watchMoodSel !== savedSel && E.watchMoods.some(m => m.id === savedSel)) E.window.setWatchMood(savedSel);
  }
}

test("CAS-1593 (CAS-1690) AC1b: an Include genre admits a film at the Top 25% score and rejects one scoring 1 less", () => {
  const bar = E.oneBarForTopPct("Comedy", 25);
  const c = criteriaWith({ Comedy:{ bar:1, al:NO_AL } });
  const mood = moodWith({ styles:["Comedy"] });
  assert.equal(E.oamFilmMeetsMoodRules(filmScoring("Comedy", bar), mood, c), true, "exactly the bar is in");
  assert.equal(E.oamFilmMeetsMoodRules(filmScoring("Comedy", bar - 1), mood, c), false, "one below is out");
});

test("CAS-1593: a list other than Latest and Best shows a Romance film even when the agent's Romance bar is null", () => {
  const c = criteriaWith({ Romance:{ bar:null, al:NO_AL } });
  const m = filmScoring("Romance", 90);
  const mood = moodWith({ styles:["Romance"], favs:["Romance"] });
  assert.equal(E.oamFilmMeetsMoodRules(m, mood, c), true);
  // Latest and Best keeps the agent gate: its ticks ARE the agent's on/off.
  assert.equal(E.oamFilmMeetsMoodRules(m, { ...mood, id:"releases", favs:[] }, c), false);
});

test("CAS-1593 (CAS-1690) AC1d: saving Latest and Best writes the agent — Include sets the bar and leaves al; Off sets it null and keeps lastAl", () => withV2Agent(c => {
  const lastAl = { cinema:true, rent:false, stream:true };
  c.styles.Action = { bar:null, al:NO_AL, lastBar:70, lastAl };
  E.window.openOamMoodSheetFor("releases");
  E.oamDraft.picks.Action = "incl";
  E.window.oamSaveMoodFromSheet();
  assert.equal(c.styles.Action.bar, E.oneBarForTopPct("Action", 25));
  assert.deepEqual({ ...c.styles.Action.al }, NO_AL, "Include does not change the alerts");

  E.window.openOamMoodSheetFor("releases");
  assert.equal(E.oamDraftTicked(E.oamDraft, "Action"), true, "Latest and Best's ticks are the agent's");
  delete E.oamDraft.picks.Action;
  E.window.oamSaveMoodFromSheet();
  assert.equal(c.styles.Action.bar, null);
  assert.equal(c.styles.Action.lastBar, E.oneBarForTopPct("Action", 25));
}));

test("CAS-1593 (CAS-1690): Save writes levels:null and nothing reads a stored levels", () => withV2Agent(c => {
  E.window.openOamMoodSheetFor("releases");
  E.window.oamSaveMoodFromSheet();
  const saved = E.oamMoodsListReal().find(m => m.id === "releases");
  assert.equal(saved.levels, null);
  assert.equal(E.oamMoodBarFor({ ...saved, levels:{ Action:5 } }, c, "Action"), E.oamMoodBarFor(saved, c, "Action"));
}));

test("CAS-1593 (CAS-1690) AC1f: a new list's ticks and favourites equal Latest and Best's", () => withV2Agent(c => {
  c.styles.Action = { bar:E.oneBarForTopPct("Action", 10), al:NO_AL, fav:true };
  c.styles.Comedy = { bar:E.oneBarForTopPct("Comedy", 50), al:NO_AL };
  const d = E.oamMoodDraftFrom(null);
  assert.deepEqual({ ...d.picks }, { Action:"fav", Comedy:"incl" }, "ticked exactly where the agent bar is non-null, ♥ where oaFav");
}));

test("CAS-1593 (CAS-1690): the list sheet is the onboarding grid — one favcell per setup genre, no five-stop rows", () => withV2Agent(c => {
  c.styles.Action = { bar:50, al:NO_AL };
  E.window.openOamMoodSheetFor("releases");
  const grid = E.oafFavGridCellsHTML(E.oamDraft.picks);
  assert.equal((grid.match(/class="favcell/g) || []).length, E.ONE_AGENT_SETUP_STYLES.length);
  assert.ok(!/oamlvl|lvseg|favalert/.test(grid), "no five-stop track and no Alerts-on sub-line");
}));

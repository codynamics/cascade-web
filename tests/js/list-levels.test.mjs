// CAS-1593: a list owns its genre levels. Five stops (5/10/25/50/All, stored 5/10/25/50/100), read through
// oamMoodLevel, turned into a score with oneBarForTopPct everywhere (admission, display, the agent bar), saved
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

test("CAS-1593 AC1a: snapPct maps to the nearest of 5/10/25/50/100, a tie taking the smaller", () => {
  const cases = [[1,5],[7,5],[8,10],[17,10],[18,25],[37,25],[38,50],[75,50],[76,100],[100,100]];
  cases.forEach(([p, want]) => assert.equal(E.snapPct(p), want, `snapPct(${p})`));
});

test("CAS-1593 AC1b: a list with levels:{Comedy:5} admits a Comedy film at the Top 5% score and rejects one scoring 1 less", () => {
  const bar = E.oneBarForTopPct("Comedy", 5);
  const c = criteriaWith({ Comedy:{ bar:1, al:NO_AL } });
  const mood = moodWith({ levels:{ Comedy:5 } });
  assert.equal(E.oamFilmMeetsMoodRules(filmScoring("Comedy", bar), mood, c), true, "exactly the bar is in");
  assert.equal(E.oamFilmMeetsMoodRules(filmScoring("Comedy", bar - 1), mood, c), false, "one below is out");
});

test("CAS-1593 AC1c: a list other than Latest and Best shows a Romance film even when the agent's Romance bar is null", () => {
  const c = criteriaWith({ Romance:{ bar:null, al:NO_AL } });
  const m = filmScoring("Romance", 90);
  const mood = moodWith({ styles:["Romance"], levels:{ Romance:100 } });
  assert.equal(E.oamFilmMeetsMoodRules(m, mood, c), true);
  // Latest and Best keeps the agent gate: its ticks ARE the agent's on/off.
  assert.equal(E.oamFilmMeetsMoodRules(m, { ...mood, id:"releases" }, c), false);
});

test("CAS-1593 AC1d: saving Latest and Best writes the agent — ticked sets the bar from the level, unticked sets it null and keeps lastAl", () => withV2Agent(c => {
  const lastAl = { cinema:true, rent:false, stream:true };
  c.styles.Action = { bar:null, al:NO_AL, lastBar:70, lastAl };
  E.window.openOamMoodSheetFor("releases");
  E.window.toggleOamDraftStyle("Action");                 // tick it
  E.oamDraft.levels.Action = 25;
  E.window.oamSaveMoodFromSheet();
  assert.equal(c.styles.Action.bar, E.oneBarForTopPct("Action", 25));
  assert.deepEqual({ ...c.styles.Action.al }, lastAl, "alerts restored from lastAl when the genre was off");

  E.window.openOamMoodSheetFor("releases");
  assert.equal(E.oamDraftTicked(E.oamDraft, "Action"), true, "Latest and Best's ticks are the agent's");
  E.window.toggleOamDraftStyle("Action");                 // untick it
  E.window.oamSaveMoodFromSheet();
  assert.equal(c.styles.Action.bar, null);
  assert.deepEqual({ ...c.styles.Action.lastAl }, lastAl, "lastAl is kept");
  assert.equal(c.styles.Action.lastBar, E.oneBarForTopPct("Action", 25));
}));

test("CAS-1593 AC1e: a list with topShare:20 and no levels reads every genre at 25; with neither, the agent's bar's level", () => {
  const c = criteriaWith({ Action:{ bar:80, al:NO_AL }, Drama:{ bar:null, al:NO_AL } });
  const legacy = moodWith({ topShare:20 });
  ["Action", "Drama", "Comedy"].forEach(g => assert.equal(E.oamMoodLevel(legacy, c, g), 25, g));
  const neither = moodWith({});
  assert.equal(E.oamMoodLevel(neither, c, "Action"), E.snapPct(E.oneTopPct("Action", 80)));
  assert.equal(E.oamMoodLevel(neither, c, "Drama"), 25, "no bar, no topShare: 25");
  assert.equal(E.oamMoodLevel(moodWith({ levels:{ Action:10 }, topShare:20 }), c, "Action"), 10, "its own level wins");
});

test("CAS-1593 AC1f: a new list's levels and ticks equal Latest and Best's", () => withV2Agent(c => {
  c.styles.Action = { bar:E.oneBarForTopPct("Action", 10), al:NO_AL };
  c.styles.Comedy = { bar:E.oneBarForTopPct("Comedy", 50), al:NO_AL };
  const releases = E.oamMoodsListReal().find(m => m.id === "releases");
  const d = E.oamMoodDraftFrom(null);
  Object.keys(d.levels).forEach(g => assert.equal(d.levels[g], E.oamMoodLevel(releases, c, g), g));
  assert.equal(d.levels.Action, E.snapPct(E.oneTopPct("Action", c.styles.Action.bar)));
  assert.equal(d.stylesAll, false);
  assert.deepEqual([...d.styles].sort(), ["Action", "Comedy"], "ticked exactly where the agent bar is non-null");
}));

test("CAS-1593: the list sheet rows carry no thumb, Override or Taste link, and the genre name is not a label", () => withV2Agent(c => {
  c.styles.Action = { bar:50, al:NO_AL };
  E.window.openOamMoodSheetFor("releases");
  const row = E.oamStyleRowHTML(c, E.oamDraft, "Action");
  assert.ok(!/oamthumb|oamlvlseg|oamtastelink|<label/.test(row), "no thumb, Override segment, Taste link or label wrapper");
  assert.match(row, /Top \d+%|All/);
  assert.match(E.oamAllBoxHTML(E.oamDraft), /Set all genres/);
}));

// CAS-1690: each genre in a list is Off, Include (top 25%) or Favourite (every scored film, +5 in list ordering,
// alerts on for Latest and Best). Asserts admission, ordering, Best N, the agent write, the favs fallback, All on.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();
const NO_AL = { cinema:false, rent:false, stream:false };

function criteriaWith(styles){
  return { id:"cas1690-fixture", name:"Agent", v:2, styles, combo:{}, seenAdj:{}, dismissed:[] };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"cas1690-mood", name:"Test list", ...overrides };
}
let _id = 169000001;
function film(genre, wmUserRating){
  return { tmdb_id:_id++, title:"CAS-1690 fixture", genres:[genre], status:["included_streaming"],
    wm_critic_score:null, wm_user_rating:wmUserRating, _fixture:true, availability_confidence:"confirmed",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}] };
}
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

test("CAS-1690 AC1a: an Include genre admits a film at oneBarForTopPct(g,25) and rejects one scoring 1 less", () => {
  const bar = E.oneBarForTopPct("Drama", 25);
  const c = criteriaWith({ Drama:{ bar:1, al:NO_AL } });
  const mood = moodWith({ styles:["Drama"] });
  assert.equal(E.oamFilmMeetsMoodRules(filmScoring("Drama", bar), mood, c), true);
  assert.equal(E.oamFilmMeetsMoodRules(filmScoring("Drama", bar - 1), mood, c), false);
});

test("CAS-1690 AC1b: a Favourite genre admits a film scoring 50 in that genre", () => {
  const c = criteriaWith({ Drama:{ bar:1, al:NO_AL } });
  const mood = moodWith({ styles:["Drama"], favs:["Drama"] });
  assert.ok(E.oneBarForTopPct("Drama", 25) > 50, "sanity: 50 is below the Include line");
  assert.equal(E.oamFilmMeetsMoodRules(filmScoring("Drama", 50), mood, c), true);
});

test("CAS-1690 AC1c: an Off genre admits nothing", () => {
  const c = criteriaWith({ Drama:{ bar:1, al:NO_AL }, Comedy:{ bar:1, al:NO_AL } });
  const mood = moodWith({ styles:["Comedy"] });
  assert.equal(E.oamFilmMeetsMoodRules(filmScoring("Drama", 99), mood, c), false);
  assert.equal(E.oamMoodGenreState(mood, c, "Drama"), "off");
});

test("CAS-1690 AC1d: oamOrderScore is score+5 for a Favourite-genre film in that list, else the score; the shown score is unchanged", () => {
  const c = criteriaWith({ Drama:{ bar:1, al:NO_AL }, Comedy:{ bar:1, al:NO_AL } });
  const mood = moodWith({ styles:["Drama","Comedy"], favs:["Drama"] });
  const dr = filmScoring("Drama", 70), co = filmScoring("Comedy", 70);
  assert.equal(E.oamOrderScore(dr, c, mood), 75);
  assert.equal(E.oamOrderScore(co, c, mood), 70);
  assert.equal(E.oneScore(dr, c), 70, "the shown score is untouched");
  assert.equal(E.oamOrderScore(dr, c, moodWith({ styles:["Drama"] })), 70, "not a Favourite in a list that doesn't favour it");
});

test("CAS-1690 AC1e: in a Best 40 list, making a genre a Favourite never reduces its count of films", () => {
  const c = criteriaWith({ Drama:{ bar:1, al:NO_AL }, Comedy:{ bar:1, al:NO_AL } });
  const rows = [];
  for (let s = 60; s < 90; s++) { rows.push(filmScoring("Comedy", s)); }
  for (let s = 55; s < 85; s++) { rows.push(filmScoring("Drama", s)); }
  const count = (mood) => E.oamApplyShowCap(rows, mood, c, new Set()).filter(m => m.genres[0] === "Drama").length;
  const plain = moodWith({ show:"40", styles:["Drama","Comedy"] });
  const fav = moodWith({ show:"40", styles:["Drama","Comedy"], favs:["Drama"] });
  assert.ok(count(fav) >= count(plain));
  assert.ok(count(fav) > count(plain), "with this fixture the +5 actually lifts Drama into the cut");
});

test("CAS-1690 AC1f: saving Latest and Best with Action as Favourite writes bar=top 100% and all three alerts; as Off, bar null and lastAl kept", () => withV2Agent(c => {
  const lastAl = { cinema:true, rent:false, stream:true };
  c.styles.Action = { bar:null, al:{ ...lastAl }, lastBar:70, lastAl };
  E.window.openOamMoodSheetFor("releases");
  E.oamDraft.picks.Action = "fav";
  E.window.oamSaveMoodFromSheet();
  assert.equal(c.styles.Action.bar, E.oneBarForTopPct("Action", 100));
  assert.deepEqual({ ...c.styles.Action.al }, { cinema:true, rent:true, stream:true });
  assert.equal(E.oamMoodsListReal().find(m => m.id === "releases").favs.includes("Action"), true);

  E.window.openOamMoodSheetFor("releases");
  delete E.oamDraft.picks.Action;
  E.window.oamSaveMoodFromSheet();
  assert.equal(c.styles.Action.bar, null);
  assert.deepEqual({ ...c.styles.Action.lastAl }, { cinema:true, rent:true, stream:true }, "lastAl is the alerts it had when switched off");
}));

test("CAS-1690 AC1g: a Latest and Best list with no favs reads the oaFav genres; any other list reads []", () => {
  const c = criteriaWith({ Action:{ bar:50, al:NO_AL, fav:true }, Drama:{ bar:50, al:NO_AL } });
  assert.deepEqual([...E.oamMoodFavs({ id:"releases" }, c)], ["Action"]);
  assert.equal(E.oamMoodGenreState({ id:"releases" }, c, "Action"), "fav");
  assert.deepEqual([...E.oamMoodFavs({ id:"other" }, c)], []);
  assert.deepEqual([...E.oamMoodFavs({ id:"releases", favs:[] }, c)], [], "a stored favs wins");
});

test("CAS-1690 AC1h: All on turns Off genres to Include and keeps Favourites; All off clears everything", () => withV2Agent(c => {
  c.styles.Action = { bar:50, al:NO_AL, fav:true };
  E.window.openOamMoodSheetFor("releases");
  E.oamDraft.picks.Drama = "incl";
  E.window.oamAllOn();
  assert.equal(E.oamDraft.picks.Action, "fav", "Favourite kept");
  assert.equal(E.oamDraft.picks.Drama, "incl");
  assert.equal(E.oamDraft.picks.Comedy, "incl", "an Off genre turned to Include");
  E.window.oamAllOff();
  assert.deepEqual({ ...E.oamDraft.picks }, {});
}));

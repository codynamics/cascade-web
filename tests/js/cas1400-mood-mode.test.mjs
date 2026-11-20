// CAS-1400: a mood finds films EITHER by genre OR by keyword, never both. `mode` is "genre"|"keyword"; absent,
// it defaults to keyword when a people filter is set, else genre. In genre mode the stored `people` text is
// ignored for membership; in keyword mode the CAS-1396 people path applies.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

const NO_AL = { cinema:false, rent:false, stream:false };
function criteria(){
  return { id:"cas1400-fixture", name:"Agent", v:2, styles:{ Action:{ bar:1, al:NO_AL } }, combo:{} };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"cas1400-mood", name:"Test mood", ...overrides };
}
let _nextId = 94000001;
function film(style, overrides){
  return { tmdb_id:_nextId++, title:"CAS-1400 fixture", genres:[style], status:["included_streaming"],
    wm_critic_score:null, wm_user_rating:9, _fixture:true, availability_confidence:"confirmed",
    cast:["Tom Cruise"], director:"",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}], ...overrides };
}

test("CAS-1400 AC1: mode:\"genre\" with a non-empty people ignores people (a Drama film, genre off in the agent, stays out)", () => {
  const c = criteria();
  const dramaCruise = film("Drama");                       // Drama is off in the agent
  const actionOther = film("Action", { cast:["Someone Else"] });   // genre on, does not match the people text
  const mood = moodWith({ mode:"genre", people:"Tom Cruise" });
  assert.equal(E.filmInOneAgentMood(dramaCruise, mood, c), false, "people is ignored: genre rules apply");
  assert.equal(E.filmInOneAgentMood(actionOther, mood, c), true, "people is ignored: a non-matching film in an on genre is listed");
});

test("CAS-1400 AC1: mode:\"keyword\" takes the CAS-1396 people path, ignoring genres", () => {
  const c = criteria();
  const dramaCruise = film("Drama");
  const actionOther = film("Action", { cast:["Someone Else"] });
  const mood = moodWith({ mode:"keyword", people:"Tom Cruise" });
  assert.equal(E.filmInOneAgentMood(dramaCruise, mood, c), true);
  assert.equal(E.filmInOneAgentMood(actionOther, mood, c), false);
});

test("CAS-1400 AC1: mode absent defaults to keyword when people is set, else genre", () => {
  const c = criteria();
  const dramaCruise = film("Drama");
  assert.equal(E.oamMoodMode(moodWith({ people:"Tom Cruise" })), "keyword");
  assert.equal(E.oamMoodMode(moodWith({ people:"  " })), "genre");
  assert.equal(E.oamMoodMode(moodWith({})), "genre");
  assert.equal(E.filmInOneAgentMood(dramaCruise, moodWith({ people:"Tom Cruise" }), c), true);
  assert.equal(E.filmInOneAgentMood(dramaCruise, moodWith({ people:"" }), c), false);
});

// Lee, 2026-11-20 (replaces "people survives a genre save"): the name box decides the mode. A draft with a name
// saves as keyword; an empty box saves as genre; a genre list opens with an empty box, so no ignored keyword lingers.
test("Lee 2026-11-20: Save's mode comes from the name box; a genre list's draft carries no leftover keyword", () => {
  const withPeople = E.oamMoodDraftFrom({ ...moodWith({ people:"Tom Cruise" }) });
  assert.equal(withPeople.mode, "keyword");
  assert.equal(E.oamMoodDraftFrom(null).mode, "genre");
  const kept = E.oamMoodFromDraft(withPeople);
  assert.equal(kept.mode, "keyword");
  assert.equal(kept.people, "Tom Cruise");
  withPeople.people = "";
  const cleared = E.oamMoodFromDraft(withPeople);
  assert.equal(cleared.mode, "genre");
  assert.equal(cleared.people, "");
  const genreWithLeftover = E.oamMoodDraftFrom({ ...moodWith({ mode:"genre", people:"Adam Sandler" }) });
  assert.equal(genreWithLeftover.mode, "genre");
  assert.equal(genreWithLeftover.people, "");
});

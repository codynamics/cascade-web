// CAS-1396: a mood with a title/actor/director filter is a search, not an agent-scoped mood — it lists
// every catalogue film matching that filter, whatever the agent's genre on/off, score bars, combo `never`
// or the mood's own genre ticks / Mood Override Filter say. Blocked/watched/services and the mood's own
// ages/awards/years gates still apply, exactly as CAS-1390 left them.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(styles){
  return { id:"cas1396-fixture", name:"Agent", v:2, styles, combo:{} };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"cas1396-mood", name:"Test mood", ...overrides };
}
let _nextId = 91960001;
function film(style, overrides){
  return { tmdb_id:_nextId++, title:"CAS-1396 fixture", genres:[style], status:["included_streaming"],
    wm_critic_score:null, wm_user_rating:9, _fixture:true, availability_confidence:"confirmed",
    cast:["Tom Cruise"], director:"",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}], ...overrides };
}
function withBlocked(id, fn){
  const saved = new Set(E.blocked);
  E.blocked.clear(); E.blocked.add(id);
  try{ return fn(); } finally{ E.blocked.clear(); saved.forEach(x => E.blocked.add(x)); }
}
function withWatched(id, fn){
  const saved = new Set(E.watched);
  E.watched.clear(); E.watched.add(id);
  try{ return fn(); } finally{ E.watched.clear(); saved.forEach(x => E.watched.add(x)); }
}

test("CAS-1396 AC1: a people mood includes a Tom Cruise film scoring below the agent's bar, and one in a genre the agent has off", () => {
  const belowBar = film("Action");
  // A bar one point above what this fixture actually scores — same device cas1364 uses — so the agent's
  // own admission genuinely rejects it on score alone, with no guess at the scoring formula's scale.
  const score = E.oneScore(belowBar, criteriaWith({ Action:{ bar:1, al:{cinema:false,rent:false,stream:false} } }));
  const c = criteriaWith({ Action:{ bar:score+1, al:{cinema:false,rent:false,stream:false} } }); // Drama left off entirely
  const dramaOff = film("Drama");
  const mood = moodWith({ people:"Tom Cruise" });
  assert.equal(E.oamFilmMeetsMoodRules(belowBar, mood, c), true, "scores below the agent's bar, but the people filter ignores the bar");
  assert.equal(E.oamFilmMeetsMoodRules(dramaOff, mood, c), true, "Drama is off in the agent, but the people filter ignores genre on/off entirely");
});

test("CAS-1396 AC1: the same mood with people:\"\" includes neither film (today's agent-scoped behaviour)", () => {
  const belowBar = film("Action");
  const score = E.oneScore(belowBar, criteriaWith({ Action:{ bar:1, al:{cinema:false,rent:false,stream:false} } }));
  const c = criteriaWith({ Action:{ bar:score+1, al:{cinema:false,rent:false,stream:false} } });
  const dramaOff = film("Drama");
  const mood = moodWith({ people:"" });
  assert.equal(E.oamFilmMeetsMoodRules(belowBar, mood, c), false);
  assert.equal(E.oamFilmMeetsMoodRules(dramaOff, mood, c), false);
});

test("CAS-1396 AC1: a blocked Tom Cruise film is excluded from a people mood", () => {
  const c = criteriaWith({ Action:{ bar:1, al:{cinema:false,rent:false,stream:false} } });
  const m = film("Action");
  const mood = moodWith({ people:"Tom Cruise" });
  withBlocked(m.tmdb_id, () => {
    assert.equal(E.oamFilmMeetsMoodRules(m, mood, c), false);
  });
});

test("CAS-1396 AC1: a watched Tom Cruise film is excluded from a people mood unless watched:true", () => {
  const c = criteriaWith({ Action:{ bar:1, al:{cinema:false,rent:false,stream:false} } });
  const m = film("Action");
  withWatched(m.tmdb_id, () => {
    assert.equal(E.oamFilmMeetsMoodRules(m, moodWith({ people:"Tom Cruise", watched:false }), c), false);
    assert.equal(E.oamFilmMeetsMoodRules(m, moodWith({ people:"Tom Cruise", watched:true }), c), true);
  });
});

test("CAS-1396 AC1: a people mood with ages:[\"G\"] excludes an M-rated match", () => {
  const c = criteriaWith({ Action:{ bar:1, al:{cinema:false,rent:false,stream:false} } });
  const m = film("Action", { age_rating:"M" });
  const mood = moodWith({ people:"Tom Cruise", ages:["G"] });
  assert.equal(E.oamFilmMeetsMoodRules(m, mood, c), false);
});

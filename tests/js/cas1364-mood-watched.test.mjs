// CAS-1364: "Include films I've watched" — a per-mood switch (mood.watched) that, when on, judges a
// watched film as if it were unwatched for THAT mood's own membership, without touching the agent's own
// criteria (so alerts, which never read mood.watched, are unaffected). oamFilmMeetsMoodRules is the one
// chokepoint that applies it (CAS-1364's own excludeWatched:false override, scoped to the admission call);
// filmInOneAgentMood wraps it with hand add/take-out, asserted here too since a watched switch must not
// change that half of membership.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1364-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"cas1364-mood", name:"Test mood", ...overrides };
}
let _nextId = 91640001;
function film(style){
  return { tmdb_id:_nextId++, title:"CAS-1364 fixture", genres:[style], status:["included_streaming"],
    wm_critic_score:null, wm_user_rating:9, _fixture:true, availability_confidence:"confirmed",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}] };
}
function withWatched(id, fn){
  const saved = new Set(E.watched);
  E.watched.clear(); E.watched.add(id);
  try{ return fn(); } finally{ E.watched.clear(); saved.forEach(x => E.watched.add(x)); }
}

test("CAS-1364: a watched film is excluded from a mood whose own watched switch is off (today's behaviour)", () => {
  const c = criteriaWith("Action", 1);
  const m = film("Action");
  withWatched(m.tmdb_id, () => {
    const mood = moodWith({ watched:false });
    assert.equal(E.oamFilmMeetsMoodRules(m, mood, c), false);
    assert.equal(E.filmInOneAgentMood(m, mood, c), false);
  });
});

test("CAS-1364: the same watched film is admitted once that mood's own watched switch is on", () => {
  const c = criteriaWith("Action", 1);
  const m = film("Action");
  withWatched(m.tmdb_id, () => {
    const mood = moodWith({ watched:true });
    assert.equal(E.oamFilmMeetsMoodRules(m, mood, c), true);
    assert.equal(E.filmInOneAgentMood(m, mood, c), true);
  });
});

test("CAS-1364: an unwatched film is unaffected by the switch either way", () => {
  const c = criteriaWith("Action", 1);
  const m = film("Action");
  assert.equal(E.oamFilmMeetsMoodRules(m, moodWith({ watched:false }), c), true);
  assert.equal(E.oamFilmMeetsMoodRules(m, moodWith({ watched:true }), c), true);
});

test("CAS-1364: watched:true still fails every other rule normally — it only lifts the excludeWatched gate", () => {
  const m = film("Action");
  const score = E.oneScore(m, criteriaWith("Action", 1));
  const c = criteriaWith("Action", score + 1);   // a bar one point above what this fixture actually scores
  withWatched(m.tmdb_id, () => {
    assert.equal(E.oamFilmMeetsMoodRules(m, moodWith({ watched:true }), c), false);
  });
});

test("CAS-1364: the agent's own alert gate (oneAgentAlerts) takes no mood at all, so a mood's watched switch structurally can't reach it", () => {
  const c = { id:"cas1364-fixture", name:"Agent", v:2,
    styles:{ Action:{ bar:1, al:{cinema:false,rent:false,stream:true} } }, combo:{} };
  const m = film("Action");
  const saved = [...E.cascades];
  E.cascades.length = 0; E.cascades.push(c);
  try{
    assert.equal(E.oneAgentAlerts(m, "stream"), true, "the agent's own alert switch, read with no mood argument");
  } finally {
    E.cascades.length = 0; saved.forEach(a => E.cascades.push(a));
  }
});

test("CAS-1364: a hand take-out still beats a watched film that the rules (with the switch on) would otherwise admit", () => {
  const c = criteriaWith("Action", 1);
  const m = film("Action");
  withWatched(m.tmdb_id, () => {
    const mood = moodWith({ watched:true, out:[m.tmdb_id] });
    assert.equal(E.filmInOneAgentMood(m, mood, c), false);
  });
});

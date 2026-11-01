// CAS-1365: reinstates the mood sheet's own minimum-score slider — on the score scale, as mood.minScore
// (50-99 or null) — which can only ever raise its agent further, never lower it. oamMoodBarFor is the one
// chokepoint every mood-membership path (oamFilmMeetsMoodRules, and so Watch listing/counts/Where it
// lists/mood alerts) reads the applied bar through, so asserting it directly here covers all of them
// without re-deriving the pipeline. Replaces CAS-1363's cas1363-mood-limit.test.mjs (topShare removed).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1365-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}

test("CAS-1365: with no minScore, oamMoodBarFor returns the agent's own bar unchanged", () => {
  const c = criteriaWith("Action", 55);
  assert.equal(E.oamMoodBarFor({ id:"m1", minScore:null }, c, "Action"), 55);
});

test("CAS-1365: a style the agent has off (bar null) stays off regardless of minScore", () => {
  const c = criteriaWith("Action", null);
  assert.equal(E.oamMoodBarFor({ id:"m1", minScore:75 }, c, "Action"), null);
});

test("CAS-1365: when the mood's own minimum is higher than the agent's bar, oamMoodBarFor raises it", () => {
  const c = criteriaWith("Action", 60);
  assert.equal(E.oamMoodBarFor({ id:"m1", minScore:75 }, c, "Action"), 75);
});

test("CAS-1365: when the agent's own bar is already higher than the mood's minimum, oamMoodBarFor keeps the agent's bar — a mood never lowers its agent", () => {
  const c = criteriaWith("Action", 90);
  assert.equal(E.oamMoodBarFor({ id:"m1", minScore:75 }, c, "Action"), 90);
});

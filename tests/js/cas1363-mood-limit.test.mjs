// CAS-1363: reinstates a mood's own limit — on the CAS-1351 share scale, as mood.topShare (1-99 or null) —
// which can only ever narrow its agent further, never widen it. oamMoodBarFor is the one chokepoint every
// mood-membership path (oamFilmMeetsMoodRules, and so Watch listing/counts/Where it lists/mood alerts) reads
// the applied bar through, so asserting it directly here covers all of them without re-deriving the pipeline.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1363-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}

test("CAS-1363: with no topShare, oamMoodBarFor returns the agent's own bar unchanged", () => {
  const c = criteriaWith("Action", 55);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:null }, c, "Action"), 55);
});

test("CAS-1363: a style the agent has off (bar null) stays off regardless of topShare", () => {
  const c = criteriaWith("Action", null);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:40 }, c, "Action"), null);
});

test("CAS-1363: when the mood's own limit is stricter than the agent's bar, oamMoodBarFor uses the mood's bar", () => {
  const style = "Action";
  const looseAgentBar = E.oneBarForTopPct(style, 80);   // Top 80% — a wide, permissive agent setting
  const strictMoodBar = E.oneBarForTopPct(style, 20);   // Top 20% — the mood's own, stricter, limit
  assert.ok(strictMoodBar >= looseAgentBar, "setup: Top 20% must be at least as strict (as high a score) as Top 80%");
  const c = criteriaWith(style, looseAgentBar);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:20 }, c, style), strictMoodBar);
});

test("CAS-1363: when the agent's own bar is already stricter than the mood's limit, oamMoodBarFor keeps the agent's bar — a mood never widens its agent", () => {
  const style = "Action";
  const strictAgentBar = E.oneBarForTopPct(style, 20);  // Top 20% — a narrow, strict agent setting
  const looseMoodBar = E.oneBarForTopPct(style, 80);    // Top 80% — looser than the agent's own setting
  assert.ok(strictAgentBar >= looseMoodBar, "setup: Top 20% must be at least as strict as Top 80%");
  const c = criteriaWith(style, strictAgentBar);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:80 }, c, style), strictAgentBar);
});

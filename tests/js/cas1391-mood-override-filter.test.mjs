// CAS-1391: the mood sheet's Mood Override Filter — a per-genre top-share filter (mood.topShare, 1-99 or
// null=off) replacing CAS-1365's cross-genre minScore slider. oamMoodBarFor is the one chokepoint every
// mood-membership path (oamFilmMeetsMoodRules, and so Watch listing/counts/Where it lists/mood alerts) reads
// the applied bar through, so asserting it directly here covers all of them without re-deriving the
// pipeline. Replaces CAS-1365's cas1365-mood-minscore.test.mjs (minScore removed).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1391-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}

test("CAS-1391: with topShare null, oamMoodBarFor returns the agent's own bar unchanged", () => {
  const c = criteriaWith("Action", 55);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:null }, c, "Action"), 55);
});

test("CAS-1391: with topShare 40, oamMoodBarFor returns the higher of the agent's bar and oneBarForTopPct(style,40)", () => {
  const c = criteriaWith("Action", 55);
  const expected = Math.max(55, E.oneBarForTopPct("Action", 40));
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:40 }, c, "Action"), expected);
  // sanity: the filter only ever raises, never lowers — a low agent bar is overridden upward.
  assert.ok(expected > 55, "sanity: Top 40% must be pickier than this fixture's agent bar of 55");
});

test("CAS-1391: a style the agent has off (bar null) stays off regardless of topShare — a Never genre", () => {
  const c = criteriaWith("Action", null);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:40 }, c, "Action"), null);
});

test("CAS-1391: a legacy {id:'best', minScore:85} with no topShare behaves as topShare:20", () => {
  const c = criteriaWith("Action", 55);
  const legacy = E.oamMoodBarFor({ id:"best", minScore:85 }, c, "Action");
  const modern = E.oamMoodBarFor({ id:"best", topShare:20 }, c, "Action");
  assert.equal(legacy, modern, "a legacy minScore-only 'best' mood must read exactly as topShare:20 would");
  assert.equal(legacy, Math.max(55, E.oneBarForTopPct("Action", 20)));
});

test("CAS-1391: the legacy 'best' fallback never applies to any other mood id", () => {
  const c = criteriaWith("Action", 55);
  assert.equal(E.oamMoodBarFor({ id:"m1", minScore:85 }, c, "Action"), 55,
    "a non-'best' mood with an old minScore and no topShare must NOT get the legacy floor — it's off, like any other mood with topShare:null");
});

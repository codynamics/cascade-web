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

// CAS-1593: the Override filter (topShare) is retired — a list's own levels (mood.levels, falling back to its old
// topShare, then the agent's bar, then 25) are the bar. These assertions keep CAS-1391's original coverage on the
// new rules: the same oamMoodBarFor chokepoint, read through oneBarForTopPct.
test("CAS-1391 (CAS-1593): with no levels and no topShare, an ordinary list reads the agent's own bar's level", () => {
  const c = criteriaWith("Action", 55);
  const lvl = E.snapPct(E.oneTopPct("Action", 55));
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:null }, c, "Action"), E.oneBarForTopPct("Action", lvl));
});

test("CAS-1391 (CAS-1593): a retired topShare 40 snaps to the Top 50% stop when the list has no levels", () => {
  const c = criteriaWith("Action", 55);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:40 }, c, "Action"), E.oneBarForTopPct("Action", 50));
});

test("CAS-1391 (CAS-1593): a genre the agent has off still gets a bar in an ordinary list (25 by default); Latest and Best stays off", () => {
  const c = criteriaWith("Action", null);
  assert.equal(E.oamMoodBarFor({ id:"m1" }, c, "Action"), E.oneBarForTopPct("Action", 25));
  assert.equal(E.oamMoodBarFor({ id:"releases" }, c, "Action"), null);
});

test("CAS-1391 (CAS-1593): a legacy {id:'best', minScore:85} with no topShare reads like any other list — the minScore is ignored", () => {
  const c = criteriaWith("Action", 55);
  const legacy = E.oamMoodBarFor({ id:"best", minScore:85 }, c, "Action");
  assert.equal(legacy, E.oamMoodBarFor({ id:"m1" }, c, "Action"));
});

test("CAS-1391 (CAS-1593): a list's own level wins over its topShare and the agent's bar", () => {
  const c = criteriaWith("Action", 55);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:40, levels:{ Action:10 } }, c, "Action"), E.oneBarForTopPct("Action", 10));
});
